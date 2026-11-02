/* Shared geocode + autocomplete logic used by both the main lookup and the
 * flood page. Factored out so neither page copy-pastes the other.
 *
 * Usage:
 *   import { geocode, suggest, labelFor, setupAutocomplete } from './geocode.js';
 */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const PHOTON = "https://photon.komoot.io/api/";
const AZ_BIAS = { lat: 34.3, lon: -111.7 };

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

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

function labelFor(props) {
  const line1 = [props.housenumber, props.street || props.name].filter(Boolean).join(" ");
  const place = props.city || props.county;
  const line2 = [place === line1 ? null : place, props.state, props.postcode]
    .filter(Boolean)
    .join(", ");
  return { line1: line1 || props.name || "", line2 };
}

async function suggest(query) {
  const ac = new AbortController();
  const url =
    `${PHOTON}?q=${encodeURIComponent(query)}&limit=6` +
    `&lat=${AZ_BIAS.lat}&lon=${AZ_BIAS.lon}&lang=en`;
  const r = await fetch(url, { signal: ac.signal });
  if (!r.ok) throw new Error("suggest-failed");
  const json = await r.json();
  return (json.features || [])
    .filter((f) => (f.properties || {}).state === "Arizona")
    .map((f) => ({
      ...labelFor(f.properties),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    }))
    .filter((s) => s.line1);
}

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

/**
 * Wire up an address input + suggestions listbox + submit button as an
 * autocomplete form. Returns an object with a .destroy() for cleanup.
 *
 * opts.onSubmit(lat, lon, label) is called when the user submits.
 * opts.onError(msg) is called on geocode failure.
 * opts.onBusy(busy, msg) is called with true/false during geocode.
 */
function setupAutocomplete(opts) {
  const { inputEl, suggestEl, comboEl, formEl } = opts;
  let suggestions = [];
  let activeIndex = -1;
  let pickedSuggestion = null;
  let suggestTimer = null;

  function closeSuggestions() {
    suggestions = [];
    activeIndex = -1;
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    comboEl.setAttribute("aria-expanded", "false");
    inputEl.removeAttribute("aria-activedescendant");
  }

  function renderSuggestions() {
    if (!suggestions.length) return closeSuggestions();
    suggestEl.innerHTML = suggestions
      .map(
        (s, i) => `
        <li role="option" id="fsug-${i}" tabindex="-1"
            aria-selected="${i === activeIndex}"
            class="${i === activeIndex ? "active" : ""}">
          <span class="sug-1">${esc(s.line1)}</span>
          <span class="sug-2">${esc(s.line2)}</span>
        </li>`
      )
      .join("");
    suggestEl.hidden = false;
    comboEl.setAttribute("aria-expanded", "true");
    if (activeIndex >= 0) inputEl.setAttribute("aria-activedescendant", `fsug-${activeIndex}`);
    else inputEl.removeAttribute("aria-activedescendant");
  }

  function choose(i) {
    const s = suggestions[i];
    if (!s) return;
    pickedSuggestion = s;
    inputEl.value = [s.line1, s.line2].filter(Boolean).join(", ");
    closeSuggestions();
    formEl.requestSubmit();
  }

  function onType() {
    pickedSuggestion = null;
    const q = inputEl.value.trim();
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
    if (suggestEl.hidden) return;
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

  async function onSubmit(e) {
    e.preventDefault();
    const address = inputEl.value.trim();
    if (!address) return;
    if (opts.onBusy) opts.onBusy(true, "Looking up your address...");
    const picked = pickedSuggestion;
    closeSuggestions();
    try {
      let loc;
      try {
        loc = await geocode(address);
      } catch (err) {
        if (err.message === "no-match" && picked) {
          loc = { lat: picked.lat, lon: picked.lon, matched: address, approximate: true };
        } else {
          throw err;
        }
      }
      if (opts.onSubmit) opts.onSubmit(loc.lat, loc.lon, loc.matched || address);
    } catch (err) {
      const msg =
        err.message === "no-match"
          ? `We couldn't pin down that address. Try typing just the town and picking a suggestion.`
          : `Something went wrong looking that up. Check your connection and try again.`;
      if (opts.onError) opts.onError(msg);
    } finally {
      if (opts.onBusy) opts.onBusy(false);
    }
  }

  inputEl.addEventListener("input", onType);
  inputEl.addEventListener("keydown", onKeyDown);
  formEl.addEventListener("submit", onSubmit);
  suggestEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) {
      e.preventDefault();
      choose([...suggestEl.children].indexOf(li));
    }
  });
  document.addEventListener("click", (e) => {
    if (!comboEl.contains(e.target)) closeSuggestions();
  });

  return { closeSuggestions, destroy() {} };
}

export { geocode, suggest, labelFor, describeCoords, setupAutocomplete, esc };
