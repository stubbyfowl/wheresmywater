"""
fetch_data.py — Where's My Water AZ

Downloads / queries ADWR's real, public GIS datasets and saves local copies
scoped to the v1 launch area (Rio Verde Foothills + surrounding rural
Maricopa County, per the playbook's "narrow launch geography" step).

All five source URLs below were verified live on 2026-07-27 by querying
ADWR's own ArcGIS REST catalog and Open Data Hub directly:

  https://azwatermaps.azwater.gov/arcgis/rest/services  (ADWR's ArcGIS Server)
  https://azgeo-open-data-agic.hub.arcgis.com            (AZGeo Open Data Hub)
  https://www.azwater.gov/gis-data-and-maps              (ADWR GIS Data page)

Run:
    pip install -r requirements.txt
    python fetch_data.py

Output: writes GeoJSON files into ./data/
"""

import io
import os
import time
import zipfile

import geopandas as gpd
import requests

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

# All of Arizona. v1 clipped to a Rio Verde Foothills box; the site now
# answers for any Arizona address, so the pipeline pulls the whole state.
# Padded slightly beyond the state's real extent (-114.82/-109.04,
# 31.33/37.00) so boundary-hugging features aren't trimmed.
BBOX = {
    "minx": -115.0,
    "miny": 31.2,
    "maxx": -109.0,
    "maxy": 37.1,
}
BBOX_WKID = 4326

HEADERS = {"User-Agent": "wheresmywateraz.org data pipeline (contact: sidaksmann@gmail.com)"}


def fetch_arcgis_geojson(base_url: str, layer: int, bbox: dict, out_file: str, where: str = "1=1"):
    """Query an ArcGIS FeatureServer layer, clipped to bbox, save as GeoJSON."""
    query_url = f"{base_url}/{layer}/query"
    params = {
        "where": where,
        "outFields": "*",
        "geometry": f"{bbox['minx']},{bbox['miny']},{bbox['maxx']},{bbox['maxy']}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": BBOX_WKID,
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": BBOX_WKID,
        "f": "geojson",
    }
    print(f"Fetching {out_file} from {query_url} ...")
    r = requests.get(query_url, params=params, headers=HEADERS, timeout=60)
    r.raise_for_status()
    out_path = os.path.join(DATA_DIR, out_file)
    with open(out_path, "wb") as f:
        f.write(r.content)
    print(f"  saved {out_path} ({len(r.content):,} bytes)")
    return out_path


def fetch_opendata_geojson(dataset_slug: str, out_file: str, max_wait: int = 900):
    """
    Download a full dataset from ADWR's AZGeo Open Data Hub as GeoJSON.
    These are statewide extracts (no bbox filter available on this endpoint),
    so we clip locally after download.

    The Hub generates these extracts asynchronously: the first request
    returns a small JSON status blob ({"status": "InProgress", ...}) instead
    of the data, and only serves real GeoJSON once generation finishes.
    Poll until we actually get a FeatureCollection.
    """
    url = f"https://gisdata2016-11-18t150447874z-azwater.opendata.arcgis.com/datasets/{dataset_slug}.geojson"
    print(f"Fetching {out_file} from {url} ...")

    deadline = time.time() + max_wait
    while True:
        r = requests.get(url, params={"where": "1=1", "outSR": "4326"}, headers=HEADERS, timeout=180)
        r.raise_for_status()
        if b'"FeatureCollection"' in r.content[:2000]:
            break
        status = r.content[:200].decode("utf-8", "replace")
        if time.time() >= deadline:
            raise RuntimeError(
                f"AZGeo Hub never finished generating {dataset_slug} within {max_wait}s. "
                f"Last response: {status}"
            )
        print(f"  hub still generating, retrying in 15s... ({status})")
        time.sleep(15)

    out_path = os.path.join(DATA_DIR, f"_statewide_{out_file}")
    with open(out_path, "wb") as f:
        f.write(r.content)
    print(f"  saved {out_path} ({len(r.content):,} bytes), clipping to bbox...")

    gdf = gpd.read_file(out_path)
    # The Hub ignores outSR for some layers and serves UTM (EPSG:26912)
    # regardless -- clipping those with a lat/lon bbox silently yields zero
    # features, so always reproject before the clip.
    if gdf.crs is not None and gdf.crs.to_epsg() != BBOX_WKID:
        print(f"  reprojecting {gdf.crs.to_string()} -> EPSG:{BBOX_WKID} before clip")
        gdf = gdf.to_crs(epsg=BBOX_WKID)
    clipped = gdf.cx[BBOX["minx"]:BBOX["maxx"], BBOX["miny"]:BBOX["maxy"]]
    clipped_path = os.path.join(DATA_DIR, out_file)
    clipped.to_file(clipped_path, driver="GeoJSON")
    print(f"  clipped to {len(clipped)} features -> {clipped_path}")
    return clipped_path


def fetch_zip_and_extract(url: str, out_subdir: str):
    """Download an ADWR tabular/GIS zip and extract it."""
    print(f"Fetching zip from {url} ...")
    r = requests.get(url, headers=HEADERS, timeout=180)
    r.raise_for_status()
    out_dir = os.path.join(DATA_DIR, out_subdir)
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        z.extractall(out_dir)
    print(f"  extracted to {out_dir}")
    return out_dir


def main():
    # 1. AMA / INA boundaries -- ADWR's own ArcGIS Server, confirmed live.
    #    Layer 0 = AMA_and_INA polygons.
    fetch_arcgis_geojson(
        base_url="https://azwatermaps.azwater.gov/arcgis/rest/services/General/AMA_and_INA_2024/FeatureServer",
        layer=0,
        bbox=BBOX,
        out_file="ama_ina.geojson",
    )

    # 2. AAWS Issued Determinations -- AZGeo Open Data Hub.
    fetch_opendata_geojson(
        dataset_slug="azwater::aaws-issued-determination-2024",
        out_file="aaws_determinations.geojson",
    )

    # 3. Community Water System service areas -- AZGeo Open Data Hub.
    fetch_opendata_geojson(
        dataset_slug="azwater::cws-service-area-1",
        out_file="cws_service_areas.geojson",
    )

    # 4. GWSI well registry -- direct tabular/GIS zip from azwater.gov.
    #    NOTE: this URL includes a date stamp and ADWR updates it periodically
    #    (current as of 2026-07-14); check https://www.azwater.gov/gis-data-and-maps
    #    for the latest link if this 404s in the future.
    fetch_zip_and_extract(
        url="https://www.azwater.gov/sites/default/files/zip/GWSI_ZIP_20260714.zip",
        out_subdir="gwsi_wells",
    )

    # 5. InSAR land subsidence areas -- direct GIS zip from azwater.gov.
    #    Current as of 2026-05-26; same caveat as above if the link goes stale.
    fetch_zip_and_extract(
        url="https://www.azwater.gov/sites/default/files/zip/ArizonaActiveLandSubsidenceAreas_05-2026.zip",
        out_subdir="land_subsidence",
    )

    print("\nDone. All five datasets are in ./data, clipped to the Rio Verde Foothills v1 bbox where applicable.")
    print("Next: run check_address.py to test a spatial lookup, or app.py to serve the API.")


if __name__ == "__main__":
    main()
