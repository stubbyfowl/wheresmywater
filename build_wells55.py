"""
build_wells55.py — Where's My Water

Builds the statewide wells layer from BOTH Arizona well datasets:

  Wells55  ADWR's well *registration* database. Every well drilled in
           Arizona must be registered, including exempt domestic wells.
           ~218,000 records. This is the "who is pulling from this aquifer"
           list, and it's what people mean by "wells near me".

  GWSI     ADWR's Groundwater Site Inventory: ~46,800 sites where water
           levels are physically measured. A monitoring network, not a
           census. It undercounts real wells roughly ninefold, but it
           contributes measured sites and depths worth keeping.

Using only GWSI (the old behaviour) reported 3 wells within a mile of a
Rio Verde Foothills address where Wells55 knows about 27.

Output is TILED, not one file. 218k wells is ~4.5MB, which is not something
to hand a phone on rural cell service. The state is cut into 0.5 degree
cells and the browser fetches only the few tiles around the address.

    python build_wells55.py            # build tiles
    python build_wells55.py --check    # self-check, no network
"""

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

OUT_DIR = os.path.join(os.path.dirname(__file__), "site", "data", "wells")

# Public mirror of ADWR's Wells55 registry (Arizona Association of
# Conservation Districts). ADWR's own ArcGIS "Wells" folder is published but
# empty, and the AVCA copy of this layer requires a login, so this is the
# open route. Verify currency before leaning on it for anything official.
WELLS55 = (
    "https://maps2.timmons.com/arcgis/rest/services/"
    "AACD/AACD_Vector_Services/MapServer/55"
)
PAGE = 2000  # service maxRecordCount

# Arizona, padded.
AZ = (-115.0, 31.2, -109.0, 37.1)
TILE = 0.5  # degrees

HEADERS = {"User-Agent": "wheresmywater.org (sidaksmann@gmail.com)"}


def tile_key(lat: float, lon: float) -> str:
    """Which tile a point belongs to. Must match the JS implementation."""
    return f"{math.floor(lat / TILE)}_{math.floor(lon / TILE)}"


def _get(url: str, params: dict, retries: int = 4):
    q = urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f"{url}?{q}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
            print(f"    retry {attempt + 1} after {type(e).__name__}")


def count_in(bbox) -> int:
    d = _get(
        f"{WELLS55}/query",
        {
            "where": "1=1",
            "geometry": ",".join(str(v) for v in bbox),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "returnCountOnly": "true",
            "f": "json",
        },
    )
    return d.get("count", 0)


def fetch_bbox(bbox, depth=0):
    """
    Fetch every well in a bbox, subdividing when the service would truncate.

    The layer caps a response at 2,000 features and silently returns only
    that many, so asking for a dense area without splitting it loses wells
    with no error at all. Recursion is the fix.
    """
    n = count_in(bbox)
    if n == 0:
        return []
    if n > PAGE and depth < 8:
        minx, miny, maxx, maxy = bbox
        mx, my = (minx + maxx) / 2, (miny + maxy) / 2
        out = []
        for quad in (
            (minx, miny, mx, my),
            (mx, miny, maxx, my),
            (minx, my, mx, maxy),
            (mx, my, maxx, maxy),
        ):
            out.extend(fetch_bbox(quad, depth + 1))
        return out

    d = _get(
        f"{WELLS55}/query",
        {
            "where": "1=1",
            "geometry": ",".join(str(v) for v in bbox),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "outSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "WELL_DEPTH,INSTALLED",
            "returnGeometry": "true",
            "f": "json",
        },
    )
    rows = []
    for f in d.get("features", []):
        g = f.get("geometry") or {}
        x, y = g.get("x"), g.get("y")
        if x is None or y is None or not math.isfinite(x) or not math.isfinite(y):
            continue
        a = f.get("attributes", {})
        # INSTALLED is epoch milliseconds; keep just the year, which is all
        # the UI shows and a fraction of the bytes.
        yr = a.get("INSTALLED")
        try:
            yr = time.gmtime(yr / 1000).tm_year if yr else None
        except (OverflowError, OSError, ValueError):
            yr = None
        d_ft = a.get("WELL_DEPTH")
        rows.append([
            round(y, 5),
            round(x, 5),
            int(d_ft) if isinstance(d_ft, (int, float)) and 0 < d_ft < 20000 else None,
            yr if yr and 1850 < yr < 2100 else None,
        ])
    return rows


def load_gwsi():
    """GWSI monitoring sites, so the layer keeps the measured network too."""
    import glob

    try:
        import geopandas as gpd
    except ImportError:
        print("  geopandas unavailable, skipping GWSI")
        return []
    shp = glob.glob(
        os.path.join(os.path.dirname(__file__), "data", "gwsi_wells", "**", "GWSI_SITES.shp"),
        recursive=True,
    )
    if not shp:
        print("  no GWSI shapefile on disk, skipping (run fetch_data.py)")
        return []
    w = gpd.read_file(shp[0]).to_crs(epsg=4326)
    depths = w["WELL_DEPTH"] if "WELL_DEPTH" in w.columns else [None] * len(w)
    out = []
    for geom, d_ft in zip(w.geometry, depths):
        if geom is None or geom.is_empty:
            continue
        if not (math.isfinite(geom.x) and math.isfinite(geom.y)):
            continue
        out.append([
            round(geom.y, 5),
            round(geom.x, 5),
            int(d_ft) if isinstance(d_ft, (int, float)) and 0 < d_ft < 20000 else None,
            None,
        ])
    return out


SAME_WELL_M = 60  # metres; below this, treat two records as one hole


def merge(wells55, gwsi, same_m: float = SAME_WELL_M):
    """
    Combine the two datasets without double-counting the same physical hole.

    Two constraints pull against each other:

    - Wells55 rows are NEVER deduplicated against each other. It's the
      registration database; two wells on one parcel legitimately sit metres
      apart, and collapsing them undercounts exactly the dense rural areas
      this site exists for. (Doing so cost 3 of 27 wells at the Rio Verde
      test address.)
    - A GWSI monitoring site is almost always ALSO a registered well, so it
      must not be added again. Exact coordinate matching fails here: the two
      datasets derive positions differently, and matching at ~11m found only
      110 of 46,824 GWSI sites. Proximity matching is required.

    So: keep all of Wells55, and add a GWSI site only when no registered well
    sits within `same_m` metres of it. Bucketing by ~111m cells keeps this
    linear instead of 46k x 218k.
    """
    deg = 0.001  # ~111m cells
    buckets = {}
    for r in wells55:
        buckets.setdefault((int(r[0] / deg), int(r[1] / deg)), []).append(r)

    def has_neighbour(lat, lon):
        bi, bj = int(lat / deg), int(lon / deg)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for w in buckets.get((bi + di, bj + dj), ()):
                    # equirectangular is plenty at this scale
                    dy = (w[0] - lat) * 111_320
                    dx = (w[1] - lon) * 111_320 * math.cos(math.radians(lat))
                    if dy * dy + dx * dx <= same_m * same_m:
                        return True
        return False

    out = list(wells55)
    for r in gwsi:
        if not has_neighbour(r[0], r[1]):
            out.append(r)
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # The statewide pull is ~1,000 requests and takes minutes. Cache the raw
    # rows (gitignored, under data/) so re-merging or re-tiling is instant.
    cache = os.path.join(os.path.dirname(__file__), "data", "wells55_raw.json")
    if os.path.exists(cache) and "--refetch" not in sys.argv:
        with open(cache) as f:
            rows = json.load(f)
        print(f"Using cached Wells55 pull: {len(rows):,} rows ({cache})")
        print("  pass --refetch to pull again")
    else:
        print(f"Wells55 statewide (tiles of {TILE} degrees)...")
        print(f"  service reports {count_in(AZ):,} wells in the Arizona bbox")
        rows = []
        minx, miny, maxx, maxy = AZ
        cols = int(round((maxx - minx) / TILE))
        n_rows = int(round((maxy - miny) / TILE))
        for i in range(n_rows):
            for j in range(cols):
                b = (minx + j * TILE, miny + i * TILE, minx + (j + 1) * TILE, miny + (i + 1) * TILE)
                got = fetch_bbox(b)
                if got:
                    rows.extend(got)
                    print(f"  [{i:2d},{j:2d}] {len(got):>6,}   running total {len(rows):>7,}")
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "w") as f:
            json.dump(rows, f, separators=(",", ":"))

    print(f"\nWells55 rows: {len(rows):,}")
    gwsi = load_gwsi()
    print(f"GWSI rows:    {len(gwsi):,}")
    merged = merge(rows, gwsi)
    print(f"After merge:  {len(merged):,} ({len(merged) - len(rows):,} GWSI sites not already registered)")

    tiles = {}
    for r in merged:
        tiles.setdefault(tile_key(r[0], r[1]), []).append(r)

    for name in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, name))
    for key, rs in tiles.items():
        with open(os.path.join(OUT_DIR, f"{key}.json"), "w") as f:
            json.dump(rs, f, separators=(",", ":"))

    sizes = [os.path.getsize(os.path.join(OUT_DIR, n)) for n in os.listdir(OUT_DIR)]
    print(f"\n{len(tiles)} tiles, largest {max(sizes):,} bytes, total {sum(sizes):,} bytes")
    with open(os.path.join(os.path.dirname(OUT_DIR), "wells_index.json"), "w") as f:
        json.dump({"tile": TILE, "count": len(merged), "tiles": sorted(tiles)}, f)
    print("wrote wells_index.json")


def check():
    """Self-check: tiling and dedup, no network."""
    assert tile_key(33.7415, -111.709) == "67_-224", tile_key(33.7415, -111.709)
    assert tile_key(33.9999, -111.709) == "67_-224"
    assert tile_key(34.0001, -111.709) == "68_-224", "crossing a tile edge moves tiles"
    # a GWSI site sitting on a registered well is dropped as a duplicate
    w55 = [[33.74150, -111.70900, 250, 1998]]
    assert len(merge(w55, [[33.74151, -111.70901, None, None]])) == 1
    # ...and still dropped when the two datasets disagree by tens of metres,
    # which is the normal case and the reason exact matching failed
    assert len(merge(w55, [[33.74180, -111.70930, None, None]])) == 1, "~40m apart is one well"
    # a GWSI site with no Wells55 counterpart is kept
    assert len(merge(w55, [[33.90000, -111.70900, None, None]])) == 2
    # two registered wells metres apart are BOTH real: never collapse Wells55
    close = [[33.74150, -111.70900, 250, 1998], [33.741505, -111.709005, 310, 2004]]
    assert len(merge(close, [])) == 2, "Wells55 rows must not be deduped against each other"
    # a GWSI site just beyond the threshold is a different hole
    assert len(merge(w55, [[33.74300, -111.70900, None, None]])) == 2, "~170m apart is two wells"
    print("build_wells55 self-check passed")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
