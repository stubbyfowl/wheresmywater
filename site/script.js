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

// A missing file degrades one panel rather than breaking the lookup.
async function grab(name, fallback) {
  try {
    const r = await fetch(`data/${name}`);
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn(`could not load ${name}`, e);
    return fallback;
  }
}

/*
 * Statewide coverage means ~4.5MB of boundaries (788KB gzipped), and the
 * people most likely to need this site are on rural cell connections. So
 * the load is split by what the answer actually shows:
 *
 *   core    (~170KB gzipped) directory + providers + water points: needed
 *                            for tiers 1 and 2, fetched on first search.
 *   context (~620KB gzipped) AMA, AAWS and 46,890 well points: tier 3 only,
 *                            which is collapsed by default, so it isn't
 *                            fetched until someone actually opens it.
 */
async function loadData() {
  if (data) return data;
  const [directory, cws, osm, violations] = await Promise.all([
    grab("directory.json", { communities: [] }),
    grab("cws.json", { features: [] }),
    grab("osm_water.json", []),
    grab("violations.json", {}),
  ]);
  data = { directory, cws, osm, violations };
  return data;
}

let contextData = null;
async function loadContext() {
  if (contextData) return contextData;
  const [ama, aaws, wells] = await Promise.all([
    grab("ama_ina.json", { features: [] }),
    grab("aaws.json", { features: [] }),
    grab("wells.json", []),
  ]);
  contextData = { ama, aaws, wells };
  return contextData;
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

// Nearest community-mapped water points. Only used to give people outside
// the curated communities something rather than nothing, so the radius is
// generous and the caller is responsible for labelling them honestly.
function nearestOsm(lat, lon, osm, limit = 6, maxMiles = 30) {
  return (osm || [])
    .map((p) => ({ ...p, miles: milesBetween(lat, lon, p.lat, p.lon) }))
    .filter((p) => p.miles <= maxMiles)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
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

  return {
    loc,
    community,
    places,
    osm: nearestOsm(lat, lon, d.osm),
    provider: providerName,
    violations: pwsid && d.violations ? d.violations[pwsid] : null,
  };
}

// Tier 3 only, and only once someone opens it -- see loadContext().
function lookupContext(loc, c) {
  const { lon, lat } = loc;
  return {
    ama: nameOf(findFeature(c.ama, lon, lat), /BASIN_NAME|NAME/i),
    aaws: findFeature(c.aaws, lon, lat),
    wellCount: (c.wells || []).filter(
      ([wlat, wlon]) => milesBetween(lat, lon, wlat, wlon) <= NEARBY_WELL_RADIUS_MI
    ).length,
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

function renderContext() {
  // Deliberately empty until opened: the layers behind it are most of the
  // page weight and most visitors never expand this.
  return `
    <details class="context" id="context">
      <summary>Why this area is the way it is</summary>
      <div class="context-body" id="context-body">
        <p class="caveat">Loading…</p>
      </div>
    </details>`;
}

function contextFacts(c) {
  const facts = [
    `<div class="fact"><dt>Groundwater management</dt><dd>${
      c.ama ? esc(c.ama) : "Outside any AMA or INA"
    }</dd></div>`,
    `<div class="fact"><dt>Monitored wells within 1 mile</dt><dd>${c.wellCount}</dd></div>`,
    `<div class="fact"><dt>100-year supply determination</dt><dd>${
      c.aaws ? "On record for this area" : "None found for this address"
    }</dd></div>`,
  ];
  return `
    <dl class="facts">${facts.join("")}</dl>
    <p class="caveat">
      Active Management Areas are the parts of Arizona with real groundwater
      regulation; most of the state sits outside one. The well count comes
      from ADWR's monitoring index, which does not include every private or
      exempt well, so treat it as a floor rather than a total. A 100-year
      supply determination means a subdivision had to prove long-term water
      availability before it was approved.
    </p>`;
}

function renderOsm(points, curatedToo) {
  if (!points.length) return "";
  const items = points
    .map(
      (p) => `
      <li>
        <strong>${esc(p.name)}</strong>
        <span class="dist">${p.miles.toFixed(1)} mi</span>
        <span class="osm-kind">${esc(p.kind)}</span>
        ${p.operator ? `<span class="osm-kind">${esc(p.operator)}</span>` : ""}
        ${p.fee === "yes" ? `<span class="osm-kind">fee</span>` : ""}
        <a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}"
           rel="noopener">map</a>
      </li>`
    )
    .join("");

  return `
    <div class="osm">
      <h3>${curatedToo ? "Other public water points nearby" : "Public water points nearby"}</h3>
      <p class="caveat">
        Mapped by OpenStreetMap volunteers, not verified by us. Most are
        drinking fountains or campground taps, useful for filling bottles or
        a jug but <strong>not</strong> for filling a household storage tank.
        If you need bulk water, you want a hauler or a standpipe.
      </p>
      <ul class="osm-list">${items}</ul>
    </div>`;
}

function render(r) {
  const tier1 = !r.community
    ? `<div class="status">
         <p style="margin:0"><strong>No haulers or standpipes verified for this area yet.</strong></p>
         <p style="margin:.5rem 0 0">
           The verified directory is built by hand and currently covers Rio
           Verde Foothills. ${
             r.osm.length
               ? "Community-mapped water points near you are listed below."
               : ""
           }
           If you know a hauler or standpipe near you, please
           <a href="mailto:sidaksmann@gmail.com?subject=Water%20source%20suggestion">tell us</a>
           and we'll verify and add it.
         </p>
       </div>
       ${renderOsm(r.osm, false)}`
    : `<p class="tier-note">${esc(r.community.note)}</p>
       <div class="places">${r.places.map(renderPlace).join("")}</div>
       ${(r.community.also_see || [])
         .map(
           (s) =>
             `<p class="provenance" style="margin-top:1rem">Also worth checking:
              <a href="${esc(s.website)}" rel="noopener">${esc(s.name)}</a> — ${esc(s.what)}</p>`
         )
         .join("")}
       ${renderOsm(r.osm, true)}`;

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
      ${renderContext()}
    </section>`;

  // Tier 3's data is most of the page weight, so it's fetched the first
  // time someone actually opens the panel, not on every lookup.
  const details = document.getElementById("context");
  const body = document.getElementById("context-body");
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    try {
      body.innerHTML = contextFacts(lookupContext(r.loc, await loadContext()));
    } catch (e) {
      loaded = false;
      body.innerHTML = `<p class="caveat">Couldn't load the background data. Try opening this again.</p>`;
    }
  });
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

export {
  inRing, inPolygon, inFeature, findFeature, milesBetween,
  communityFor, nameOf, pwsidOf, lookup, nearestOsm, lookupContext,
};
