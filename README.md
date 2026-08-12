# Where's My Water

Type an Arizona address, find out where to actually get water.

**Live:** https://stubbyfowl.github.io/wheresmywater/

Most water tools tell you about policy. This one tries to answer the
question someone actually has when their tap situation is uncertain: *where
do I go, right now?* Results come in three tiers:

1. **Places to get water** — standpipes and haulers, hand-researched,
   because no government agency maintains this list anywhere.
2. **Your official provider** — and its EPA drinking-water violation
   record. If no provider serves your address, the site says so plainly;
   for places like Rio Verde Foothills that is the whole story.
3. **Regulatory context** — AMA status, nearby wells, 100-year supply
   determinations. Background, collapsed by default.

It currently covers **Rio Verde Foothills**, the unincorporated community
that Scottsdale cut off from hauled water on January 1, 2023.

## How it's built

The lookup runs **entirely in the browser**. There's no backend: the page
geocodes your address, then does point-in-polygon against small static
JSON files. That means no server to pay for, and your address is never
sent to us.

```
fetch_data.py       downloads raw ADWR data (~450MB) -> data/
build_site_data.py  trims it to what the browser needs -> site/data/
build_haulers.py    discovers candidate water haulers statewide -> site/data/haulers.json
site/               the actual website, deployed to GitHub Pages
app.py              optional FastAPI version of the lookup, for local use
```

## Finding water haulers statewide

Arizona has no registry of water haulers. Potable water hauling is
permitted vehicle-by-vehicle at the **county** level (Maricopa County
Environmental Health Code Ch. V §2, A.A.C. R18-4-125), and the county
portals don't publish those lists — Maricopa's public lookup exposes only
restaurants and swimming pools.

Haulers do, however, drive trucks, which means they register with FMCSA.
`build_haulers.py` queries the federal motor carrier census for Arizona
carriers whose names suggest water hauling: **74 candidates, 46 of them
high-confidence, across 36 cities.**

This is a *discovery* source, not a verified directory, and the difference
matters because someone may drive a long way on it:

- Name matching is a heuristic. "Winston Water Cooler" is a plumbing
  supplier; "Buckeye Water Conservation & Drainage District" is an
  irrigation district. Both contain "water", both are excluded.
- A registered carrier may no longer haul water, may only do construction
  water, or may not serve your area.
- Coordinates are **city centroids**, not service areas. A hauler 40 miles
  out may serve you; one 5 miles out may not.

So every record carries `needs_call: true` and a confidence rating, and
must be presented as a lead to call rather than a confirmed source.
`python build_haulers.py --check` runs the classifier's regression test.

## Running it

```bash
pip install -r requirements.txt
python fetch_data.py          # real ADWR data, takes a while
python build_site_data.py     # -> site/data/*.json
node site/test.mjs            # check the lookup geometry
cd site && python -m http.server 8080
```

The EPA violations layer needs a separate ~423MB download before
`build_site_data.py` can include it:

```bash
mkdir -p data/epa && curl -C - -o data/epa/SDWA_latest_downloads.zip \
  https://echo.epa.gov/files/echodownloads/SDWA_latest_downloads.zip
```

## Data sources

| Dataset | Access |
|---|---|
| AMA / INA boundaries | [ADWR ArcGIS FeatureServer](https://azwatermaps.azwater.gov/arcgis/rest/services/General/AMA_and_INA_2024/FeatureServer/0) |
| AAWS issued determinations | AZGeo Open Data Hub `.geojson` |
| Community Water System service areas | AZGeo Open Data Hub `.geojson` |
| GWSI well registry | [Direct zip](https://www.azwater.gov/gis-data-and-maps) |
| Land subsidence | [Direct zip](https://www.azwater.gov/gis-data-and-maps) |
| Drinking-water violations | [EPA ECHO SDWA bulk download](https://echo.epa.gov/tools/data-downloads/sdwa-download-summary) |
| Geocoding | U.S. Census Bureau geocoder |

The two direct zips carry dates in their filenames and go stale; get
current links from [azwater.gov/gis-data-and-maps](https://www.azwater.gov/gis-data-and-maps).

## Things that will bite you

- **AZGeo Hub downloads are asynchronous.** The first request returns a
  small `{"status":"InProgress"}` blob, not data. `fetch_data.py` polls.
- **The Hub ignores `outSR` for some layers** and serves EPSG:26912
  regardless. Clipping those with a lat/lon bbox silently yields *zero*
  features rather than an error. Always reproject before clipping.
- **The Census geocoder sends no CORS header**, so browser `fetch()` is
  blocked. The site uses JSONP.
- **GWSI ships a shapefile**, not CSVs, at `Shape/GWSI_SITES.shp`.
- **GWSI is not Wells55.** GWSI is the monitoring index; it undercounts
  actual drilled wells badly. The displayed well count is a floor.

## Caveats

This is an independent project, not a government service and not
affiliated with any utility. Directory entries show where each detail came
from and when it was checked; entries not yet confirmed by phone say so.
Always call before driving out.
