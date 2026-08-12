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


def write_geojson(gdf: gpd.GeoDataFrame, keep_cols: list[str], out_name: str):
    """Trim to the fields the UI uses, simplify geometry, write GeoJSON."""
    gdf = gdf.to_crs(epsg=4326).copy()
    present = [c for c in keep_cols if c in gdf.columns]
    gdf = gdf[present + ["geometry"]]
    gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True)
    # Provider names in the CWS layer have stray leading/trailing whitespace.
    for c in present:
        if gdf[c].dtype == object:
            gdf[c] = gdf[c].astype(str).str.strip()
    path = os.path.join(OUT_DIR, out_name)
    if os.path.exists(path):
        os.remove(path)
    gdf.to_file(path, driver="GeoJSON")
    print(f"  {out_name}: {len(gdf)} features, {os.path.getsize(path):,} bytes")


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
    write_geojson(
        gpd.read_file(os.path.join(DATA_DIR, "aaws_determinations.geojson")),
        ["SUBDIVISION", "FILE_TYPE", "WATER_PROVIDER", "F100_YR", "FILESTATUS"],
        "aaws.json",
    )


def build_wells():
    """
    Well points near the launch area only. The statewide GWSI export is
    46,890 sites; the site only needs enough to answer "how many wells are
    near this address," so clip to the launch bbox before shipping.
    """
    print("Wells...")
    import glob

    shp = glob.glob(os.path.join(DATA_DIR, "gwsi_wells", "**", "GWSI_SITES.shp"), recursive=True)
    if not shp:
        print("  no GWSI shapefile found, skipping")
        return
    w = gpd.read_file(shp[0]).to_crs(epsg=4326)
    w = w.cx[-111.9:-111.4, 33.6:33.95]
    out = [
        {"lat": round(geom.y, 5), "lon": round(geom.x, 5)}
        for geom in w.geometry
        if geom is not None and not geom.is_empty
    ]
    path = os.path.join(OUT_DIR, "wells.json")
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"  wells.json: {len(out)} wells, {os.path.getsize(path):,} bytes")


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

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        print(f"  zip contains {len(names)} files: {names[:12]}")
        viol_name = next((n for n in names if "VIOLATION" in n.upper() and n.upper().endswith(".CSV")), None)
        sys_name = next((n for n in names if "SYSTEM" in n.upper() and n.upper().endswith(".CSV")), None)
        if not viol_name or not sys_name:
            print("  could not find expected CSVs in zip")
            return
        print(f"  using {sys_name} + {viol_name}")

        systems = {}
        with z.open(sys_name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")):
                pwsid = (row.get("PWSID") or "").strip()
                if not pwsid.upper().startswith("AZ"):
                    continue
                systems[pwsid] = {
                    "name": (row.get("PWS_NAME") or "").strip(),
                    "population": (row.get("POPULATION_SERVED_COUNT") or "").strip(),
                    "violations": 0,
                    "health_based": 0,
                    "recent": [],
                }
        print(f"  {len(systems)} Arizona water systems")

        with z.open(viol_name) as fh:
            for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")):
                s = systems.get((row.get("PWSID") or "").strip())
                if not s:
                    continue
                s["violations"] += 1
                health = (row.get("IS_HEALTH_BASED_IND") or "").strip().upper() == "Y"
                if health:
                    s["health_based"] += 1
                    if len(s["recent"]) < 5:
                        s["recent"].append({
                            "contaminant": (row.get("CONTAMINANT_CODE") or "").strip(),
                            "type": (row.get("VIOLATION_CATEGORY_CODE") or "").strip(),
                            "began": (row.get("NON_COMPL_PER_BEGIN_DATE") or "").strip(),
                            "status": (row.get("VIOLATION_STATUS") or "").strip(),
                        })

    path = os.path.join(OUT_DIR, "violations.json")
    with open(path, "w") as f:
        json.dump(systems, f)
    flagged = sum(1 for s in systems.values() if s["violations"])
    print(f"  violations.json: {len(systems)} systems ({flagged} with violations), {os.path.getsize(path):,} bytes")


if __name__ == "__main__":
    build_boundaries()
    build_wells()
    build_violations()
    print("\nDone -> site/data/")
