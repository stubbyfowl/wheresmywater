/* Smallest thing that fails if the lookup geometry breaks.
 * Run: node site/test.mjs
 *
 * Point-in-polygon and distance bugs are silent -- a wrong answer still
 * renders a confident-looking result card -- so these check the cases that
 * actually bit during the build: holes, multipolygons, and the real
 * ADEQ_ID/CWS_NAME field names from ADWR.
 */
import assert from "node:assert/strict";
import {
  inRing, inPolygon, inFeature, findFeature, milesBetween,
  communityFor, nameOf, pwsidOf, nearestOsm, lookupContext,
  nearestHaulers, mapEmbedSrc, labelFor, lookup, renderBrowse, feedbackBody,
  tileKey,
} from "./script.js";

const square = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];

// basic containment
assert.equal(inRing(5, 5, square), true, "centre is inside");
assert.equal(inRing(15, 5, square), false, "east of the ring is outside");
assert.equal(inRing(-5, 5, square), false, "west of the ring is outside");

// a hole must exclude, or a service area with a carve-out reports the
// wrong provider for everyone standing in the hole
const hole = [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]];
assert.equal(inPolygon(5, 5, [square]), true, "no hole: inside");
assert.equal(inPolygon(5, 5, [square, hole]), false, "in hole: outside");
assert.equal(inPolygon(2, 2, [square, hole]), true, "outside hole, inside ring");

// multipolygon: providers are frequently split into disjoint areas
const multi = {
  type: "MultiPolygon",
  coordinates: [[square], [[[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]]]],
};
assert.equal(inFeature(22, 2, multi), true, "second polygon counts");
assert.equal(inFeature(15, 2, multi), false, "gap between polygons is outside");

// findFeature returns the containing feature, not just the first one
const fc = {
  features: [
    { properties: { CWS_NAME: "WRONG" }, geometry: { type: "Polygon", coordinates: [[[100, 100], [100, 101], [101, 101], [100, 100]]] } },
    { properties: { CWS_NAME: " RIO VERDE UTILITIES, INC. ", ADEQ_ID: "AZ0407051" }, geometry: { type: "Polygon", coordinates: [square] } },
  ],
};
const hit = findFeature(fc, 5, 5);
assert.equal(nameOf(hit, /CWS_NAME/i), "RIO VERDE UTILITIES, INC.", "name is found and trimmed");
assert.equal(pwsidOf(hit), "AZ0407051", "ADEQ_ID is read as the PWSID");
assert.equal(findFeature(fc, 50, 50), null, "no containing feature -> null (no provider)");

// distance: Rio Verde Dr to the EPCOR standpipe is a few miles, not hundreds
const d = milesBetween(33.7415, -111.709, 33.7385, -111.6989);
assert.ok(d > 0.4 && d < 1.2, `expected ~0.6mi, got ${d.toFixed(2)}`);
assert.ok(milesBetween(33.7, -111.7, 33.7, -111.7) === 0, "same point is zero");

// community bbox matching drives whether tier 1 shows anything at all
const dir = { communities: [{ id: "rvf", bbox: [-111.8, 33.68, -111.55, 33.86] }] };
assert.equal(communityFor(-111.709, 33.7415, dir).id, "rvf", "Rio Verde address matches");
assert.equal(communityFor(-112.07, 33.45, dir), null, "downtown Phoenix does not");

// Statewide fallback: nearest community-mapped points, closest first,
// and nothing absurdly far away dressed up as "nearby".
const osm = [
  { name: "Far", kind: "Drinking water", lat: 32.2, lon: -110.9 },   // ~100mi
  { name: "Close", kind: "Drinking water", lat: 33.745, lon: -111.71 },
  { name: "Middle", kind: "Water tap", lat: 33.85, lon: -111.75 },
];
const near = nearestOsm(33.7415, -111.709, osm);
assert.equal(near.length, 2, "the 100-mile point is excluded");
assert.equal(near[0].name, "Close", "closest comes first");
assert.ok(near[0].miles < near[1].miles, "sorted by distance");
assert.equal(nearestOsm(33.7415, -111.709, osm, 1).length, 1, "limit is honoured");
assert.deepEqual(nearestOsm(33.7, -111.7, []), [], "no points -> empty, not a crash");

// Tile keys MUST match build_wells55.py's tile_key(), or the browser asks
// for files the build never wrote and every well count silently reads 0.
// These expectations are duplicated in that script's --check.
assert.equal(tileKey(33.7415, -111.709, 0.5), "67_-224");
assert.equal(tileKey(33.9999, -111.709, 0.5), "67_-224");
assert.equal(tileKey(34.0001, -111.709, 0.5), "68_-224", "crossing a tile edge moves tiles");

// Wells ship as [lat,lon,depth,year] rows; counting must use a radius, not
// a bounding box, and must tolerate missing depths.
const ctx = lookupContext(
  { lat: 33.7415, lon: -111.709 },
  {
    ama: { features: [] },
    aaws: { features: [] },
    wells: [
      [33.7420, -111.7095, 300, 2001], // ~0.04mi
      [33.7500, -111.7100, 100, null], // ~0.6mi
      [33.7460, -111.7090, null, null], // ~0.31mi, depth unknown
      [34.5000, -111.7000, 500, 1990], // ~52mi, out of range
    ],
  }
);
assert.equal(ctx.wellCount, 3, "counts wells within a mile, ignores the far one");
assert.equal(ctx.ama, null, "no AMA match -> null, rendered as 'outside any AMA'");
assert.equal(ctx.nearestWells[0].depth, 300, "nearest well first");
assert.ok(ctx.nearestWells[0].miles < ctx.nearestWells[1].miles, "sorted by distance");
assert.equal(ctx.medianDepth, 300, "median ignores wells with no recorded depth");
const empty = lookupContext({ lat: 33.7, lon: -111.7 }, { ama: { features: [] }, aaws: { features: [] } });
assert.equal(empty.wellCount, 0, "no tiles loaded -> 0, not a crash");
assert.equal(empty.medianDepth, null);

// Haulers: high confidence outranks a merely-plausible closer one, because
// a wrong lead costs a wasted phone call.
const haulers = [
  { name: "Close but unsure", city: "A", confidence: "low", lat: 33.742, lon: -111.709 },
  { name: "Further but certain", city: "B", confidence: "high", lat: 33.80, lon: -111.75 },
  { name: "Way out of range", city: "C", confidence: "high", lat: 31.35, lon: -110.0 },
  { name: "No coordinates", city: "D", confidence: "high", lat: null, lon: null },
];
const nh = nearestHaulers(33.7415, -111.709, haulers);
assert.equal(nh[0].name, "Further but certain", "high confidence sorts first");
assert.ok(!nh.some((h) => h.name === "Way out of range"), "beyond 75mi is dropped");
assert.ok(nh.some((h) => h.name === "No coordinates"), "kept when it has no location");
assert.equal(nearestHaulers(33.7, -111.7, []).length, 0, "no haulers -> empty");
assert.equal(nearestHaulers(33.7, -111.7, haulers, 1).length, 1, "limit honoured");

// A curated entry and its FMCSA twin must not both appear.
const dedup = lookup(
  { lat: 33.7415, lon: -111.709 },
  {
    cws: { features: [] },
    violations: {},
    osm: [],
    directory: {
      communities: [{
        id: "rvf", bbox: [-111.8, 33.68, -111.55, 33.86], note: "",
        entries: [{ name: "Rio Verde Foothills Potable Water Hauling, LLC", lat: 33.73, lon: -111.84 }],
      }],
    },
    haulers: [
      { name: "RIO VERDE FOOTHILLS POTABLE WATER HAULING LLC", confidence: "high", lat: 33.73, lon: -111.84 },
      { name: "Sonoran Water Hauling LLC", confidence: "high", lat: 33.88, lon: -112.13 },
    ],
  }
);
assert.equal(dedup.haulers.length, 1, "the curated company is not repeated as a lead");
assert.equal(dedup.haulers[0].name, "Sonoran Water Hauling LLC");
assert.equal(dedup.places.length, 1, "curated entry survives");

// Map embed must put the marker inside its own bbox, or the pin lands off
// the visible map.
const src = mapEmbedSrc(33.7385, -111.6989);
const bbox = new URL(src).searchParams.get("bbox").split(",").map(Number);
const [bl, bb, br, bt] = bbox;
assert.ok(bl < -111.6989 && br > -111.6989, "marker lon inside bbox");
assert.ok(bb < 33.7385 && bt > 33.7385, "marker lat inside bbox");
assert.ok(new URL(src).searchParams.get("marker").startsWith("33.7385"), "marker set");

// Suggestion labels: a town with no street still has to render something.
assert.deepEqual(
  labelFor({ housenumber: "17204", street: "E Rio Verde Dr", city: "Rio Verde", state: "Arizona", postcode: "85263" }),
  { line1: "17204 E Rio Verde Dr", line2: "Rio Verde, Arizona, 85263" }
);
assert.equal(labelFor({ name: "Dolan Springs", state: "Arizona" }).line1, "Dolan Springs");
// Photon repeats a town's name in both `name` and `city`; don't echo it.
assert.deepEqual(
  labelFor({ name: "Dolan Springs", city: "Dolan Springs", state: "Arizona", postcode: "86441" }),
  { line1: "Dolan Springs", line2: "Arizona, 86441" }
);

// Browse filters combine rather than override each other.
const all = [
  { name: "Kingman Water Hauling", city: "Kingman", confidence: "high" },
  { name: "Kingman Maybe Water", city: "Kingman", confidence: "low" },
  { name: "Payson Water Trucks", city: "Payson", confidence: "high" },
];
assert.equal(renderBrowse(all, {}).length, 3, "no filters -> everything");
assert.equal(renderBrowse(all, { city: "Kingman" }).length, 2, "city filter");
assert.equal(
  renderBrowse(all, { city: "Kingman", confidence: "high" }).length, 1,
  "city AND confidence both apply"
);
assert.equal(renderBrowse(all, { q: "payson" }).length, 1, "search is case-insensitive");
assert.equal(renderBrowse(all, { q: "  PAYSON " }).length, 1, "search trims whitespace");
assert.equal(renderBrowse(all, { q: "nonesuch" }).length, 0, "no match -> empty");
assert.equal(renderBrowse(undefined, {}).length, 0, "missing data -> empty, not a crash");

// The feedback body must survive empty fields rather than emitting
// "undefined" into someone's email.
const body = feedbackBody({ kind: "A water source you're missing", name: "", detail: "" });
assert.ok(!body.includes("undefined"), "no undefined leaks into the message");
assert.ok(body.includes("(not given)"), "blank fields are labelled");
assert.ok(feedbackBody({ kind: "x", detail: "hauls potable" }).includes("hauls potable"));

console.log("all geometry checks passed");
