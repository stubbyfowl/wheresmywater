"""
build_site_data.py — Where's My Water

Turns the raw downloads in ./data (450MB+) into the handful of small static
JSON files the website actually loads in the browser (site/data/*.json).

The site is deployed on GitHub Pages, which can't run Python, so every
lookup happens client-side: the browser geocodes an address, then does
point-in-polygon against these files. That means no server to run or pay
for, but it also means these files ship to every visitor, so keep them
small (geometry is simplified and trimmed to the fields the UI uses).

Run fetch_data.py first, then:
    python build_site_data.py
"""

import json
import math
import os
import zipfile

import geopandas as gpd

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
OUT_DIR = os.path.join(os.path.dirname(__file__), "site", "data")
os.makedirs(OUT_DIR, exist_ok=True)

# Geometry simplification tolerance in degrees (~10m). Service-area and AMA
# boundaries are regulatory approximations at this zoom anyway; this cuts
# file size a lot without moving any boundary meaningfully.
SIMPLIFY_DEG = 0.0001

# EPA violation records go back decades. Anything from this year onward is
# reported separately as "recent" so an old, long-resolved problem isn't
# presented as a current warning.
RECENT_SINCE_YEAR = 2021


def write_geojson(gdf: gpd.GeoDataFrame, keep_cols: list[str], out_name: str,
                  simplify: float = SIMPLIFY_DEG):
    """Trim to the fields the UI uses, simplify geometry, write GeoJSON."""
    gdf = gdf.to_crs(epsg=4326).copy()

    # Statewide layers carry records with no geometry at all (113 of 959 in
    # the CWS layer). They can never match a point, so they're pure payload.
    before = len(gdf)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    dropped = before - len(gdf)

    present = [c for c in keep_cols if c in gdf.columns]
    gdf = gdf[present + ["geometry"]]
    gdf["geometry"] = gdf.geometry.simplify(simplify, preserve_topology=True)
    # Provider names in the CWS layer have stray leading/trailing whitespace.
    for c in present:
        if gdf[c].dtype == object:
            gdf[c] = gdf[c].astype(str).str.strip()
    path = os.path.join(OUT_DIR, out_name)
    if os.path.exists(path):
        os.remove(path)
    # 5 decimal places is ~1m: far more precision than a regulatory boundary
    # actually carries, and it roughly halves the file.
    gdf.to_file(path, driver="GeoJSON", COORDINATE_PRECISION=5)
    note = f", dropped {dropped} with no geometry" if dropped else ""
    print(f"  {out_name}: {len(gdf)} features{note}, {os.path.getsize(path):,} bytes")


def build_boundaries():
    print("Boundaries...")
    write_geojson(
        gpd.read_file(os.path.join(DATA_DIR, "ama_ina.geojson")),
        ["BASIN_NAME", "NAME_ABBR"],
        "ama_ina.json",
    )
    # ADEQ_ID is the PWSID (e.g. AZ0402327) -- the join key to EPA's
    # violation records, so it has to survive the trim.
    write_geojson(
        gpd.read_file(os.path.join(DATA_DIR, "_statewide_cws_service_areas.geojson")),
        ["CWS_NAME", "ADEQ_ID", "OWNER_NAME", "PHONE", "POPULATION", "COUNTY", "STATUS"],
        "cws.json",
    )
    # Statewide AAWS is 5,594 subdivision polygons. It only drives a
    # yes/no "is there a determination here" line in the collapsed context
    # panel, so it gets simplified harder (~20m) than the layers whose
    # answer a person acts on.
    write_geojson(
        gpd.read_file(os.path.join(DATA_DIR, "_statewide_aaws_determinations.geojson")),
        ["SUBDIVISION", "FILE_TYPE", "WATER_PROVIDER", "F100_YR", "FILESTATUS"],
        "aaws.json",
        simplify=0.0002,
    )


def build_violations():
    """
    Arizona drinking-water violations from EPA's ECHO SDWA bulk download.

    The zip is ~420MB of national data; we only need Arizona systems and
    only the fields that answer "has this provider had problems." Read the
    CSVs straight out of the zip so we never unpack the whole thing.
    """
    print("Violations...")
    import csv
    import io

    zip_path = os.path.join(DATA_DIR, "epa", "SDWA_latest_downloads.zip")
    if not os.path.exists(zip_path):
        print("  EPA zip not downloaded yet, skipping")
        return

    # A part-finished download is a valid file on disk but not a valid zip.
    # That's expected (it's 423MB over a slow server), so say so plainly
    # instead of taking the whole build down with a traceback.
    try:
        zipfile.ZipFile(zip_path).close()
    except zipfile.BadZipFile:
        have = os.path.getsize(zip_path) / 1e6
        print(f"  {zip_path} is incomplete ({have:.0f}MB so far), skipping.")
        print("  Resume it with: curl -C - -o data/epa/SDWA_latest_downloads.zip \\")
        print("    https://echo.epa.gov/files/echodownloads/SDWA_latest_downloads.zip")
        return

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        print(f"  zip contains {len(names)} files: {names[:12]}")
        # Name the tables exactly. Matching on "VIOLATION" alone also hits
        # SDWA_PN_VIOLATION_ASSOC.csv, which is the public-notification
        # linkage table, not the violations themselves -- counting that
        # silently reports the wrong numbers.
        def pick(*wanted):
            for w in wanted:
                for n in names:
                    if n.upper().endswith(w):
                        return n
            return None

        viol_name = pick("SDWA_VIOLATIONS_ENFORCEMENT.CSV")
        sys_name = pick("SDWA_PUB_WATER_SYSTEMS.CSV")
        if not viol_name or not sys_name:
            print(f"  could not find expected CSVs in zip: {names}")
            return
        print(f"  using {sys_name} + {viol_name}")

        systems = {}
        with z.open(sys_name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")):
                pwsid = (row.get("PWSID") or "").strip()
                if not pwsid.upper().startswith("AZ"):
                    continue
                # Deactivated systems still carry decades of history. Showing
                # that against a live address would be answering about a
                # utility that no longer exists.
                if (row.get("PWS_ACTIVITY_CODE") or "").strip().upper() != "A":
                    continue
                systems[pwsid] = {
                    "name": (row.get("PWS_NAME") or "").strip(),
                    "population": (row.get("POPULATION_SERVED_COUNT") or "").strip(),
                    "type": (row.get("PWS_TYPE_CODE") or "").strip(),
                    "violations": 0,
                    "health_based": 0,
                    "recent_5yr": 0,
                    "unresolved": 0,
                    "recent": [],
                }
        print(f"  {len(systems)} active Arizona water systems")

        # EPA's records run back to the 1980s. "12 violations on record" with
        # no timeframe reads as a live warning when it may all predate the
        # visitor's birth, so recency and open/closed status get counted
        # separately.
        with z.open(viol_name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")):
                s = systems.get((row.get("PWSID") or "").strip())
                if not s:
                    continue
                s["violations"] += 1
                began = (row.get("NON_COMPL_PER_BEGIN_DATE") or "").strip()
                year = int(began[-4:]) if len(began) >= 4 and began[-4:].isdigit() else None
                if year and year >= RECENT_SINCE_YEAR:
                    s["recent_5yr"] += 1
                status = (row.get("VIOLATION_STATUS") or "").strip()
                if status.lower() in ("unaddressed", "addressed"):
                    s["unresolved"] += 1
                if (row.get("IS_HEALTH_BASED_IND") or "").strip().upper() == "Y":
                    s["health_based"] += 1
                    if len(s["recent"]) < 5 and year and year >= RECENT_SINCE_YEAR:
                        s["recent"].append({
                            "contaminant": (row.get("CONTAMINANT_CODE") or "").strip(),
                            "type": (row.get("VIOLATION_CATEGORY_CODE") or "").strip(),
                            "began": began,
                            "status": status,
                        })

    path = os.path.join(OUT_DIR, "violations.json")
    with open(path, "w") as f:
        json.dump(systems, f)
    flagged = sum(1 for s in systems.values() if s["violations"])
    print(f"  violations.json: {len(systems)} systems ({flagged} with violations), {os.path.getsize(path):,} bytes")


def build_osm_water():
    """
    Publicly mapped water points across Arizona, from OpenStreetMap.

    This is the only statewide source of "somewhere to actually get water"
    that exists at all. It is NOT equivalent to the hand-curated directory
    and must never be presented as such: most of these are drinking
    fountains and campground taps, which are useless to someone whose 2,500
    gallon household tank is empty. They are worth showing because outside
    the curated communities the alternative is showing nothing, but the UI
    labels them as community-mapped and unverified.

    Licence: OpenStreetMap contributors, ODbL. Attribution is in the footer.
    """
    print("OSM water points...")
    import urllib.request
    import urllib.parse

    query = """
    [out:json][timeout:180];
    area["ISO3166-2"="US-AZ"][admin_level=4]->.az;
    (
      node["amenity"="drinking_water"](area.az);
      node["amenity"="water_point"](area.az);
      node["man_made"="water_tap"](area.az);
      node["shop"="water"](area.az);
    );
    out body;
    """
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "wheresmywater.org (sidaksmann@gmail.com)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=200) as r:
            payload = json.load(r)
    except Exception as e:
        print(f"  Overpass request failed ({e}), leaving existing file alone")
        return

    kinds = {
        "drinking_water": "Drinking water",
        "water_point": "Water filling point",
        "water_tap": "Water tap",
    }
    out = []
    for el in payload.get("elements", []):
        t = el.get("tags", {})
        kind = kinds.get(t.get("amenity") or t.get("man_made"))
        if t.get("shop") == "water":
            kind = "Water shop"
        out.append({
            "name": t.get("name") or kind or "Public water point",
            "kind": kind or "Water point",
            "lat": round(el["lat"], 5),
            "lon": round(el["lon"], 5),
            # Bulk-capable sources are the ones that matter for hauling, so
            # surface the tags that hint at it rather than hiding them.
            "bottle": t.get("drinking_water:refill") or t.get("bottle"),
            "fee": t.get("fee"),
            "operator": t.get("operator"),
            "seasonal": t.get("seasonal"),
        })
    out = [{k: v for k, v in o.items() if v is not None} for o in out]
    path = os.path.join(OUT_DIR, "osm_water.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"  osm_water.json: {len(out):,} points, {os.path.getsize(path):,} bytes")


def verify_outputs():
    """
    Every file we ship must survive a strict JSON parser.

    Python's json.dump happily writes NaN/Infinity, which JSON.parse rejects,
    so a single bad coordinate turns into a whole layer silently missing in
    the browser. That exact bug shipped once. Fail the build instead.
    """
    print("\nVerifying output is valid JSON...")
    bad = []
    for name in sorted(os.listdir(OUT_DIR)):
        path = os.path.join(OUT_DIR, name)
        with open(path) as f:
            text = f.read()
        try:
            json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
        except ValueError as e:
            bad.append(f"{name}: {e}")
    if bad:
        raise SystemExit("INVALID JSON, would break the site:\n  " + "\n  ".join(bad))
    print("  all files parse strictly")


def report_payload():
    """What a visitor actually downloads. Keep an eye on this."""
    print("\nPayload shipped to the browser:")
    import gzip
    total = totalgz = 0
    for name in sorted(os.listdir(OUT_DIR)):
        p = os.path.join(OUT_DIR, name)
        raw = os.path.getsize(p)
        with open(p, "rb") as f:
            gz = len(gzip.compress(f.read(), 6))
        total += raw
        totalgz += gz
        print(f"  {name:20} {raw/1024:8.0f} KB  ({gz/1024:6.0f} KB gzipped)")
    print(f"  {'TOTAL':20} {total/1024:8.0f} KB  ({totalgz/1024:6.0f} KB gzipped)")


if __name__ == "__main__":
    build_boundaries()
    build_osm_water()
    build_violations()
    verify_outputs()
    report_payload()
    print("\nDone -> site/data/")
