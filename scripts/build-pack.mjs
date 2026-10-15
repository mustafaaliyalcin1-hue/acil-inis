// Offline world pack builder for the Marmara region.
// Downloads EOX Sentinel-2 cloudless imagery (CC BY-NC-SA 4.0, attribution required) and
// AWS open Terrain Tiles (terrarium), re-encodes imagery to WebP, and writes integrity-checked chunks.
//   node scripts/build-pack.mjs [--estimate] [--out public/pack] [--limit-airports N]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ESTIMATE = args.includes('--estimate');
const OUT = opt('--out', 'pack-out');
const CACHE = 'pack-cache';
const region = JSON.parse(fs.readFileSync('src/data/region.json', 'utf8'));
const apData = JSON.parse(fs.readFileSync('public/data/airports.json', 'utf8')).airports;
let airports = region.airports.map(id => apData.find(a => a[0] === id)).filter(Boolean);
if (opt('--limit-airports')) airports = airports.slice(0, +opt('--limit-airports'));
if (airports.length !== region.airports.length && !opt('--limit-airports')) throw new Error('missing airports');

const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
const { south, north, west, east } = region.bbox;

function tilesInBox(z, s, n, w, e) {
  const out = [];
  const x0 = Math.floor(lon2x(w, z)), x1 = Math.floor(lon2x(e, z));
  const y0 = Math.floor(lat2y(n, z)), y1 = Math.floor(lat2y(s, z));
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}
function tilesNear(z, radius) {
  const set = new Map();
  for (const a of airports) {
    const lat = a[3], lon = a[4];
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    for (const t of tilesInBox(z, lat - dLat, lat + dLat, lon - dLon, lon + dLon)) {
      // keep tiles whose centre is inside the radius (+half tile diagonal)
      const clat = y2lat(t[2] + 0.5, z), clon = x2lon(t[1] + 0.5, z);
      const dx = (clon - lon) * 111320 * Math.cos(lat * Math.PI / 180), dy = (clat - lat) * 111320;
      const half = 40075016 * Math.cos(lat * Math.PI / 180) / 2 ** z * 0.71;
      if (Math.hypot(dx, dy) <= radius + half) set.set(t.join('/'), t);
    }
  }
  return [...set.values()];
}

const jobs = [];
if (region.wide) {
  const w = region.wide.bbox;
  for (const z of region.wide.imagery) for (const t of tilesInBox(z, w.south, w.north, w.west, w.east)) jobs.push(['i', ...t]);
  for (const z of region.wide.elevation) for (const t of tilesInBox(z, w.south, w.north, w.west, w.east)) jobs.push(['e', ...t]);
}
for (const z of region.imagery.full) for (const t of tilesInBox(z, south, north, west, east)) jobs.push(['i', ...t]);
for (const [z, r] of region.imagery.near) for (const t of tilesNear(z, r)) jobs.push(['i', ...t]);
for (const z of region.elevation.full) for (const t of tilesInBox(z, south, north, west, east)) jobs.push(['e', ...t]);
for (const [z, r] of region.elevation.near) for (const t of tilesNear(z, r)) jobs.push(['e', ...t]);
const uniq = new Map(jobs.map(j => [j.join('/'), j]));
const list = [...uniq.values()];
const count = {};
for (const j of list) count[j[0] + j[1]] = (count[j[0] + j[1]] || 0) + 1;
console.log('tiles:', list.length, JSON.stringify(count));

const UA = { headers: { 'User-Agent': 'AcilInis-OfflinePack/1.0 (personal non-commercial PWA)', Referer: 'https://github.com/' } };
function url(kind, z, x, y) {
  return kind === 'i'
    ? region.imagery.url.replace('{layer}', region.imagery.layer).replace('{z}', z).replace('{y}', y).replace('{x}', x)
    : region.elevation.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}
async function fetchRaw(kind, z, x, y) {
  const cp = path.join(CACHE, kind, String(z), `${x}_${y}`);
  if (fs.existsSync(cp)) return fs.readFileSync(cp);
  let err;
  for (let i = 0; i < 7; i++) {
    try {
      const r = await fetch(url(kind, z, x, y), UA);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, b);
      return b;
    } catch (e) { err = e; await new Promise(s => setTimeout(s, 400 * 2 ** i)); }
  }
  throw new Error(`fetch failed ${kind}/${z}/${x}/${y}: ${err?.cause?.code || err?.message}`);
}
async function encode(kind, raw) {
  if (kind === 'i') return sharp(raw).webp({ quality: region.imagery.webpQuality, effort: 4 }).toBuffer();
  // terrarium: h = R*256 + G + B/256 - 32768. Quantise to 1 m and flatten the sea floor below -40 m.
  // The blue channel is re-used as a WATER MASK (255 = water): sea (h <= 0) plus lakes, which SRTM
  // stores perfectly flat (identical raw values over a 5x5 window), dilated by 2 px.
  const { data, info } = await sharp(raw).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, Hh = info.height, n = W * Hh;
  const rawv = new Int32Array(n), hq = new Int32Array(n), wm = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rawv[i] = data[i * 3] * 65536 + data[i * 3 + 1] * 256 + data[i * 3 + 2];
    const h = data[i * 3] * 256 + data[i * 3 + 1] + data[i * 3 + 2] / 256 - 32768;
    hq[i] = Math.max(-40, Math.round(h));
    if (h <= 0.5) wm[i] = 1;
  }
  for (let y = 2; y < Hh - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x; if (wm[i]) continue;
    const v = rawv[i]; let flat = true;
    for (let dy = -2; dy <= 2 && flat; dy++) for (let dx = -2; dx <= 2; dx++) if (rawv[i + dy * W + dx] !== v) { flat = false; break; }
    if (flat) wm[i] = 2;
  }
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let wet = wm[i] === 1;
    for (let dy = -2; dy <= 2 && !wet; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < Hh && xx >= 0 && xx < W && wm[yy * W + xx] === 2) { wet = true; break; }
    }
    const h = hq[i] + 32768;
    data[i * 3] = h >> 8; data[i * 3 + 1] = h & 255; data[i * 3 + 2] = wet ? 255 : 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

async function pool(items, n, fn) {
  let i = 0, done = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
      if (++done % 500 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`${done}/${items.length}  ${rate.toFixed(0)}/s  eta ${((items.length - done) / rate / 60).toFixed(1)} min`);
      }
    }
  }));
}

if (ESTIMATE) {
  const groups = {};
  for (const j of list) (groups[j[0] + j[1]] ??= []).push(j);
  let total = 0;
  for (const [g, items] of Object.entries(groups)) {
    const sample = items.sort(() => Math.random() - 0.5).slice(0, 24);
    let bytes = 0, n = 0;
    await pool(sample, 6, async ([k, z, x, y]) => { const raw = await fetchRaw(k, z, x, y); if (raw) { bytes += (await encode(k, raw)).length; n++; } });
    const est = items.length * bytes / Math.max(1, n);
    total += est;
    console.log(g.padEnd(4), String(items.length).padStart(6), 'tiles  ~', (est / 1e6).toFixed(1), 'MB');
  }
  console.log('TOTAL ~', (total / 1e6).toFixed(0), 'MB');
  process.exit(0);
}

// full build: encode everything, then pack in deterministic order
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
list.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]) || a[2] - b[2] || a[3] - b[3]);
const encoded = new Array(list.length);
await pool(list, 12, async ([k, z, x, y], idx) => {
  const raw = await fetchRaw(k, z, x, y);
  encoded[idx] = raw ? await encode(k, raw) : null;
});

const index = {};
const chunks = [];
let cur = [], curSize = 0;
const flush = () => {
  if (!cur.length) return;
  const buf = Buffer.concat(cur);
  const name = `chunk-${String(chunks.length).padStart(3, '0')}.bin`;
  fs.writeFileSync(path.join(OUT, name), buf);
  chunks.push({ file: name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  cur = []; curSize = 0;
};
list.forEach((j, idx) => {
  const b = encoded[idx];
  if (!b) return;
  if (curSize + b.length > region.chunkSize) flush();
  index[`${j[0]}/${j[1]}/${j[2]}/${j[3]}`] = [chunks.length, curSize, b.length];
  cur.push(b); curSize += b.length;
});
flush();
const idxBuf = Buffer.from(JSON.stringify(index));
fs.writeFileSync(path.join(OUT, 'index.json'), idxBuf);
const manifest = {
  region: region.id, version: region.version, built: new Date().toISOString(),
  bbox: region.bbox, airports: region.airports,
  imagery: { format: 'webp', layer: region.imagery.layer }, elevation: { format: 'terrarium-png' },
  levels: count,
  index: { file: 'index.json', size: idxBuf.length, sha256: crypto.createHash('sha256').update(idxBuf).digest('hex') },
  chunks,
  totalSize: chunks.reduce((s, c) => s + c.size, 0) + idxBuf.length,
  attribution: [
    'Sentinel-2 cloudless 2024 — s2maps.eu, EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0',
    'Terrain Tiles — AWS Open Data / Mapzen (SRTM, GMTED, ETOPO1 ve diğerleri)',
    'Havalimanları — OurAirports (public domain)'
  ]
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`pack: ${Object.keys(index).length} tiles, ${chunks.length} chunks, ${(manifest.totalSize / 1e6).toFixed(1)} MB`);
