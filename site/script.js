/* Where's My Water — client-side lookup
 *
 * The whole lookup runs in the browser. That's deliberate: the site is
 * static (GitHub Pages), so there's no server to run, pay for, or keep
 * patched, and the visitor's address never leaves their machine except to
 * the Census geocoder. The tradeoff is that the boundary files ship to
 * every visitor, so build_site_data.py keeps them small.
 *
 * Data files are fetched lazily on first search, not at page load, so
 * someone who only reads the page never downloads a megabyte of polygons.
 */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const NEARBY_WELL_RADIUS_MI = 1.0;

// DOM refs are resolved in init() rather than at module scope so the pure
// lookup functions below can be imported and tested outside a browser
// (see test.mjs). The geometry is the part most likely to break silently.
let results, form, input, submitBtn;

let data = null; // populated on first lookup

/* ---------- geometry ---------- */

// Ray casting. `ring` is [[lon,lat], ...].
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// A polygon is [outerRing, ...holes]; a point counts only if it's inside
// the outer ring and outside every hole.
function inPolygon(lon, lat, rings) {
  if (!rings.length || !inRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i])) return false;
  }
  return true;
}

function inFeature(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return inPolygon(lon, lat, geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((p) => inPolygon(lon, lat, p));
  return false;
}

function findFeature(fc, lon, lat) {
  if (!fc || !fc.features) return null;
  return fc.features.find((f) => inFeature(lon, lat, f.geometry)) || null;
}

// Great-circle distance in miles.
function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- data ---------- */

async function loadData() {
  if (data) return data;
  // violations.json is large and optional; a missing file degrades the
  // safety panel rather than breaking the whole lookup.
  const grab = async (name, fallback) => {
    try {
      const r = await fetch(`data/${name}`);
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      console.warn(`could not load ${name}`, e);
      return fallback;
    }
  };
  const [directory, cws, ama, aaws, wells, violations] = await Promise.all([
    grab("directory.json", { communities: [] }),
    grab("cws.json", { features: [] }),
    grab("ama_ina.json", { features: [] }),
    grab("aaws.json", { features: [] }),
    grab("wells.json", []),
    grab("violations.json", {}),
  ]);
  data = { directory, cws, ama, aaws, wells, violations };
  return data;
}

/*
 * The Census geocoder serves no Access-Control-Allow-Origin header, so a
 * plain fetch() is blocked by the browser. It does support JSONP, which is
 * why this injects a script tag instead. JSONP means executing whatever
 * that host returns, which is only acceptable because it's a fixed US
 * government endpoint we control the URL of -- never point this at a
 * user-supplied host. The alternative was proxying through a server, which
 * would mean having a server at all.
 */
let jsonpSeq = 0;

function geocode(address) {
  return new Promise((resolve, reject) => {
    const cb = `__wmwGeo${++jsonpSeq}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("geocoder-unavailable")), 12000);

    function finish(err, value) {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      err ? reject(err) : resolve(value);
    }

    window[cb] = (json) => {
      const m = json && json.result && json.result.addressMatches;
      if (!m || !m.length) return finish(new Error("no-match"));
      finish(null, {
        lon: m[0].coordinates.x,
        lat: m[0].coordinates.y,
        matched: m[0].matchedAddress,
      });
    };

    script.onerror = () => finish(new Error("geocoder-unavailable"));
    script.src =
      `${CENSUS_URL}?address=${encodeURIComponent(address)}` +
      `&benchmark=Public_AR_Current&format=jsonp&callback=${cb}`;
    document.head.appendChild(script);
  });
}

/* ---------- lookup ---------- */

// Property names vary between ADWR layers and across their refreshes, so
// pick the first property whose key looks like a name instead of hardcoding.
function nameOf(feature, pattern = /NAME/i) {
  if (!feature || !feature.properties) return null;
  const key = Object.keys(feature.properties).find(
    (k) => pattern.test(k) && feature.properties[k]
  );
  return key ? String(feature.properties[key]).trim() : null;
}

// ADWR calls the public water system ID "ADEQ_ID"; EPA calls the same
// value PWSID. That shared identifier is what links a service area to its
// federal violation record.
function pwsidOf(feature) {
  if (!feature || !feature.properties) return null;
  const key = Object.keys(feature.properties).find((k) => /^(ADEQ_ID|PWS_?ID)$/i.test(k));
  return key ? String(feature.properties[key]).trim() : null;
}

function communityFor(lon, lat, directory) {
  return (
    (directory.communities || []).find((c) => {
      const b = c.bbox;
      return b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
    }) || null
  );
}

function lookup(loc, d) {
  const { lon, lat } = loc;
  const cwsFeature = findFeature(d.cws, lon, lat);
  const providerName = nameOf(cwsFeature, /CWS_NAME|PWS_NAME/i) || nameOf(cwsFeature, /NAME/i);
  const pwsid = pwsidOf(cwsFeature);

  const community = communityFor(lon, lat, d.directory);
  const places = community
    ? community.entries
        .map((e) => ({
          ...e,
          miles: e.lat != null && e.lon != null ? milesBetween(lat, lon, e.lat, e.lon) : null,
        }))
        // Entries without coordinates (phone-only haulers) still matter, so
        // sort them last rather than dropping them.
        .sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity))
    : [];

  const wellCount = (d.wells || []).filter(
    (w) => milesBetween(lat, lon, w.lat, w.lon) <= NEARBY_WELL_RADIUS_MI
  ).length;

  return {
    loc,
    community,
    places,
    provider: providerName,
    violations: pwsid && d.violations ? d.violations[pwsid] : null,
    ama: nameOf(findFeature(d.ama, lon, lat), /BASIN_NAME|NAME/i),
    aaws: findFeature(d.aaws, lon, lat),
    wellCount,
  };
}

/* ---------- render ---------- */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function renderPlace(p) {
  const rows = [];
  if (p.miles != null) {
    rows.push(
      `<dt>Distance</dt><dd><span class="dist">${p.miles.toFixed(1)} mi${
        p.coordinates_approximate ? " (approx)" : ""
      }</span></dd>`
    );
  }
  if (p.address) rows.push(`<dt>Address</dt><dd>${esc(p.address)}</dd>`);
  if (p.hours) rows.push(`<dt>Hours</dt><dd>${esc(p.hours)}</dd>`);
  if (p.phone)
    rows.push(
      `<dt>Phone</dt><dd><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a></dd>`
    );
  if (p.email) rows.push(`<dt>Email</dt><dd><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></dd>`);
  if (p.website)
    rows.push(
      `<dt>Website</dt><dd><a href="${esc(p.website)}" rel="noopener">${esc(
        p.website.replace(/^https?:\/\//, "").replace(/\/$/, "")
      )}</a></dd>`
    );

  return `
    <article class="place">
      <div class="place-top">
        <h3>${esc(p.name)}</h3>
        <span class="badge ${esc(p.type)}">${p.type === "standpipe" ? "Fill up here" : "Delivers to you"}</span>
      </div>
      <p class="what">${esc(p.what)}</p>
      <dl>${rows.join("")}</dl>
      ${p.access ? `<p class="what"><strong>Before you go:</strong> ${esc(p.access)}</p>` : ""}
      <div class="place-foot">
        <p class="provenance">
          ${esc(p.sourced)}${
    p.needs_call
      ? ` · <span class="unverified">Not yet confirmed by phone — call before driving out.</span>`
      : ""
  }
        </p>
      </div>
    </article>`;
}

function renderProvider(r) {
  if (!r.provider) {
    return `
      <div class="provider no-provider">
        <p class="provider-name">No municipal water provider</p>
        <p>This address doesn't fall inside any water utility's official
        service area. That isn't an error in the lookup, it's the situation:
        there's no city or company obligated to pipe water here. Homes in
        this position typically rely on hauled water delivered to a storage
        tank, or a private well.</p>
        <p class="caveat">Source: ADWR Community Water System service areas.
        If you believe you do have a provider, they may serve you outside
        their mapped boundary — check a recent water bill.</p>
      </div>`;
  }

  const v = r.violations;
  let panel = `<p class="caveat">We don't have an EPA compliance record matched to this provider yet.</p>`;
  if (v) {
    const total = v.violations || 0;
    const health = v.health_based || 0;
    panel = `
      <div class="viol-row">
        <div class="stat">
          <span class="n ${health ? "flag" : "clean"}">${health}</span>
          <span class="l">health-based violations on record</span>
        </div>
        <div class="stat">
          <span class="n">${total}</span>
          <span class="l">total violations on record</span>
        </div>
        ${
          v.population
            ? `<div class="stat"><span class="n">${esc(v.population)}</span><span class="l">people served</span></div>`
            : ""
        }
      </div>
      <p class="caveat" style="margin-top:1rem">
        From EPA's Safe Drinking Water Information System. A violation can be
        anything from a missed monitoring report to a contaminant exceedance,
        and records go back many years, so a count above zero doesn't mean
        your water is unsafe today. Zero doesn't guarantee it's safe either.
      </p>`;
  }

  return `
    <div class="provider">
      <p class="provider-name">${esc(r.provider)}</p>
      <p class="caveat">Your address falls inside this provider's official service area.</p>
      ${panel}
    </div>`;
}

function renderContext(r) {
  const facts = [
    `<div class="fact"><dt>Groundwater management</dt><dd>${
      r.ama ? esc(r.ama) : "Outside any AMA or INA"
    }</dd></div>`,
    `<div class="fact"><dt>Monitored wells within 1 mile</dt><dd>${r.wellCount}</dd></div>`,
    `<div class="fact"><dt>100-year supply determination</dt><dd>${
      r.aaws ? "On record for this area" : "None found for this address"
    }</dd></div>`,
  ];

  return `
    <details class="context">
      <summary>Why this area is the way it is</summary>
      <div class="context-body">
        <dl class="facts">${facts.join("")}</dl>
        <p class="caveat">
          Active Management Areas are the parts of Arizona with real
          groundwater regulation. The well count comes from ADWR's monitoring
          index, which does not include every private or exempt well, so
          treat it as a floor rather than a total. A 100-year supply
          determination means a subdivision had to prove long-term water
          availability before it was approved.
        </p>
      </div>
    </details>`;
}

function render(r) {
  const tier1 = !r.community
    ? `<div class="status">
         <p style="margin:0"><strong>We haven't mapped water sources for this area yet.</strong></p>
         <p style="margin:.5rem 0 0">
           This directory is hand-built and currently covers Rio Verde
           Foothills. Your provider and regulatory details are below, and if
           you know water sources near you, please
           <a href="mailto:sidaksmann@gmail.com?subject=Water%20source%20suggestion">tell us</a>
           so we can add them.
         </p>
       </div>`
    : `<p class="tier-note">${esc(r.community.note)}</p>
       <div class="places">${r.places.map(renderPlace).join("")}</div>
       ${(r.community.also_see || [])
         .map(
           (s) =>
             `<p class="provenance" style="margin-top:1rem">Also worth checking:
              <a href="${esc(s.website)}" rel="noopener">${esc(s.name)}</a> — ${esc(s.what)}</p>`
         )
         .join("")}`;

  results.innerHTML = `
    <p class="matched">Showing results for ${esc(r.loc.matched)}</p>

    <section class="tier">
      <div class="tier-head"><span class="tier-num">1 · Right now</span><h2>Where to get water</h2></div>
      ${tier1}
    </section>

    <section class="tier">
      <div class="tier-head"><span class="tier-num">2 · Your supply</span><h2>Who provides your water</h2></div>
      ${renderProvider(r)}
    </section>

    <section class="tier">
      <div class="tier-head"><span class="tier-num">3 · Background</span><h2>The bigger picture</h2></div>
      ${renderContext(r)}
    </section>`;
}

/* ---------- events ---------- */

function setBusy(on, message) {
  results.setAttribute("aria-busy", on ? "true" : "false");
  submitBtn.disabled = on;
  submitBtn.textContent = on ? "Searching…" : "Find water";
  if (message) results.innerHTML = `<p class="status">${esc(message)}</p>`;
}

async function onSubmit(e) {
  e.preventDefault();
  const address = input.value.trim();
  if (!address) {
    results.innerHTML = `<p class="status error">Please enter an address first.</p>`;
    input.focus();
    return;
  }

  setBusy(true, "Looking up your address…");
  try {
    const [d, loc] = await Promise.all([loadData(), geocode(address)]);
    render(lookup(loc, d));
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    const msg =
      err.message === "no-match"
        ? `We couldn't find that address. Try including the city and ZIP, for example "17204 E Rio Verde Dr, Rio Verde, AZ 85263". Rural addresses sometimes aren't in the Census database even when they exist.`
        : `Something went wrong looking that up. Check your connection and try again.`;
    results.innerHTML = `<p class="status error">${esc(msg)}</p>`;
  } finally {
    setBusy(false);
  }
}

function init() {
  results = document.getElementById("results");
  form = document.getElementById("lookup");
  input = document.getElementById("address");
  submitBtn = document.getElementById("submit-btn");

  form.addEventListener("submit", onSubmit);
  document.getElementById("try-example").addEventListener("click", () => {
    input.value = "17204 E Rio Verde Dr, Rio Verde, AZ 85263";
    form.requestSubmit();
  });
}

if (typeof document !== "undefined") init();

export { inRing, inPolygon, inFeature, findFeature, milesBetween, communityFor, nameOf, pwsidOf, lookup };
