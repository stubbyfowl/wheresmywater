# Where's My Water AZ — data pipeline

Real, working ADWR data sources for the v1 lookup (Rio Verde Foothills area),
verified live on 2026-07-27 by querying ADWR's ArcGIS REST catalog directly.

## Verified sources

| Dataset | Access method | URL |
|---|---|---|
| AMA / INA boundaries | Live ArcGIS FeatureServer query (point-in-polygon) | `https://azwatermaps.azwater.gov/arcgis/rest/services/General/AMA_and_INA_2024/FeatureServer/0` |
| AAWS Issued Determinations | AZGeo Open Data Hub, `.geojson` download | `https://gisdata2016-11-18t150447874z-azwater.opendata.arcgis.com/datasets/azwater::aaws-issued-determination-2024.geojson` |
| Community Water System service areas | AZGeo Open Data Hub, `.geojson` download | `https://gisdata2016-11-18t150447874z-azwater.opendata.arcgis.com/datasets/azwater::cws-service-area-1.geojson` |
| GWSI well registry (Wells55) | Direct zip from azwater.gov | `https://www.azwater.gov/sites/default/files/zip/GWSI_ZIP_20260714.zip` |
| InSAR land subsidence | Direct zip from azwater.gov | `https://www.azwater.gov/sites/default/files/zip/ArizonaActiveLandSubsidenceAreas_05-2026.zip` |

The last two are dated in their filename and ADWR refreshes them periodically —
if a link 404s later, get the current one from
[azwater.gov/gis-data-and-maps](https://www.azwater.gov/gis-data-and-maps).

There's also a live ADWR public records request web form at
`https://app.azwater.gov/eforms/Forms/Request/DWR_Request.aspx`, separate from
the emailed A.R.S. § 39-121 request — worth using as a second channel if the
emailed request stalls.

## Files

- `fetch_data.py` — downloads/queries all five datasets, clipped to a Rio
  Verde Foothills bounding box, saves to `./data/`.
- `check_address.py` — the core product logic. Geocodes an address with the
  free Census Bureau geocoder (no API key needed), then runs point-in-polygon
  checks against AMA/INA, AAWS, and CWS layers, plus a nearby-well count from
  GWSI. Run directly for a CLI test: `python check_address.py "<address>"`.
- `app.py` — minimal FastAPI backend exposing `GET /check?address=...`. This
  is what `script.js`'s `mockLookup()` should call once deployed, instead of
  generating fake data.
- `requirements.txt` — no GDAL/fiona dependency; uses `pyogrio` as the
  geopandas I/O engine so it installs cleanly with plain `pip install`.

## Running it

```bash
pip install -r requirements.txt
python fetch_data.py          # pulls real ADWR data into ./data
python check_address.py "28900 N Pinnacle Ranch Rd, Rio Verde, AZ 85263"
uvicorn app:app --reload      # serve the API locally
```

## What's not done yet

- **GWSI well loading is best-effort.** The GWSI zip ships as a set of
  tables, and the exact column layout can vary by export. `load_wells()` in
  `check_address.py` looks for a CSV/TXT with `LATITUDE`/`LONGITUDE` columns
  and builds points from it — check the actual extracted files in
  `./data/gwsi_wells/` after running `fetch_data.py` once and adjust the
  column-matching logic if needed.
- **Validation against known addresses** (playbook Step 3's last step):
  before trusting this, manually cross-check ~10-15 known Rio Verde
  Foothills addresses against ADWR's own AAWS interactive map
  (`https://azwatermaps.azwater.gov/aaws`) and the AMA map to confirm the
  automated results match.
- **Not executed end-to-end here.** This sandbox's outbound network is
  locked to package registries only (no live access to azwater.gov or
  Census.gov), so this was built and syntax/import-checked but not run
  against live data. Run it from your own machine, or from Claude Code once
  the GitHub integration is wired up, to pull real data and validate output.
