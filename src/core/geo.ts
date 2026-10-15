// Geographic helpers. World space: x = east (m), y = up (m), z = south (m) (three.js: north = -z).
// Local equirectangular projection around a movable origin (rebased for the online world).

export const R_EARTH = 6371008.8;
export const DEG = Math.PI / 180;
export const FT = 0.3048;
export const KT = 0.514444;
export const NM = 1852;

export interface LatLon { lat: number; lon: number }

export class Projection {
  lat0 = 0; lon0 = 0;
  mLat = 111132; mLon = 85000;
  constructor(lat0: number, lon0: number) { this.setOrigin(lat0, lon0); }
  setOrigin(lat0: number, lon0: number) {
    this.lat0 = lat0; this.lon0 = lon0;
    const p = lat0 * DEG;
    this.mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
    this.mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  }
  x(lon: number) { return (lon - this.lon0) * this.mLon; }
  z(lat: number) { return -(lat - this.lat0) * this.mLat; }
  lon(x: number) { return this.lon0 + x / this.mLon; }
  lat(z: number) { return this.lat0 - z / this.mLat; }
}

// Web-mercator tile math (XYZ scheme)
export const lon2tx = (lon: number, z: number) => (lon + 180) / 360 * 2 ** z;
export const lat2ty = (lat: number, z: number) => {
  const r = lat * DEG;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
export const tx2lon = (x: number, z: number) => x / 2 ** z * 360 - 180;
export const ty2lat = (y: number, z: number) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return Math.atan(Math.sinh(n)) / DEG;
};
export const tileSizeM = (z: number, lat: number) => 40075016.686 * Math.cos(lat * DEG) / 2 ** z;

export function haversine(a1: number, o1: number, a2: number, o2: number) {
  const dp = (a2 - a1) * DEG, dl = (o2 - o1) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a1 * DEG) * Math.cos(a2 * DEG) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearing(a1: number, o1: number, a2: number, o2: number) {
  const p1 = a1 * DEG, p2 = a2 * DEG, dl = (o2 - o1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
export function destination(lat: number, lon: number, brg: number, dist: number): LatLon {
  const d = dist / R_EARTH, b = brg * DEG, p1 = lat * DEG, l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: l2 / DEG };
}

// ISA atmosphere
export function atmosphere(h: number) {
  const hh = Math.max(-500, Math.min(h, 20000));
  let T: number, p: number;
  if (hh < 11000) { T = 288.15 - 0.0065 * hh; p = 101325 * (T / 288.15) ** 5.2559; }
  else { T = 216.65; p = 22632 * Math.exp(-(hh - 11000) / 6341.6); }
  const rho = p / (287.05 * T);
  return { T, p, rho, a: Math.sqrt(1.4 * 287.05 * T), sigma: rho / 1.225 };
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const wrap360 = (a: number) => ((a % 360) + 360) % 360;
export const wrap180 = (a: number) => ((a + 540) % 360) - 180;
export const approach = (v: number, target: number, rate: number) => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
