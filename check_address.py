"""
check_address.py — Where's My Water AZ

Core lookup logic: given a street address, geocode it (free Census
geocoder, no API key needed) and run point-in-polygon / nearest-neighbor
checks against the ADWR layers fetched by fetch_data.py.

Run fetch_data.py first so ./data has the local GeoJSON files.

Usage:
    python check_address.py "28900 N Pinnacle Ranch Rd, Rio Verde, AZ 85263"
"""

import os
import sys

import geopandas as gpd
import requests
from shapely.geometry import Point

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

# How far (in miles) around the point to look for registered wells when
# reporting "nearby well density." 1 mile is a reasonable starting radius
# for rural residential lots; revisit once you've validated against known
# addresses.
NEARBY_WELL_RADIUS_MILES = 1.0
METERS_PER_MILE = 1609.34


def geocode_address(address: str) -> tuple[float, float]:
    """
    Geocode a US address using the free Census Bureau geocoder.
    Returns (longitude, latitude) in WGS84 (EPSG:4326).
    Raises ValueError if the address can't be matched.
    """
    params = {
        "address": address,
        "benchmark": "Public_AR_Current",
        "format": "json",
    }
    r = requests.get(CENSUS_GEOCODER_URL, params=params, timeout=20)
    r.raise_for_status()
    matches = r.json()["result"]["addressMatches"]
    if not matches:
        raise ValueError(f"Could not geocode address: {address!r}")
    coords = matches[0]["coordinates"]
    return coords["x"], coords["y"]  # (lon, lat)


def load_layers():
    """Load the locally cached GeoJSON layers produced by fetch_data.py."""
    layers = {}
    paths = {
        "ama_ina": "ama_ina.geojson",
        "aaws": "aaws_determinations.geojson",
        "cws": "cws_service_areas.geojson",
    }
    for key, fname in paths.items():
        path = os.path.join(DATA_DIR, fname)
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Missing {path}. Run `python fetch_data.py` first to download ADWR data."
            )
        layers[key] = gpd.read_file(path).to_crs(epsg=4326)
    return layers


def load_wells():
    """
    Load the GWSI well points extracted by fetch_data.py.

    Verified against the real 2026-07-14 GWSI export: the zip ships a proper
    point shapefile at Shape/GWSI_SITES.shp (46,890 sites, EPSG:26912) with
    DD_LAT/DD_LONG columns. Older exports shipped loose tables instead, so
    fall back to scanning CSV/TXT for lat/lon columns if the shapefile isn't
    there. Returns None if neither is present, so the rest of the app still
    works with nearby_well_count omitted.
    """
    import glob

    gwsi_dir = os.path.join(DATA_DIR, "gwsi_wells")
    if not os.path.isdir(gwsi_dir):
        return None

    shp = glob.glob(os.path.join(gwsi_dir, "**", "GWSI_SITES.shp"), recursive=True)
    if shp:
        return gpd.read_file(shp[0]).to_crs(epsg=4326)

    for path in glob.glob(os.path.join(gwsi_dir, "**", "*.csv"), recursive=True) + glob.glob(
        os.path.join(gwsi_dir, "**", "*.txt"), recursive=True
    ):
        try:
            import pandas as pd

            df = pd.read_csv(path, low_memory=False)
            lat_col = next((c for c in df.columns if c.upper() in ("LATITUDE", "LAT", "DD_LAT")), None)
            lon_col = next((c for c in df.columns if c.upper() in ("LONGITUDE", "LON", "LONG", "DD_LONG")), None)
            if lat_col and lon_col:
                df = df.dropna(subset=[lat_col, lon_col])
                return gpd.GeoDataFrame(
                    df,
                    geometry=gpd.points_from_xy(df[lon_col], df[lat_col]),
                    crs="EPSG:4326",
                )
        except Exception:
            continue
    return None


def check_address(address: str, layers: dict | None = None, wells: gpd.GeoDataFrame | None = None) -> dict:
    """
    The core product logic: given a raw address string, return a plain-
    English-ready result dict with everything the site needs to render.
    """
    if layers is None:
        layers = load_layers()
    if wells is None:
        wells = load_wells()

    lon, lat = geocode_address(address)
    point = Point(lon, lat)
    point_gdf = gpd.GeoDataFrame({"id": [0]}, geometry=[point], crs="EPSG:4326")

    result = {
        "address": address,
        "matched_coordinates": {"lon": lon, "lat": lat},
        "in_ama_or_ina": False,
        "ama_ina_name": None,
        "has_aaws_determination": False,
        "aaws_details": None,
        "in_cws_service_area": False,
        "cws_provider_name": None,
        "nearby_well_count": None,
    }

    # AMA/INA: point-in-polygon
    ama_hit = gpd.sjoin(point_gdf, layers["ama_ina"], how="left", predicate="within")
    if not ama_hit.empty and ama_hit.iloc[0].get("index_right") == ama_hit.iloc[0].get("index_right"):
        name_col = next((c for c in layers["ama_ina"].columns if "NAME" in c.upper()), None)
        if name_col and not ama_hit.empty and name_col in ama_hit.columns:
            name_val = ama_hit.iloc[0].get(name_col)
            if name_val is not None and str(name_val) != "nan":
                result["in_ama_or_ina"] = True
                result["ama_ina_name"] = name_val

    # AAWS: point-in-polygon (determination areas are usually subdivision-level)
    aaws_hit = gpd.sjoin(point_gdf, layers["aaws"], how="left", predicate="within")
    if not aaws_hit.empty and "index_right" in aaws_hit.columns and aaws_hit.iloc[0]["index_right"] == aaws_hit.iloc[0]["index_right"]:
        result["has_aaws_determination"] = True
        result["aaws_details"] = {
            col: aaws_hit.iloc[0][col]
            for col in aaws_hit.columns
            if col not in ("geometry", "index_right", "id")
        }

    # Community Water System: point-in-polygon
    cws_hit = gpd.sjoin(point_gdf, layers["cws"], how="left", predicate="within")
    if not cws_hit.empty and "index_right" in cws_hit.columns and cws_hit.iloc[0]["index_right"] == cws_hit.iloc[0]["index_right"]:
        name_col = next((c for c in layers["cws"].columns if "NAME" in c.upper()), None)
        if name_col and name_col in cws_hit.columns:
            provider = cws_hit.iloc[0].get(name_col)
            if provider is not None and str(provider) != "nan":
                result["in_cws_service_area"] = True
                result["cws_provider_name"] = provider

    # Nearby wells: distance query within NEARBY_WELL_RADIUS_MILES
    if wells is not None and not wells.empty:
        # project to a metric CRS (Arizona uses EPSG:26912, UTM zone 12N) for
        # accurate distance math, then buffer and count.
        point_utm = point_gdf.to_crs(epsg=26912)
        wells_utm = wells.to_crs(epsg=26912)
        buffer_geom = point_utm.geometry.iloc[0].buffer(NEARBY_WELL_RADIUS_MILES * METERS_PER_MILE)
        nearby = wells_utm[wells_utm.geometry.within(buffer_geom)]
        result["nearby_well_count"] = int(len(nearby))

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print('Usage: python check_address.py "<address>"')
        sys.exit(1)

    address = " ".join(sys.argv[1:])
    result = check_address(address)
    import json

    print(json.dumps(result, indent=2, default=str))
