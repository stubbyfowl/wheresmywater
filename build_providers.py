#!/usr/bin/env python3
"""Generate static provider pages, providers index, sitemap.xml, and robots.txt.

Run from repo root:
    python3 build_providers.py

Reads:  site/data/violations.json, site/data/cws.json, site/data/aaws.json, site/data/ama_ina.json
Writes: site/provider/*.html, site/providers.html, site/sitemap.xml, site/robots.txt
"""

import json, os, re, html
from datetime import date
from pathlib import Path

SITE = Path(__file__).parent / "site"
DATA = SITE / "data"
TODAY = date.today().isoformat()

# EPA contaminant codes -> readable names
CONTAMINANT_NAMES = {
    "0200": "Coliform (TCR)",
    "0300": "E. coli",
    "0700": "Treatment technique",
    "1005": "Arsenic",
    "1008": "Antimony",
    "1009": "Barium",
    "1025": "Fluoride",
    "1040": "Nitrate",
    "1045": "Nitrite",
    "1074": "Uranium",
    "2039": "Di(2-ethylhexyl)phthalate",
    "2456": "Combined radium",
    "2920": "TTHM",
    "2950": "HAA5",
    "4006": "PFAS",
    "5000": "Lead and copper",
    "5200": "Lead action level",
    "8000": "Public notification",
}

VIOLATION_TYPES = {
    "MCL": "Maximum contaminant level",
    "MR":  "Monitoring and reporting",
    "MON": "Monitoring",
    "RPT": "Reporting",
    "TT":  "Treatment technique",
    "FO":  "Filter optimization",
    "Other": "Other",
}

SYSTEM_TYPES = {
    "CWS":    "Community water system",
    "NTNCWS": "Non-transient non-community",
    "TNCWS":  "Transient non-community",
}


def slugify(name, county=None):
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    if county:
        c = county.lower().strip()
        if c not in s:
            s = f"{s}-{c}"
    return s


def esc(text):
    return html.escape(str(text)) if text else ""


def load_json(name):
    with open(DATA / name) as f:
        return json.load(f)


def build_provider_page(sys_id, viol, cws_props, ama_names):
    name = viol["name"]
    pop = viol.get("population", "")
    sys_type = viol.get("type", "CWS")
    total_v = viol.get("violations", 0)
    health_v = viol.get("health_based", 0)
    recent_5yr = viol.get("recent_5yr", 0)
    unresolved = viol.get("unresolved", 0)
    recent = viol.get("recent", [])

    county = cws_props.get("COUNTY", "") if cws_props else ""
    phone = cws_props.get("PHONE", "") if cws_props else ""
    owner = cws_props.get("OWNER_NAME", "").strip() if cws_props else ""

    slug = slugify(name, county)
    type_label = SYSTEM_TYPES.get(sys_type, sys_type)

    title_name = esc(name.title() if name.isupper() else name)
    page_title = f"{title_name} Water Safety Record | Where's My Water"
    meta_desc = f"Drinking water violations, safety record, and contact info for {esc(name)}"
    if county:
        meta_desc += f" in {esc(county.title())} County, Arizona"
    meta_desc += f". {total_v} total violations on record."

    # Stats row
    health_class = "flag" if health_v else "clean"
    stats_html = f"""
    <div class="viol-row">
      <div class="stat">
        <span class="n {health_class}">{health_v}</span>
        <span class="l">health-based violations</span>
      </div>
      <div class="stat">
        <span class="n">{total_v}</span>
        <span class="l">total violations on record</span>
      </div>
      <div class="stat">
        <span class="n">{recent_5yr}</span>
        <span class="l">in last 5 years</span>
      </div>
      <div class="stat">
        <span class="n {"flag" if unresolved else "clean"}">{unresolved}</span>
        <span class="l">unresolved</span>
      </div>
      {f'<div class="stat"><span class="n">{esc(str(pop))}</span><span class="l">people served</span></div>' if pop else ""}
    </div>"""

    # Recent violations table
    recent_html = ""
    if recent:
        rows = ""
        for r in recent[:20]:
            cname = CONTAMINANT_NAMES.get(r.get("contaminant", ""), r.get("contaminant", "Unknown"))
            vtype = VIOLATION_TYPES.get(r.get("type", ""), r.get("type", ""))
            began = esc(r.get("began", ""))
            status = r.get("status", "")
            status_class = "flag-inline" if status == "Unaddressed" else ""
            rows += f"""
        <tr>
          <td>{esc(cname)}</td>
          <td>{esc(vtype)}</td>
          <td>{esc(began)}</td>
          <td{f' class="{status_class}"' if status_class else ''}>{esc(status)}</td>
        </tr>"""
        recent_html = f"""
    <h2>Recent violations</h2>
    <div class="table-wrap">
      <table class="viol-table">
        <thead><tr><th>Contaminant</th><th>Type</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>{rows}
        </tbody>
      </table>
    </div>"""
        if len(recent) > 20:
            recent_html += f'\n    <p class="caveat">Showing 20 of {len(recent)} recent violations.</p>'

    # Facts grid
    facts = []
    facts.append(f'<div class="fact"><dt>System type</dt><dd>{esc(type_label)}</dd></div>')
    facts.append(f'<div class="fact"><dt>EPA ID</dt><dd>{esc(sys_id)}</dd></div>')
    if county:
        facts.append(f'<div class="fact"><dt>County</dt><dd>{esc(county.title())}</dd></div>')
    if owner and owner.lower() != name.lower():
        facts.append(f'<div class="fact"><dt>Owner</dt><dd>{esc(owner.title() if owner.isupper() else owner)}</dd></div>')
    if phone:
        facts.append(f'<div class="fact"><dt>Phone</dt><dd><a href="tel:{esc(phone)}">{esc(phone)}</a></dd></div>')

    facts_html = f"""
    <div class="facts">
      {"".join(facts)}
    </div>"""

    # Structured data (schema.org)
    schema = {
        "@context": "https://schema.org",
        "@type": "GovernmentService",
        "name": name,
        "serviceType": "Public water system",
        "provider": {
            "@type": "GovernmentOrganization",
            "name": owner or name,
        },
        "areaServed": {
            "@type": "AdministrativeArea",
            "name": f"{county.title()} County, Arizona" if county else "Arizona",
        },
        "url": f"https://wheresmywater.org/provider/{slug}.html",
    }
    if phone:
        schema["provider"]["telephone"] = phone

    schema_json = json.dumps(schema, indent=2)

    page_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{page_title}</title>
<meta name="description" content="{esc(meta_desc)}">
<link rel="canonical" href="https://wheresmywater.org/provider/{slug}.html">
<link rel="icon" href="/favicon.ico" sizes="32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1268c3">
<link rel="stylesheet" href="../styles.css">
<script type="application/ld+json">
{schema_json}
</script>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>

<header class="site-header">
  <a class="brand" href="/">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">Where's My Water</span>
  </a>
  <nav aria-label="Main">
    <a href="/">Search</a>
    <a href="/providers.html">All providers</a>
    <a href="/about.html">About</a>
    <a href="/data.html">Data sources</a>
  </nav>
</header>

<main id="main">
  <div class="band" style="padding-bottom:0">
    <a class="backlink" href="/providers.html">All providers</a>
    <h1>{title_name}</h1>
    <p class="band-lede">{esc(type_label)}{f" · {esc(county.title())} County" if county else ""} · EPA ID {esc(sys_id)}</p>
  </div>

  <section class="band" style="padding-top:1.5rem">
    <div class="provider">
      <h2>Drinking water safety record</h2>
      {stats_html}
      <p class="caveat" style="margin-top:1rem">
        From EPA's Safe Drinking Water Information System. A violation can be
        anything from a missed monitoring report to a contaminant exceedance,
        and records go back many years, so a count above zero does not mean
        your water is unsafe today. Zero does not guarantee it is safe either.
      </p>
    </div>

    {recent_html}

    <h2 style="margin-top:2rem">System details</h2>
    {facts_html}

    <div class="callout" style="margin-top:2rem">
      <h2 style="margin-bottom:.5rem">Is this your water provider?</h2>
      <p>Search your address to see if you fall inside this provider's
      service area, and find haulers, standpipes, and other water sources
      nearby.</p>
      <a class="btn-outline" href="/">Search your address</a>
    </div>

    <p class="caveat" style="margin-top:2rem">
      <strong>About this page:</strong> This page is generated from EPA
      SDWIS public records. It is not affiliated with or endorsed by
      {title_name}. Data can be incomplete or out of date. For
      current information, contact the provider directly{f" at {esc(phone)}" if phone else ""}.
    </p>
  </section>
</main>

<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-bottom">
      <p class="colophon">
        &copy; 2026 Where's My Water. Data from the EPA and ADWR.
        <a href="/privacy.html">Privacy</a> &middot;
        <a href="/terms.html">Terms</a>
      </p>
    </div>
  </div>
</footer>

</body>
</html>
"""
    return slug, page_html


def build_providers_index(providers_list):
    # Sort alphabetically
    providers_list.sort(key=lambda p: p["name"].lower())

    # Group by first letter
    groups = {}
    for p in providers_list:
        letter = p["name"][0].upper()
        if not letter.isalpha():
            letter = "#"
        groups.setdefault(letter, []).append(p)

    # Build letter nav
    letters = sorted(groups.keys())
    letter_nav = " ".join(f'<a href="#{l}">{l}</a>' for l in letters)

    # Build provider list
    list_html = ""
    for letter in letters:
        list_html += f'\n    <h2 id="{letter}">{letter}</h2>\n    <ul class="provider-list">'
        for p in groups[letter]:
            badge = ""
            if p["unresolved"] > 0:
                badge = f' <span class="badge badge-flag">{p["unresolved"]} unresolved</span>'
            county_label = f" · {esc(p['county'].title())} County" if p.get("county") else ""
            pop_label = f" · {esc(str(p['pop']))} served" if p.get("pop") else ""
            list_html += f"""
      <li><a href="/provider/{p['slug']}.html">{esc(p['display_name'])}</a>{badge}<span class="provider-meta">{esc(SYSTEM_TYPES.get(p['type'], p['type']))}{county_label}{pop_label}</span></li>"""
        list_html += "\n    </ul>"

    # FAQ structured data for the "What to do" section on the index page
    # We'll add it to the index page separately

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Arizona water providers | Where's My Water</title>
<meta name="description" content="Browse all {len(providers_list)} Arizona public water systems tracked by Where's My Water. Violation records, safety data, and contact info for every provider.">
<link rel="canonical" href="https://wheresmywater.org/providers.html">
<link rel="icon" href="/favicon.ico" sizes="32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#1268c3">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>

<header class="site-header">
  <a class="brand" href="/">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">Where's My Water</span>
  </a>
  <nav aria-label="Main">
    <a href="/">Search</a>
    <a href="/providers.html" aria-current="page">All providers</a>
    <a href="/about.html">About</a>
    <a href="/data.html">Data sources</a>
  </nav>
</header>

<main id="main">
  <div class="band" style="padding-bottom:0">
    <a class="backlink" href="/">Back to search</a>
    <h1>All Arizona water providers</h1>
    <p class="band-lede">{len(providers_list)} public water systems tracked from EPA records.</p>
  </div>

  <section class="band" style="padding-top:1.5rem">
    <nav class="letter-nav" aria-label="Jump to letter">
      {letter_nav}
    </nav>
    {list_html}

    <p class="caveat" style="margin-top:2rem">
      Data from EPA's Safe Drinking Water Information System (SDWIS) and
      ADWR Community Water System boundaries. Not every system listed here
      is a household water provider; some are schools, parks, or other
      facilities with their own well or supply.
    </p>
  </section>
</main>

<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-bottom">
      <p class="colophon">
        &copy; 2026 Where's My Water. Data from the EPA and ADWR.
        <a href="/privacy.html">Privacy</a> &middot;
        <a href="/terms.html">Terms</a>
      </p>
    </div>
  </div>
</footer>

</body>
</html>
"""
    return page


def build_sitemap(slugs):
    urls = [
        ("https://wheresmywater.org/", "1.0"),
        ("https://wheresmywater.org/providers.html", "0.8"),
        ("https://wheresmywater.org/about.html", "0.5"),
        ("https://wheresmywater.org/data.html", "0.5"),
        ("https://wheresmywater.org/add.html", "0.4"),
        ("https://wheresmywater.org/privacy.html", "0.3"),
        ("https://wheresmywater.org/terms.html", "0.3"),
    ]
    for slug in slugs:
        urls.append((f"https://wheresmywater.org/provider/{slug}.html", "0.6"))

    entries = ""
    for url, priority in urls:
        entries += f"""  <url>
    <loc>{url}</loc>
    <lastmod>{TODAY}</lastmod>
    <priority>{priority}</priority>
  </url>
"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/ns/sitemap/0.9">
{entries}</urlset>
"""


def build_robots():
    return """User-agent: *
Allow: /
Disallow: /data/wells/

Sitemap: https://wheresmywater.org/sitemap.xml
"""


def build_faq_schema():
    """Schema.org FAQPage markup for the guide section."""
    faqs = [
        {
            "name": "What do I do if my water is out right now?",
            "text": "Search your address on wheresmywater.org and call the haulers listed. Ask about emergency or same-day delivery. If you cannot reach anyone, call your county emergency management office. For drinking in the meantime, bottled water from any store is safe."
        },
        {
            "name": "How do I get water if I rely on hauled water in Arizona?",
            "text": "Know your tank size and how many days it lasts. Order before you are near empty. Ask any hauler whether they carry potable water specifically and where they source it from. Keep a second hauler's number as backup."
        },
        {
            "name": "How do I test my private well water in Arizona?",
            "text": "Private wells are outside EPA and ADEQ drinking-water rules, so testing is on the owner. Test at least annually for bacteria and nitrate, and in Arizona also consider arsenic, fluoride and uranium. Use an ADHS-licensed lab."
        },
        {
            "name": "What should I check before buying property without a water connection in Arizona?",
            "text": "Search the address to see if any provider serves it. Ask whether the parcel has a 100-year assured water supply determination. Get the well's actual production rate in writing. Price hauled water into your monthly costs before you buy."
        },
        {
            "name": "What should I do if my tap water looks, smells or tastes wrong?",
            "text": "Look up your provider's record and request its Consumer Confidence Report. Report the problem to your provider first. If they do not respond, ADEQ's Safe Drinking Water Program takes complaints about public water systems."
        },
    ]

    schema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": faq["name"],
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": faq["text"],
                },
            }
            for faq in faqs
        ],
    }
    return json.dumps(schema, indent=2)


def main():
    print("Loading data...")
    violations = load_json("violations.json")
    cws = load_json("cws.json")

    cws_map = {}
    for f in cws["features"]:
        props = f["properties"]
        cws_map[props["ADEQ_ID"]] = props

    # Generate provider pages
    provider_dir = SITE / "provider"
    provider_dir.mkdir(exist_ok=True)

    slugs = []
    providers_list = []
    seen_slugs = set()

    for sys_id, viol in violations.items():
        cws_props = cws_map.get(sys_id)
        county = cws_props.get("COUNTY", "") if cws_props else ""
        slug, page_html = build_provider_page(sys_id, viol, cws_props, [])

        # Deduplicate slugs
        if slug in seen_slugs:
            slug = f"{slug}-{sys_id.lower()}"
        seen_slugs.add(slug)

        (provider_dir / f"{slug}.html").write_text(page_html)
        slugs.append(slug)

        display_name = viol["name"].title() if viol["name"].isupper() else viol["name"]
        providers_list.append({
            "name": viol["name"],
            "display_name": display_name,
            "slug": slug,
            "type": viol.get("type", "CWS"),
            "county": county,
            "pop": viol.get("population", ""),
            "unresolved": viol.get("unresolved", 0),
        })

    print(f"Generated {len(slugs)} provider pages in site/provider/")

    # Providers index
    index_html = build_providers_index(providers_list)
    (SITE / "providers.html").write_text(index_html)
    print("Generated site/providers.html")

    # Sitemap
    sitemap = build_sitemap(slugs)
    (SITE / "sitemap.xml").write_text(sitemap)
    print(f"Generated site/sitemap.xml ({len(slugs) + 7} URLs)")

    # Robots.txt
    robots = build_robots()
    (SITE / "robots.txt").write_text(robots)
    print("Generated site/robots.txt")

    print(f"\nDone. {len(slugs)} provider pages ready.")


if __name__ == "__main__":
    main()
