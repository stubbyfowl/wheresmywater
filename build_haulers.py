"""
build_haulers.py — Where's My Water

Statewide water hauler discovery.

There is no Arizona registry of water haulers. Potable water hauling is
permitted vehicle-by-vehicle at the *county* level (Maricopa County
Environmental Health Code Ch. V Sec. 2, A.A.C. R18-4-125), and the county
portals don't publish those permit lists -- Maricopa's public lookup only
exposes restaurants and swimming pools. So a statewide list can't simply be
downloaded from the agency that licenses them.

What *is* public: haulers drive trucks, so they register with FMCSA as
motor carriers. The federal motor carrier census is free, queryable, and
carries a business name, city, phone number and USDOT number. That makes it
a workable **discovery** source: it finds candidate haulers everywhere in
the state, which a human can then call and confirm.

This is emphatically not the same thing as a verified directory:

  * Name matching is a heuristic. "Winston Water Cooler" is a plumbing
    supplier and "Buckeye Water Conservation & Drainage District" is an
    irrigation district; both contain "water". The exclusion list below
    exists because of exactly those cases.
  * A carrier registered to haul water may no longer do it, may not serve
    your area, or may only do construction water rather than potable.
  * Addresses are the carrier's registered business location, not a
    service area. Haulers travel; a hauler 40 miles away may well serve you
    and one 5 miles away may not.

So every record ships with needs_call=true and a confidence rating, and the
site is required to present them as leads to call rather than as verified
places to get water. Anything a person would *act* on has to be confirmed
by a human first.

Run:
    python build_haulers.py
"""

import json
import os
import re
import time
import urllib.parse
import urllib.request

OUT_DIR = os.path.join(os.path.dirname(__file__), "site", "data")
os.makedirs(OUT_DIR, exist_ok=True)

FMCSA = "https://data.transportation.gov/resource/az4n-8mr2.json"
GAZETTEER = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
             "2024_Gazetteer/2024_gaz_place_04.txt")
UA = {"User-Agent": "wheresmywater.org (contact: sidaksmann@gmail.com)"}

# Strong signals that a carrier actually moves water in bulk.
STRONG = ("WATER HAUL", "HAULING WATER", "POTABLE", "BULK WATER", "WATER TRUCK",
          "WATER DELIVERY", "WATER DELIVERIES", "HAUL N WATER", "WATER HAULER")
# Weaker signals: plausible, but plenty of these turn out to be utilities,
# well drillers or retailers.
WEAK = ("WATER SERVICE", "WATER SERVICES", "WATER CO", "WATER COMPANY",
        "WATER TRANSPORT", "WATER SUPPLY", "HAULING", "HAUL")
# Things that contain "water" but do not deliver drinking water to a tank.
EXCLUDE = ("COOLER", "CONDITION", "SOFTEN", "PLUMB", "DRILL", "PUMP REPAIR",
           "DRAINAGE", "CONSERVATION DISTRICT", "IRRIGATION DISTRICT",
           "TREATMENT PLANT", "WASTEWATER", "WASTE WATER", "SEWER", "SEPTIC", "POOL",
           "LANDSCAP", "SPRINKLER", "RESTORATION", "DAMAGE", "FIRE PROTECT",
           "BOTTLING", "BOTTLED", "ICE ", "BEVERAGE", "COFFEE", "HEATER",
           "SOFTWARE", "WELL DRILLING", "DAIRY", "CAR WASH", "PRESSURE WASH")


def fetch_carriers():
    """Every Arizona motor carrier whose name mentions water."""
    where = ("phy_state='AZ' AND (upper(legal_name) like '%WATER%' "
             "OR upper(dba_name) like '%WATER%')")
    select = ("dot_number,legal_name,dba_name,phy_street,phy_city,phy_zip,"
              "phone,status_code,power_units,truck_units,email_address")
    rows, offset = [], 0
    while True:
        qs = urllib.parse.urlencode({
            "$where": where, "$select": select,
            "$limit": 1000, "$offset": offset, "$order": "dot_number",
        })
        req = urllib.request.Request(f"{FMCSA}?{qs}", headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            batch = json.load(r)
        rows += batch
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


def _match(term, name):
    """
    Word-start match, not bare substring.

    Plain `in` matching silently drops real haulers: "ICE" appears inside
    "BRICE WATER DELIVERY LLC", so Brice was being excluded as an ice
    company. Anchoring to a word start keeps prefix matches that we want
    ("CONDITION" -> "CONDITIONING") while refusing accidental ones.
    """
    return re.search(r"\b" + re.escape(term.strip()), name) is not None


def classify(row):
    """Return 'high', 'low', or None (meaning: not a water hauler)."""
    name = f"{row.get('legal_name') or ''} {row.get('dba_name') or ''}".upper()
    if any(_match(x, name) for x in EXCLUDE):
        return None
    if any(_match(x, name) for x in STRONG):
        return "high"
    if any(_match(x, name) for x in WEAK):
        return "low"
    return None


def load_place_centroids():
    """
    Census Gazetteer place centroids for Arizona.

    One coordinate per city, not per carrier: FMCSA gives a registered
    business address, which is where the company is based rather than where
    it will deliver, so street-level precision would imply accuracy this
    data doesn't have. City centroid plus a clear label is the honest choice.

    (The address geocoder can't answer a bare "Kingman, AZ" with no street,
    which is why this uses the gazetteer instead.)
    """
    req = urllib.request.Request(GAZETTEER, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8", "replace")

    places = {}
    for line in text.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        name = parts[3].strip()
        try:
            lat, lon = float(parts[-2]), float(parts[-1])
        except ValueError:
            continue
        # "Kingman city", "Aguila CDP", "Dewey-Humboldt town" -> "KINGMAN"
        bare = name.upper()
        for suffix in (" CDP", " CITY", " TOWN", " VILLAGE"):
            if bare.endswith(suffix):
                bare = bare[: -len(suffix)]
        places.setdefault(bare.strip(), (lat, lon))

    # FMCSA city names are keyed by whatever the carrier typed on their
    # MCS-150 form, so they carry abbreviations and outright typos that no
    # gazetteer will match. These are the real mismatches seen in the AZ
    # data; without them the carrier still lists, it just can't be sorted
    # by distance.
    aliases = {
        "DEWEY": "DEWEY-HUMBOLDT",
        "PRESCOTT VLY": "PRESCOTT VALLEY",
        "LAKE HAUASU": "LAKE HAVASU CITY",   # sic, misspelled at the source
        "LAKE HAVASU": "LAKE HAVASU CITY",
        "LITCHFIELD": "LITCHFIELD PARK",
        "SAINT DAVID": "ST. DAVID",
        "FT MOHAVE": "FORT MOHAVE",
    }
    for wrong, right in aliases.items():
        if right in places and wrong not in places:
            places[wrong] = places[right]
    return places


def title_case(s):
    """FMCSA stores names in caps; SHOUTING at readers is unnecessary."""
    small = {"LLC": "LLC", "INC": "Inc.", "LLP": "LLP", "CO": "Co.", "AZ": "AZ",
             "LC": "LC", "II": "II", "III": "III", "USA": "USA", "RV": "RV"}
    out = []
    for w in (s or "").split():
        bare = w.strip(".,")
        out.append(small.get(bare.upper(), w.capitalize() if not w.isdigit() else w))
    return " ".join(out)


def main():
    print("Querying FMCSA motor carrier census for Arizona...")
    rows = fetch_carriers()
    print(f"  {len(rows)} AZ carriers with 'water' in the name")

    print("Loading Census place centroids for Arizona...")
    places = load_place_centroids()
    print(f"  {len(places)} Arizona places")

    unmatched, out = set(), []
    for row in rows:
        conf = classify(row)
        if not conf:
            continue
        if (row.get("status_code") or "").upper() != "A":
            continue  # inactive registration
        city = (row.get("phy_city") or "").title()
        loc = places.get(city.upper().strip())
        if city and not loc:
            unmatched.add(city)
        loc = {"lat": loc[0], "lon": loc[1]} if loc else None
        phone = (row.get("phone") or "").strip()
        if len(phone) == 10 and phone.isdigit():
            phone = f"({phone[:3]}) {phone[3:6]}-{phone[6:]}"
        out.append({
            "name": title_case(row.get("dba_name") or row.get("legal_name")),
            "city": city,
            "zip": (row.get("phy_zip") or "")[:5],
            "phone": phone or None,
            "lat": loc["lat"] if loc else None,
            "lon": loc["lon"] if loc else None,
            "confidence": conf,
            "dot": row.get("dot_number"),
            "trucks": row.get("power_units") or row.get("truck_units"),
            "sourced": "FMCSA motor carrier census, discovered automatically",
            "needs_call": True,
        })

    out.sort(key=lambda r: (r["confidence"] != "high", r["city"] or "", r["name"]))
    path = os.path.join(OUT_DIR, "haulers.json")
    with open(path, "w") as f:
        json.dump({
            "_README": ("Candidate water haulers discovered from the federal motor "
                        "carrier census, NOT a verified directory and NOT a permit "
                        "list. Every entry needs a phone call before it can be "
                        "trusted. confidence 'high' means the business name states "
                        "water hauling outright; 'low' means the name is only "
                        "suggestive. Coordinates are city centroids, not service "
                        "areas."),
            "_source": "FMCSA Motor Carrier Census via data.transportation.gov",
            "_built": time.strftime("%Y-%m-%d"),
            "haulers": out,
        }, f, separators=(",", ":"))

    hi = sum(1 for r in out if r["confidence"] == "high")
    cities = len({r["city"] for r in out})
    located = sum(1 for r in out if r["lat"])
    print(f"  kept {len(out)} candidates ({hi} high confidence) across {cities} cities")
    print(f"  {located}/{len(out)} placed on the map")
    if unmatched:
        # Named so they can be fixed rather than silently dropped from
        # distance sorting.
        print(f"  no centroid for: {', '.join(sorted(unmatched))}")
    print(f"  -> {path} ({os.path.getsize(path):,} bytes)")


def self_check():
    """
    The classifier is a keyword heuristic, so it needs a regression test
    made of the real names that fooled it. A false positive here becomes a
    stranger's phone number presented as a water hauler.
    """
    def c(name):
        return classify({"legal_name": name, "dba_name": ""})

    # Real AZ carriers that must be kept.
    for name in ("SONORAN WATER HAULING LLC", "MCINTOSH POTABLE WATER LLC",
                 "HAUL N WATER", "THOMAS WATER TRUCKS LLC",
                 "BRICE WATER DELIVERY LLC"):
        assert c(name) == "high", f"should be high confidence: {name}"

    # Real AZ carriers that must be rejected: none of these deliver
    # drinking water to a household tank.
    for name in ("WINSTON WATER COOLER OF PHOENIX",
                 "BUCKEYE WATER CONSERVATION & DRAINAGE DISTRICT",
                 "WINSLOW WATER CONDITIONING",
                 "ARIZONA WASTE WATER SERVICE",
                 "SMITH WELL DRILLING",
                 "DESERT POOL SERVICE",
                 "BLUE ICE BOTTLED WATER"):
        assert c(name) is None, f"should be excluded: {name}"

    # Suggestive but unconfirmed stays low, never high.
    assert c("HIGHLAND WATER COMPANY INC") == "low"

    # Exclusions beat strong matches: "water hauling" inside a wastewater
    # company name must still be rejected.
    assert c("VALLEY WASTEWATER HAULING LLC") is None

    assert title_case("MCINTOSH POTABLE WATER LLC") == "Mcintosh Potable Water LLC"
    print("build_haulers self-check passed")


if __name__ == "__main__":
    import sys
    if "--check" in sys.argv:
        self_check()
    else:
        main()
