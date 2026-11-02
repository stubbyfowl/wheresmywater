/* flood.js: live NWS alerts, USGS gages, and FEMA flood zones for Arizona.
 * All data fetched client-side from public APIs. No backend.
 */

import { geocode, setupAutocomplete, esc } from "./geocode.js";

const NWS_POINT = "https://api.weather.gov/alerts/active?point=";
const NWS_AZ = "https://api.weather.gov/alerts/active?area=AZ";
const USGS_GAGES = "https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=az&parameterCd=00060,00065&siteStatus=active";
const FEMA_EXPORT = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export";
const FEMA_LAYER = 28;

const FLOOD_EVENTS = [
  "Flash Flood Emergency",
  "Flash Flood Warning",
  "Flood Warning",
  "Flood Advisory",
  "Flash Flood Watch",
  "Flood Watch",
];

const SEVERITY_COLOR = {
  "Flash Flood Emergency": "#7b0000",
  "Flash Flood Warning": "#cc0000",
  "Flood Warning": "#ee4444",
  "Flood Advisory": "#ddaa00",
  "Flash Flood Watch": "#ee8800",
  "Flood Watch": "#ee8800",
};

const cache = new Map();
const CACHE_TTL = 90_000;

async function cached(url, headers) {
  const key = url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

/* ---------- time formatting ---------- */

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    month: "short",
    day: "numeric",
  });
}

function fmtNow() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/* ---------- A. alerts for address ---------- */

async function fetchPointAlerts(lat, lon) {
  const url = `${NWS_POINT}${lat.toFixed(4)},${lon.toFixed(4)}`;
  const data = await cached(url, { Accept: "application/geo+json" });
  return (data.features || [])
    .filter((f) => FLOOD_EVENTS.includes(f.properties.event))
    .sort((a, b) => FLOOD_EVENTS.indexOf(a.properties.event) - FLOOD_EVENTS.indexOf(b.properties.event));
}

function renderPointAlerts(alerts, container) {
  if (!alerts.length) {
    container.innerHTML = `
      <div class="flood-empty">
        <p>No active flood alerts for this location as of ${fmtNow()} (Phoenix time).</p>
        <p class="flood-caveat">No alert does not mean no risk. Never drive into flooded roads.</p>
      </div>`;
    return;
  }
  container.innerHTML = alerts
    .map((f) => {
      const p = f.properties;
      const color = SEVERITY_COLOR[p.event] || "#999";
      return `
      <article class="flood-alert" style="border-left-color:${color}">
        <h3>${esc(p.event)}</h3>
        <p class="flood-headline">${esc(p.headline || "")}</p>
        <dl class="flood-meta">
          <dt>Effective</dt><dd>${fmtTime(p.effective)}</dd>
          <dt>Expires</dt><dd>${fmtTime(p.expires)}</dd>
          <dt>Area</dt><dd>${esc(p.areaDesc || "")}</dd>
        </dl>
        ${p.instruction ? `<div class="flood-instruction"><strong>What to do:</strong> ${esc(p.instruction)}</div>` : ""}
        <a href="${esc(p["@id"] || "")}" rel="noopener" class="flood-source">View on NWS &#8599;</a>
      </article>`;
    })
    .join("");
}

/* ---------- B. statewide map ---------- */

let map, markerLayer, alertLayer, gageLayer, femaLayer;
let gageData = null;
const zoneCache = new Map();

function setMapStatus(message, tone = "loading") {
  const el = document.getElementById("flood-map-status");
  const dot = document.querySelector(".flood-live-dot");
  if (el) el.textContent = message;
  if (dot) dot.dataset.state = tone;
}

function initMap() {
  if (map) return;
  const el = document.getElementById("flood-map");
  if (!el) return;

  if (!window.L) {
    el.innerHTML = '<p class="flood-map-fallback">The interactive map could not load. <a href="https://afws.org/" target="_blank" rel="noopener">Open the Arizona Flood Warning System ↗</a></p>';
    setMapStatus("Live map unavailable — use the Arizona Flood Warning System link.", "error");
    return;
  }

  // Leaflet supplies the map canvas; remove the no-JavaScript loading copy so
  // it never sits on top of the usable map once the library is ready.
  el.innerHTML = "";
  map = L.map(el, { zoomControl: true, scrollWheelZoom: true }).setView([34.3, -111.7], 7);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  alertLayer = L.layerGroup().addTo(map);
  gageLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  femaLayer = L.tileLayer(
    `${FEMA_EXPORT}?bbox={xmin},{ymin},{xmax},{ymax}&size=256,256&format=png32&transparent=true&layers=show:${FEMA_LAYER}&f=image&bboxSR=4326&imageSR=4326`,
    { opacity: 0.45, attribution: "FEMA NFHL" }
  );
  // FEMA uses a non-standard tile URL pattern; use dynamic image overlay instead
  femaLayer = L.tileLayer.wms(
    "https://hazards.fema.gov/arcgis/services/public/NFHL/MapServer/WMSServer",
    {
      layers: "28",
      format: "image/png",
      transparent: true,
      opacity: 0.45,
      attribution: "FEMA NFHL",
    }
  );

  const overlays = {
    "USGS stream gages": gageLayer,
    "FEMA mapped flood zones": femaLayer,
  };
  L.control.layers(null, overlays, { collapsed: true }).addTo(map);

  loadLiveMapData();
  requestAnimationFrame(() => map.invalidateSize());
}

async function loadLiveMapData() {
  setMapStatus("Refreshing live statewide data…", "loading");
  const results = await Promise.allSettled([loadStateAlerts(), loadGages()]);
  const alertOk = results[0].status === "fulfilled";
  const gageOk = results[1].status === "fulfilled";
  if (alertOk && gageOk) setMapStatus("Live statewide data loaded", "ready");
  else if (alertOk || gageOk) setMapStatus("Some live map data is unavailable. Try refreshing.", "warning");
  else setMapStatus("Live map data is unavailable. Try refreshing or use AFWS.", "error");
  const ts = document.getElementById("flood-updated");
  if (ts) ts.textContent = `Updated ${fmtNow()} MST`;
}

async function loadStateAlerts() {
  try {
    // The NWS endpoint's event filter is single-value; fetch Arizona alerts
    // and filter locally so every flood alert type is represented.
    const url = NWS_AZ;
    const data = await cached(url, { Accept: "application/geo+json" });
    alertLayer.clearLayers();
    const textList = [];

    for (const f of (data.features || []).filter((feature) => FLOOD_EVENTS.includes(feature.properties?.event))) {
      const p = f.properties;
      const color = SEVERITY_COLOR[p.event] || "#999";
      const popup = `<strong>${esc(p.event)}</strong><br>${esc(p.headline || "")}<br><em>Expires ${fmtTime(p.expires)}</em>${p.instruction ? "<br>" + esc(p.instruction).slice(0, 300) : ""}`;

      if (f.geometry && f.geometry.coordinates) {
        const coords = f.geometry.type === "Polygon"
          ? [f.geometry.coordinates[0].map(([ln, lt]) => [lt, ln])]
          : f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates.map((poly) => poly[0].map(([ln, lt]) => [lt, ln]))
          : null;
        if (coords) {
          for (const ring of coords) {
            L.polygon(ring, { color, weight: 2, fillOpacity: 0.25 })
              .bindPopup(popup)
              .addTo(alertLayer);
          }
        }
      } else if (p.affectedZones) {
        for (const zUrl of p.affectedZones) {
          drawZone(zUrl, color, popup);
        }
      }

      textList.push({ event: p.event, headline: p.headline, expires: p.expires, area: p.areaDesc });
    }

    renderAlertList(textList);
    return textList.length;
  } catch (e) {
    console.warn("Could not load statewide alerts", e);
    renderAlertList([]);
    throw e;
  }
}

async function drawZone(url, color, popup) {
  try {
    let geom = zoneCache.get(url);
    if (!geom) {
      const data = await fetch(url, { headers: { Accept: "application/geo+json" } }).then((r) => r.json());
      geom = data.geometry;
      zoneCache.set(url, geom);
    }
    if (!geom || !geom.coordinates) return;
    const coords = geom.type === "Polygon"
      ? [geom.coordinates[0].map(([ln, lt]) => [lt, ln])]
      : geom.type === "MultiPolygon"
      ? geom.coordinates.map((poly) => poly[0].map(([ln, lt]) => [lt, ln]))
      : null;
    if (coords) {
      for (const ring of coords) {
        L.polygon(ring, { color, weight: 1.5, fillOpacity: 0.2 })
          .bindPopup(popup)
          .addTo(alertLayer);
      }
    }
  } catch {
    // zone fetch failed; skip silently
  }
}

async function loadGages() {
  try {
    const data = await cached(USGS_GAGES);
    gageLayer.clearLayers();
    gageData = [];
    const ts = data.value?.timeSeries || [];
    const sites = new Map();

    for (const s of ts) {
      const info = s.sourceInfo;
      const no = info?.siteCode?.[0]?.value;
      if (!no) continue;
      if (!sites.has(no)) {
        sites.set(no, {
          no,
          name: info.siteName || no,
          lat: info.geoLocation?.geogLocation?.latitude,
          lon: info.geoLocation?.geogLocation?.longitude,
        });
      }
      const site = sites.get(no);
      const val = s.values?.[0]?.value?.[0];
      const param = s.variable?.variableCode?.[0]?.value;
      if (val) {
        const reading = { value: val.value, time: val.dateTime };
        if (param === "00065") site.gageHeight = reading;
        if (param === "00060") site.discharge = reading;
      }
    }

    const now = Date.now();
    for (const site of sites.values()) {
      if (!site.lat || !site.lon) continue;
      const latest = site.gageHeight || site.discharge;
      const readTime = latest ? new Date(latest.time) : null;
      const stale = readTime && (now - readTime.getTime()) > 3 * 3600_000;
      const staleTag = stale ? ' <span class="gage-stale">(stale)</span>' : "";

      const popup = `<strong>${esc(site.name)}</strong><br>` +
        (site.discharge ? `Discharge: ${site.discharge.value} cfs<br>` : "") +
        (site.gageHeight ? `Gage height: ${site.gageHeight.value} ft<br>` : "") +
        (readTime ? `Reading: ${fmtTime(readTime.toISOString())}${staleTag}<br>` : "") +
        `<a href="https://waterdata.usgs.gov/monitoring-location/${site.no}/" rel="noopener">USGS site &#8599;</a>`;

      const marker = L.circleMarker([site.lat, site.lon], {
        radius: 5,
        color: stale ? "#999" : "#1268c3",
        fillColor: stale ? "#ccc" : "#4a9aea",
        fillOpacity: 0.8,
        weight: 1.5,
      }).bindPopup(popup);

      marker.addTo(gageLayer);
      gageData.push(site);
    }
    return gageData.length;
  } catch (e) {
    console.warn("Could not load USGS gages", e);
    throw e;
  }
}

function renderAlertList(alerts) {
  const el = document.getElementById("flood-alert-list");
  if (!el) return;
  if (!alerts.length) {
    el.innerHTML = "<p>No active flood-type alerts for Arizona right now.</p>";
    return;
  }
  el.innerHTML = `<ul class="flood-text-list">${alerts.map((a) =>
    `<li><strong>${esc(a.event)}</strong>: ${esc(a.headline || a.area || "")} (expires ${fmtTime(a.expires)})</li>`
  ).join("")}</ul>`;
}

function flyTo(lat, lon, label) {
  if (!map) return;
  markerLayer.clearLayers();
  const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  map.flyTo([lat, lon], 11, { animate: motionOk, duration: 1.2 });
  L.marker([lat, lon]).addTo(markerLayer).bindPopup(esc(label)).openPopup();
}

/* ---------- auto-refresh ---------- */

let refreshTimer = null;
let currentLat = null;
let currentLon = null;

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentLat != null) doPointLookup(currentLat, currentLon, true);
    loadLiveMapData();
  }, 120_000);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function doPointLookup(lat, lon, silent) {
  const container = document.getElementById("flood-point-results");
  if (!container) return;
  if (!silent) container.innerHTML = `<p class="flood-loading">Checking NWS alerts...</p>`;
  try {
    const alerts = await fetchPointAlerts(lat, lon);
    renderPointAlerts(alerts, container);
  } catch (e) {
    container.innerHTML = `
      <div class="flood-error">
        <p>Could not reach the National Weather Service. Try again shortly, or check directly:</p>
        <ul>
          <li><a href="https://www.weather.gov/psr/" rel="noopener">NWS Phoenix &#8599;</a></li>
          <li><a href="https://www.weather.gov/fgz/" rel="noopener">NWS Flagstaff &#8599;</a></li>
        </ul>
      </div>`;
  }
  const ts = document.getElementById("flood-updated");
  if (ts) ts.textContent = `Updated ${fmtNow()}`;
}

/* ---------- init ---------- */

function init() {
  const formEl = document.getElementById("flood-lookup");
  if (!formEl) return;

  const inputEl = document.getElementById("flood-address");
  const suggestEl = document.getElementById("flood-suggestions");
  const comboEl = document.querySelector("#flood-lookup .combo");
  const submitBtn = document.getElementById("flood-submit");
  const resultsWrap = document.getElementById("flood-point-results");

  setupAutocomplete({
    inputEl,
    suggestEl,
    comboEl,
    formEl,
    onSubmit(lat, lon, label) {
      currentLat = lat;
      currentLon = lon;
      doPointLookup(lat, lon);
      flyTo(lat, lon, label);
      startRefresh();
      submitBtn.disabled = false;
      submitBtn.textContent = "Check alerts";
    },
    onError(msg) {
      resultsWrap.innerHTML = `<p class="status error">${esc(msg)}</p>`;
      submitBtn.disabled = false;
      submitBtn.textContent = "Check alerts";
    },
    onBusy(busy) {
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Checking..." : "Check alerts";
    },
  });

  document.getElementById("flood-refresh")?.addEventListener("click", () => {
    if (currentLat != null) doPointLookup(currentLat, currentLon);
    loadLiveMapData();
  });

  // Check for preloaded lat/lon from query string
  const params = new URLSearchParams(location.search);
  const qLat = parseFloat(params.get("lat"));
  const qLon = parseFloat(params.get("lon"));
  const qLabel = params.get("q") || "";
  if (qLat && qLon && !isNaN(qLat) && !isNaN(qLon)) {
    currentLat = qLat;
    currentLon = qLon;
    if (qLabel) inputEl.value = qLabel;
    doPointLookup(qLat, qLon);
    setTimeout(() => {
      flyTo(qLat, qLon, qLabel || "Your location");
    }, 500);
    startRefresh();
  }

  initMap();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentLat != null) {
      doPointLookup(currentLat, currentLon, true);
    }
  });
}

if (typeof document !== "undefined") {
  init();
}
