// Builds compact airport/runway data from OurAirports CSV (public domain).
// Output: public/data/airports.json  ->  { v, airports: [[ident, name, type, lat, lon, elevFt, runways[]]] }
// runway: [leId, heId, leLat, leLon, heLat, heLon, lengthM, widthM, leDispM, heDispM, surface]
import fs from 'node:fs';
import path from 'node:path';

const RAW = 'data-raw';
const OUT = 'public/data/airports.json';
const SRC = 'https://davidmegginson.github.io/ourairports-data/';

async function load(name) {
  const p = path.join(RAW, name);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(RAW, { recursive: true });
    const r = await fetch(SRC + name);
    if (!r.ok) throw new Error(name + ' ' + r.status);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return fs.readFileSync(p, 'utf8');
}

function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift();
  return rows.filter(r => r.length > 3).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const R_EARTH = 6371008.8;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function dest(lat, lon, brg, dist) {
  const d = dist / R_EARTH, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), deg(l2)];
}
function dist(a1, o1, a2, o2) {
  const dp = rad(a2 - a1), dl = rad(o2 - o1);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

const PAVED = /ASP|CON|PEM|BIT|asphalt|concrete|paved|tarmac|PAV/i;
const ft = v => (v === '' || v == null ? NaN : +v);
const r5 = v => Math.round(v * 1e5) / 1e5;

const airports = parseCSV(await load('airports.csv'));
const runways = parseCSV(await load('runways.csv'));
const byAp = new Map();
for (const r of runways) {
  if (r.closed === '1') continue;
  if (!PAVED.test(r.surface)) continue;
  const len = ft(r.length_ft);
  if (!(len >= 2600)) continue;
  (byAp.get(r.airport_ident) ?? byAp.set(r.airport_ident, []).get(r.airport_ident)).push(r);
}

const out = [];
for (const a of airports) {
  if (!/large_airport|medium_airport|small_airport/.test(a.type)) continue;
  const rs = byAp.get(a.ident);
  if (!rs) continue;
  const lat = +a.latitude_deg, lon = +a.longitude_deg;
  const list = [];
  for (const r of rs) {
    const lenM = ft(r.length_ft) * 0.3048;
    const widM = Math.max(18, (ft(r.width_ft) || 98) * 0.3048);
    let la1 = ft(r.le_latitude_deg), lo1 = ft(r.le_longitude_deg), la2 = ft(r.he_latitude_deg), lo2 = ft(r.he_longitude_deg);
    if (!(isFinite(la1) && isFinite(la2) && isFinite(lo1) && isFinite(lo2)) || dist(la1, lo1, la2, lo2) < 300) {
      let hdg = ft(r.le_heading_degT);
      if (!isFinite(hdg)) { const m = /^(\d{1,2})/.exec(r.le_ident); if (!m) continue; hdg = +m[1] * 10; }
      [la1, lo1] = dest(lat, lon, hdg + 180, lenM / 2);
      [la2, lo2] = dest(lat, lon, hdg, lenM / 2);
    } else {
      // keep listed length consistent with endpoint geometry
    }
    list.push([r.le_ident || '?', r.he_ident || '?', r5(la1), r5(lo1), r5(la2), r5(lo2), Math.round(lenM), Math.round(widM),
      Math.round((ft(r.le_displaced_threshold_ft) || 0) * 0.3048), Math.round((ft(r.he_displaced_threshold_ft) || 0) * 0.3048),
      /CON|PEM|concrete/i.test(r.surface) ? 1 : 0]);
  }
  if (!list.length) continue;
  const t = a.type === 'large_airport' ? 2 : a.type === 'medium_airport' ? 1 : 0;
  out.push([a.ident, a.name, t, r5(lat), r5(lon), Math.round(ft(a.elevation_ft) || 0), list, a.municipality || '', a.iso_country]);
}
out.sort((x, y) => y[2] - x[2]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ v: 1, src: 'OurAirports (public domain)', airports: out }));
console.log(`airports: ${out.length}, size ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
