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

// Wells ship as bare [lat,lon] pairs to save payload; counting must match
// that shape, and must count a radius rather than a bounding box.
const ctx = lookupContext(
  { lat: 33.7415, lon: -111.709 },
  {
    ama: { features: [] },
    aaws: { features: [] },
    wells: [
      [33.7420, -111.7095], // ~0.04mi
      [33.7500, -111.7100], // ~0.6mi
      [34.5000, -111.7000], // ~52mi
    ],
  }
);
assert.equal(ctx.wellCount, 2, "counts wells within a mile, ignores the far one");
assert.equal(ctx.ama, null, "no AMA match -> null, rendered as 'outside any AMA'");

console.log("all geometry checks passed");
