/* Where's My Water: client-side lookup
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
  const [directory, cws, osm, violations, haulers] = await Promise.all([
    grab("directory.json", { communities: [] }),
    grab("cws.json", { features: [] }),
    grab("osm_water.json", []),
    grab("violations.json", {}),
    grab("haulers.json", { haulers: [] }),
  ]);
  data = { directory, cws, osm, violations, haulers: haulers.haulers || [] };
  return data;
}

let contextData = null;
async function loadContext() {
  if (contextData) return contextData;
  const [ama, aaws] = await Promise.all([
    grab("ama_ina.json", { features: [] }),
    grab("aaws.json", { features: [] }),
  ]);
  contextData = { ama, aaws };
  return contextData;
}

/*
 * Wells are tiled. The combined Wells55 + GWSI layer is ~218,000 points,
 * far too much to ship whole, so build_wells55.py cuts the state into 0.5
 * degree cells and we fetch only the cells a one-mile radius can touch.
 * Usually that's one file; near a tile edge it's up to four.
 */
function tileKey(lat, lon, size) {
  return `${Math.floor(lat / size)}_${Math.floor(lon / size)}`;
}

let wellIndex = null;
async function loadWellTiles(lat, lon) {
  if (!wellIndex) wellIndex = await grab("wells_index.json", { tile: 0.5, tiles: [] });
  const size = wellIndex.tile || 0.5;
  const available = new Set(wellIndex.tiles || []);

  // One mile in degrees: latitude is constant, longitude shrinks with
  // latitude. A little margin so an edge case pulls the neighbour tile.
  const dLat = 1.05 / 69;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));

  const keys = new Set();
  for (const a of [lat - dLat, lat + dLat]) {
    for (const o of [lon - dLon, lon + dLon]) keys.add(tileKey(a, o, size));
  }
  // Only request tiles the index says exist, so empty desert doesn't
  // generate a burst of 404s.
  const wanted = [...keys].filter((k) => available.has(k));
  const sets = await Promise.all(wanted.map((k) => grab(`wells/${k}.json`, [])));
  return sets.flat();
}

/*
 * The Census geocoder serves no Access-Control-Allow-Origin header, so a
 * plain fetch() is blocked by the browser. It does support JSONP, which is
 * why this injects a script tag instead. JSONP means executing whatever
 * that host returns, which is only acceptable because it's a fixed US
 * government endpoint we control the URL of. Never point this at a
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

/*
 * Nearest candidate haulers.
 *
 * The radius is deliberately wide (default 75 miles) because haulers drive
 * to you: their registered address is where the business is based, not the
 * edge of a service area. A Kingman hauler may well serve Dolan Springs.
 * High-confidence matches sort ahead of merely plausible ones at similar
 * distance, since a wrong lead costs someone a phone call they didn't need.
 */
function nearestHaulers(lat, lon, haulers, limit = 8, maxMiles = 75) {
  return (haulers || [])
    .map((h) => ({
      ...h,
      miles: h.lat != null && h.lon != null ? milesBetween(lat, lon, h.lat, h.lon) : null,
    }))
    .filter((h) => h.miles == null || h.miles <= maxMiles)
    .sort((a, b) => {
      const rank = (h) => (h.confidence === "high" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (a.miles ?? Infinity) - (b.miles ?? Infinity);
    })
    .slice(0, limit);
}

// Strip punctuation and company suffixes so "Rio Verde Foothills Potable
// Water Hauling, LLC" and "RIO VERDE FOOTHILLS POTABLE WATER HAULING LLC"
// compare equal.
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(llc|inc|co|company|corp|ltd|lc|llp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

  // FMCSA independently finds companies that are already in the curated
  // directory (it turns up Rio Verde Foothills Potable Water Hauling, for
  // one). That's a useful cross-check, but showing the same business twice
  // -- once verified, once as an unconfirmed lead -- reads as two options
  // and undercuts the verified entry. The hand-checked record wins.
  const curatedNames = places.map((p) => normalizeName(p.name));
  const haulers = nearestHaulers(lat, lon, d.haulers).filter((h) => {
    const n = normalizeName(h.name);
    return !curatedNames.some((c) => c.includes(n) || n.includes(c));
  });

  return {
    loc,
    community,
    places,
    osm: nearestOsm(lat, lon, d.osm),
    haulers,
    provider: providerName,
    violations: pwsid && d.violations ? d.violations[pwsid] : null,
  };
}

// Tier 3 only, and only once someone opens it -- see loadContext().
function lookupContext(loc, c) {
  const { lon, lat } = loc;
  const near = (c.wells || [])
    .map((w) => ({
      miles: milesBetween(lat, lon, w[0], w[1]),
      depth: w[2] ?? null,
      year: w[3] ?? null,
    }))
    .filter((w) => w.miles <= NEARBY_WELL_RADIUS_MI)
    .sort((a, b) => a.miles - b.miles);

  const depths = near.map((w) => w.depth).filter((d) => typeof d === "number");
  return {
    ama: nameOf(findFeature(c.ama, lon, lat), /BASIN_NAME|NAME/i),
    aaws: findFeature(c.aaws, lon, lat),
    wellCount: near.length,
    nearestWells: near.slice(0, 6),
    // Median rather than mean: a single 2,000ft irrigation well shouldn't
    // define what "the wells around here" look like.
    medianDepth: depths.length
      ? depths.sort((a, b) => a - b)[Math.floor(depths.length / 2)]
      : null,
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
        <p class="provenance">${esc(p.sourced)}</p>
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
        their mapped boundary, so check a recent water bill.</p>
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
    `<div class="fact"><dt>Wells within 1 mile</dt><dd>${c.wellCount}</dd></div>`,
    `<div class="fact"><dt>Typical well depth nearby</dt><dd>${
      c.medianDepth ? `${c.medianDepth} ft` : "Not recorded"
    }</dd></div>`,
    `<div class="fact"><dt>100-year supply determination</dt><dd>${
      c.aaws ? "On record for this area" : "None found for this address"
    }</dd></div>`,
  ];

  const wells = c.nearestWells && c.nearestWells.length
    ? `<h3 style="margin-top:1.25rem">Closest wells on record</h3>
       <ul class="wells-list">${c.nearestWells
         .map(
           (w) => `<li>
             <span class="w-dist">${w.miles.toFixed(2)} mi</span>
             <span class="w-meta">${
               w.depth ? `${w.depth} ft deep` : "depth not recorded"
             }${w.year ? ` · drilled ${w.year}` : ""}</span>
           </li>`
         )
         .join("")}</ul>`
    : "";

  return `
    <dl class="facts">${facts.join("")}</dl>
    ${wells}
    <p class="caveat">
      Wells come from ADWR's Wells55 registration database (every registered
      well, including exempt domestic ones) combined with its GWSI monitoring
      index, with sites within 60m of each other treated as one. GWSI also
      includes springs and wells predating the 1980 registry, so not every
      point is a registered well. Active Management Areas are the parts of
      Arizona with real groundwater regulation; most of the state sits
      outside one. A 100-year supply determination means a subdivision had to
      prove long-term water availability before approval.
    </p>`;
}

/*
 * A small OpenStreetMap slippy-map embed centred on one point.
 *
 * The iframe src is only built when the panel is opened (see the toggle
 * handler in render), because a results page can list a dozen points and
 * a dozen eagerly-loaded map frames is both slow and a dozen requests to
 * openstreetmap.org that most visitors never look at.
 */
function mapEmbedSrc(lat, lon, pad = 0.004) {
  const bbox = [lon - pad, lat - pad / 2, lon + pad, lat + pad / 2]
    .map((n) => n.toFixed(5))
    .join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;
}

function renderOsm(points, curatedToo) {
  if (!points.length) return "";
  const items = points
    .map(
      (p, i) => `
      <li>
        <div class="osm-row">
          <strong>${esc(p.name)}</strong>
          <span class="dist">${p.miles.toFixed(1)} mi</span>
          <span class="osm-kind">${esc(p.kind)}</span>
          ${p.operator ? `<span class="osm-kind">${esc(p.operator)}</span>` : ""}
          ${p.fee === "yes" ? `<span class="osm-kind">fee</span>` : ""}
          ${p.seasonal ? `<span class="osm-kind">seasonal</span>` : ""}
        </div>
        <details class="mapwrap" data-lat="${p.lat}" data-lon="${p.lon}">
          <summary>Show map</summary>
          <div class="mapslot" id="map-${i}"></div>
          <p class="provenance">
            <a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}"
               rel="noopener">Open in OpenStreetMap</a>
            ·
            <a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}"
               rel="noopener">Directions</a>
          </p>
        </details>
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

function renderHaulers(haulers) {
  if (!haulers.length) return "";
  const row = (h) => `
    <li class="hauler ${h.confidence}">
      <div class="hauler-top">
        <strong>${esc(h.name)}</strong>
        <span class="badge-conf ${h.confidence}">${
          h.confidence === "high" ? "Water hauler" : "May haul water"
        }</span>
      </div>
      <p class="hauler-meta">
        Based in ${esc(h.city || "Arizona")}${
          h.miles != null ? ` · about ${Math.round(h.miles)} mi away` : ""
        }${h.trucks ? ` · ${esc(String(h.trucks))} truck${h.trucks === "1" ? "" : "s"}` : ""}
      </p>
      ${
        h.phone
          ? `<p class="hauler-call"><a class="btn-call" href="tel:${esc(
              h.phone.replace(/[^\d+]/g, "")
            )}">Call ${esc(h.phone)}</a></p>`
          : `<p class="hauler-meta">No phone number on file. Look them up by USDOT ${esc(
              String(h.dot || "")
            )}.</p>`
      }
    </li>`;

  return `
    <div class="haulers">
      <h3>Water haulers near you</h3>
      <p class="caveat">
        Compiled from federal motor-carrier records, since Arizona publishes
        no statewide hauler list. Distance is measured from each company's
        registered address rather than a service area, so a hauler further
        out may still deliver to you. Details change, so call to confirm
        service to your road.
      </p>
      <ul class="hauler-list">${haulers.map(row).join("")}</ul>
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
       ${renderHaulers(r.haulers)}
       ${renderOsm(r.osm, false)}`
    : `<p class="tier-note">${esc(r.community.note)}</p>
       <div class="places">${r.places.map(renderPlace).join("")}</div>
       ${(r.community.also_see || [])
         .map(
           (s) =>
             `<p class="provenance" style="margin-top:1rem">Also worth checking:
              <a href="${esc(s.website)}" rel="noopener">${esc(s.name)}</a>. ${esc(s.what)}</p>`
         )
         .join("")}
       ${renderHaulers(r.haulers)}
       ${renderOsm(r.osm, true)}`;

  results.innerHTML = `
    <p class="matched">Showing results for ${esc(r.loc.matched)}${
      r.loc.approximate ? " (approximate location)" : ""
    }</p>

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

  // Map frames are built on first open. Eagerly embedding one per water
  // point would fire a dozen requests to openstreetmap.org for maps most
  // visitors never scroll to.
  results.querySelectorAll(".mapwrap").forEach((wrap) => {
    wrap.addEventListener("toggle", () => {
      const slot = wrap.querySelector(".mapslot");
      if (!wrap.open || slot.firstChild) return;
      const frame = document.createElement("iframe");
      frame.src = mapEmbedSrc(Number(wrap.dataset.lat), Number(wrap.dataset.lon));
      frame.loading = "lazy";
      frame.title = "Map of this water point";
      frame.referrerPolicy = "no-referrer";
      slot.appendChild(frame);
    });
  });

  // Tier 3's data is most of the page weight, so it's fetched the first
  // time someone actually opens the panel, not on every lookup.
  const details = document.getElementById("context");
  const body = document.getElementById("context-body");
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    try {
      const [ctx, wells] = await Promise.all([
        loadContext(),
        loadWellTiles(r.loc.lat, r.loc.lon),
      ]);
      body.innerHTML = contextFacts(lookupContext(r.loc, { ...ctx, wells }));
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
  const picked = pickedSuggestion;
  closeSuggestions();
  try {
    const d = await loadData();
    let loc;
    try {
      loc = await geocode(address);
    } catch (err) {
      // The Census geocoder doesn't know every rural address, and this
      // site exists for rural addresses. If the person picked a suggestion,
      // fall back to its coordinates rather than dead-ending them.
      if (err.message === "no-match" && picked) {
        loc = { lat: picked.lat, lon: picked.lon, matched: address, approximate: true };
      } else {
        throw err;
      }
    }
    render(lookup(loc, d));
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    const msg =
      err.message === "no-match"
        ? `We couldn't pin down that address. Try typing just the town, like "Rio Verde" or "Dolan Springs", and pick one of the suggestions.`
        : `Something went wrong looking that up. Check your connection and try again.`;
    results.innerHTML = `<p class="status error">${esc(msg)}</p>`;
  } finally {
    setBusy(false);
  }
}

/* ---------- address suggestions ---------- */

/*
 * Type-ahead uses Photon (OpenStreetMap-based, CORS-enabled, no API key).
 *
 * The Census geocoder stays the authority for the final answer because it
 * knows US address ranges, but it has no suggest endpoint and it flatly
 * fails on plenty of rural addresses -- which is this site's whole
 * audience. So Photon suggests, Census resolves, and if Census can't match
 * the address the coordinates from the chosen suggestion are used instead.
 * That combination is what lets someone type "Rio Verde" and still get an
 * answer.
 */
const PHOTON = "https://photon.komoot.io/api/";
// Roughly the centre of Arizona: biases results toward the state without
// hard-excluding a border town.
const AZ_BIAS = { lat: 34.3, lon: -111.7 };

let suggestBox, comboWrap;
let suggestions = [];
let activeIndex = -1;
let pickedSuggestion = null;
let suggestTimer = null;
let suggestAbort = null;

function labelFor(props) {
  const line1 = [props.housenumber, props.street || props.name].filter(Boolean).join(" ");
  const place = props.city || props.county;
  // For a town, Photon puts the same name in both `name` and `city`, which
  // renders as "Dolan Springs, Dolan Springs, Arizona". Drop the repeat.
  const line2 = [place === line1 ? null : place, props.state, props.postcode]
    .filter(Boolean)
    .join(", ");
  return { line1: line1 || props.name || "", line2 };
}

async function suggest(query) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  const url =
    `${PHOTON}?q=${encodeURIComponent(query)}&limit=6` +
    `&lat=${AZ_BIAS.lat}&lon=${AZ_BIAS.lon}&lang=en`;
  const r = await fetch(url, { signal: suggestAbort.signal });
  if (!r.ok) throw new Error("suggest-failed");
  const json = await r.json();
  return (json.features || [])
    // Arizona only: the site can't answer for anywhere else, so offering
    // a Texas match would just waste someone's time.
    .filter((f) => (f.properties || {}).state === "Arizona")
    .map((f) => ({
      ...labelFor(f.properties),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    }))
    .filter((s) => s.line1);
}

function closeSuggestions() {
  suggestions = [];
  activeIndex = -1;
  suggestBox.hidden = true;
  suggestBox.innerHTML = "";
  comboWrap.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function renderSuggestions() {
  if (!suggestions.length) return closeSuggestions();
  suggestBox.innerHTML = suggestions
    .map(
      (s, i) => `
      <li role="option" id="sug-${i}" tabindex="-1"
          aria-selected="${i === activeIndex}"
          class="${i === activeIndex ? "active" : ""}">
        <span class="sug-1">${esc(s.line1)}</span>
        <span class="sug-2">${esc(s.line2)}</span>
      </li>`
    )
    .join("");
  suggestBox.hidden = false;
  comboWrap.setAttribute("aria-expanded", "true");
  if (activeIndex >= 0) input.setAttribute("aria-activedescendant", `sug-${activeIndex}`);
  else input.removeAttribute("aria-activedescendant");
}

function choose(i) {
  const s = suggestions[i];
  if (!s) return;
  pickedSuggestion = s;
  input.value = [s.line1, s.line2].filter(Boolean).join(", ");
  closeSuggestions();
  form.requestSubmit();
}

function onType() {
  // Typing invalidates any previously picked suggestion, otherwise a stale
  // coordinate could answer for an address the person has since edited.
  pickedSuggestion = null;
  const q = input.value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 3) return closeSuggestions();
  suggestTimer = setTimeout(async () => {
    try {
      suggestions = await suggest(q);
      activeIndex = -1;
      renderSuggestions();
    } catch (e) {
      if (e.name !== "AbortError") closeSuggestions();
    }
  }, 220);
}

function onKeyDown(e) {
  if (suggestBox.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    activeIndex = (activeIndex + step + suggestions.length + 1) % (suggestions.length + 1);
    if (activeIndex === suggestions.length) activeIndex = -1;
    renderSuggestions();
  } else if (e.key === "Enter" && activeIndex >= 0) {
    e.preventDefault();
    choose(activeIndex);
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
}

/* ---------- use my location ---------- */

/*
 * Reverse-geocode only to put a human-readable label on the result. The
 * lookup itself uses the raw coordinates, so if this call fails the answer
 * is still correct, it just says "your location" instead of a town name.
 */
async function describeCoords(lat, lon) {
  try {
    const r = await fetch(`${PHOTON}reverse?lat=${lat}&lon=${lon}&limit=1&lang=en`);
    if (!r.ok) throw new Error("reverse-failed");
    const f = (await r.json()).features[0];
    const { line1, line2 } = labelFor((f && f.properties) || {});
    return [line1, line2].filter(Boolean).join(", ") || "your location";
  } catch {
    return "your location";
  }
}

function useMyLocation() {
  const status = document.getElementById("location-status");
  if (!navigator.geolocation) {
    status.textContent = "This browser can't share a location.";
    return;
  }
  status.textContent = "Asking your device…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      status.textContent = "";
      setBusy(true, "Finding water near you…");
      try {
        const d = await loadData();
        const matched = await describeCoords(lat, lon);
        render(lookup({ lat, lon, matched, approximate: true }, d));
        results.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch {
        results.innerHTML = `<p class="status error">Something went wrong. Try typing an address instead.</p>`;
      } finally {
        setBusy(false);
      }
    },
    (err) => {
      // Permission denied is a choice, not a fault: say what to do next
      // rather than showing a bare error.
      status.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location blocked. Type an address instead, or allow location in your browser settings."
          : "Couldn't get your location. Type an address instead.";
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
  );
}

/* ---------- browse ---------- */

function renderBrowse(haulers, { city, confidence, q }) {
  const needle = (q || "").trim().toLowerCase();
  return (haulers || []).filter(
    (h) =>
      (!city || h.city === city) &&
      (!confidence || h.confidence === confidence) &&
      (!needle || `${h.name} ${h.city}`.toLowerCase().includes(needle))
  );
}

// How many rows to show before the rest are folded away. The full list is
// 74 companies, which is a lot of scrolling past for someone who only
// wanted to check whether their county has anyone at all.
const BROWSE_PREVIEW = 5;

function browseRow(h) {
  return `
    <tr>
      <td>${esc(h.name)}</td>
      <td>${esc(h.city || "not listed")}</td>
      <td>${
        h.phone
          ? `<a href="tel:${esc(h.phone.replace(/[^\d+]/g, ""))}">${esc(h.phone)}</a>`
          : "not listed"
      }</td>
      <td><span class="badge-conf ${h.confidence}">${
        h.confidence === "high" ? "Water hauler" : "May haul water"
      }</span></td>
    </tr>`;
}

function browseMarkup(rows) {
  if (!rows.length) {
    return `<p class="status">Nothing matches that. Try clearing a filter.</p>`;
  }
  const head = `<tr><th scope="col">Name</th><th scope="col">Based in</th>
      <th scope="col">Phone</th><th scope="col">Type</th></tr>`;
  const shown = rows.slice(0, BROWSE_PREVIEW);
  const rest = rows.slice(BROWSE_PREVIEW);

  return `
    <table class="browse-table">
      <thead>${head}</thead>
      <tbody>${shown.map(browseRow).join("")}</tbody>
    </table>
    ${
      rest.length
        ? `<div class="browse-more">
             <button type="button" class="btn-load-more">
               Load more
             </button>
             <table class="browse-table browse-rest" hidden>
               <thead>${head}</thead>
               <tbody>${rest.map(browseRow).join("")}</tbody>
             </table>
           </div>`
        : ""
    }`;
}

function wireLoadMore(wrap) {
  const btn = wrap.querySelector(".btn-load-more");
  if (!btn) return;
  btn.addEventListener("click", () => {
    btn.classList.add("loading");
    btn.disabled = true;
    setTimeout(() => {
      wrap.querySelector(".browse-rest").hidden = false;
      btn.remove();
    }, 1300);
  });
}

async function initBrowse() {
  const wrap = document.getElementById("browse-results");
  const citySel = document.getElementById("browse-city");
  const confSel = document.getElementById("browse-conf");
  const qInput = document.getElementById("browse-q");
  const countEl = document.getElementById("browse-count");
  if (!wrap) return;

  const d = await loadData();
  const haulers = d.haulers.slice().sort((a, b) => a.name.localeCompare(b.name));

  [...new Set(haulers.map((h) => h.city).filter(Boolean))]
    .sort()
    .forEach((c) => citySel.add(new Option(c, c)));

  const draw = () => {
    const rows = renderBrowse(haulers, {
      city: citySel.value,
      confidence: confSel.value,
      q: qInput.value,
    });
    wrap.innerHTML = browseMarkup(rows);
    wireLoadMore(wrap);
    countEl.textContent = `${rows.length} of ${haulers.length}`;
  };

  citySel.addEventListener("change", draw);
  confSel.addEventListener("change", draw);
  qInput.addEventListener("input", draw);
  draw();
}

/* ---------- feedback ---------- */

// Built as plain text so the person can see exactly what they're sending
// before it leaves their machine. There is no server to post it to, which
// is deliberate: no backend means nothing to secure and nothing to leak.
function feedbackBody(v) {
  return [
    `What: ${v.kind}`,
    `Name: ${v.name || "(not given)"}`,
    `Area: ${v.where || "(not given)"}`,
    `Contact: ${v.contact || "(not given)"}`,
    "",
    "Details:",
    v.detail || "(none)",
    "",
    `Reply to: ${v.you || "(not given)"}`,
  ].join("\n");
}

function initFeedback() {
  const fb = document.getElementById("feedback-form");
  if (!fb) return;
  const status = document.getElementById("fb-status");
  const read = () => ({
    kind: fb.kind.value,
    name: fb.name.value,
    where: fb.where.value,
    contact: fb.contact.value,
    detail: fb.detail.value,
    you: fb.you.value,
  });

  fb.addEventListener("submit", (e) => e.preventDefault());

  document.getElementById("fb-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(feedbackBody(read()));
      status.textContent =
        "Copied! Now paste it into an email to sidaksmann@gmail.com.";
    } catch {
      status.textContent =
        "Couldn't copy automatically. Select the text in the boxes and copy it manually.";
    }
  });
}

/* ---------- events ---------- */

function init() {
  // The sub-pages (about, data, add a source) share this script but have no
  // search box, so every section wires itself only if it's actually present.
  initFeedback();
  initBrowse();

  form = document.getElementById("lookup");
  if (!form) return;

  results = document.getElementById("results");
  input = document.getElementById("address");
  submitBtn = document.getElementById("submit-btn");
  suggestBox = document.getElementById("suggestions");
  comboWrap = document.querySelector(".combo");

  form.addEventListener("submit", onSubmit);
  input.addEventListener("input", onType);
  input.addEventListener("keydown", onKeyDown);
  suggestBox.addEventListener("mousedown", (e) => {
    // mousedown, not click: blur would close the list first.
    const li = e.target.closest("li");
    if (li) {
      e.preventDefault();
      choose([...suggestBox.children].indexOf(li));
    }
  });
  document.addEventListener("click", (e) => {
    if (!comboWrap.contains(e.target)) closeSuggestions();
  });

  document.getElementById("try-example").addEventListener("click", () => {
    input.value = "17204 E Rio Verde Dr, Rio Verde, AZ 85263";
    pickedSuggestion = null;
    form.requestSubmit();
  });
  document.getElementById("use-location").addEventListener("click", useMyLocation);
}

function initCookieBanner() {
  if (localStorage.getItem("wmw-cookies-ok")) return;
  const bar = document.createElement("div");
  bar.className = "cookie-banner";
  bar.innerHTML = `
    <p>This site does not use cookies itself. Third-party services
    (Google Fonts, OpenStreetMap embeds) may set their own.
    <a href="privacy.html">Learn more</a></p>
    <button type="button" class="btn-cookie-ok">Got it</button>`;
  document.body.appendChild(bar);
  bar.querySelector(".btn-cookie-ok").addEventListener("click", () => {
    localStorage.setItem("wmw-cookies-ok", "1");
    bar.remove();
  });
}

if (typeof document !== "undefined") {
  init();
  initCookieBanner();
}

export {
  inRing, inPolygon, inFeature, findFeature, milesBetween,
  communityFor, nameOf, pwsidOf, lookup, nearestOsm, lookupContext,
  nearestHaulers, mapEmbedSrc, labelFor, renderBrowse, feedbackBody, tileKey,
};
