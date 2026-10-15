// Tile sources (offline pack / online streaming with fallback), DEM decoding and caches.
import * as THREE from 'three';
import { pack } from './pack';
import regionCfg from '../data/region.json';
import { lat2ty, lon2tx } from '../core/geo';

export type Kind = 'i' | 'e';
const EOX = (z: number, x: number, y: number) => `https://tiles.maps.eox.at/wmts/1.0.0/${regionCfg.imagery.layer}/default/g/${z}/${y}/${x}.jpg`;
const AWS = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export class DEM {
  constructor(public z: number, public x: number, public y: number, public size: number,
    public h: Int16Array, public water: Uint8Array | null) {}
  /** fx, fy in [0,1] within this tile */
  sample(fx: number, fy: number): number {
    const s = this.size - 1;
    const px = Math.min(s, Math.max(0, fx * s)), py = Math.min(s, Math.max(0, fy * s));
    const x0 = px | 0, y0 = py | 0, x1 = Math.min(s, x0 + 1), y1 = Math.min(s, y0 + 1);
    const tx = px - x0, ty = py - y0, n = this.size, h = this.h;
    const a = h[y0 * n + x0], b = h[y0 * n + x1], c = h[y1 * n + x0], d = h[y1 * n + x1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
  }
  isWater(fx: number, fy: number): number {
    const s = this.size - 1;
    const px = Math.round(Math.min(s, Math.max(0, fx * s))), py = Math.round(Math.min(s, Math.max(0, fy * s)));
    if (this.water) return this.water[py * this.size + px];
    return this.h[py * this.size + px] <= 0 ? 1 : 0;
  }
}

let decodeCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let decodeCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
async function decodeDEM(blob: Blob, z: number, x: number, y: number, masked: boolean): Promise<DEM> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } as ImageBitmapOptions);
  const w = bmp.width;
  if (!decodeCanvas || decodeCanvas.width !== w) {
    decodeCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, w) : Object.assign(document.createElement('canvas'), { width: w, height: w });
    decodeCtx = (decodeCanvas as any).getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  }
  const ctx = decodeCtx!;
  ctx.clearRect(0, 0, w, w);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const px = ctx.getImageData(0, 0, w, w).data;
  const n = w * w, h = new Int16Array(n);
  const water = masked ? new Uint8Array(n) : null;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = px[j] * 256 + px[j + 1] - 32768 + (masked ? 0 : px[j + 2] / 256);
    h[i] = Math.max(-40, Math.min(9000, Math.round(v)));
    if (water) water[i] = px[j + 2] > 127 ? 1 : 0; // blue channel = water mask in the offline pack
  }
  return new DEM(z, x, y, w, h, water);
}

export interface Source {
  name: 'offline' | 'online';
  maxImageryZ: number;
  maxDemZ: number;
  hasImagery(z: number, x: number, y: number): boolean;
  hasDem(z: number, x: number, y: number): boolean;
  imagery(z: number, x: number, y: number): Promise<Blob | null>;
  elevation(z: number, x: number, y: number): Promise<{ blob: Blob; masked: boolean } | null>;
}

export const offlineSource: Source = {
  name: 'offline', maxImageryZ: 15, maxDemZ: 12,
  hasImagery: (z, x, y) => pack.has('i', z, x, y),
  hasDem: (z, x, y) => pack.has('e', z, x, y),
  imagery: (z, x, y) => pack.tile('i', z, x, y),
  elevation: async (z, x, y) => { const b = await pack.tile('e', z, x, y); return b ? { blob: b, masked: true } : null; }
};

let onlineFailures = 0;
export const net = { online: navigator.onLine, lastFail: 0 };
addEventListener('online', () => { net.online = true; onlineFailures = 0; });
addEventListener('offline', () => { net.online = false; });

async function fetchBlob(url: string): Promise<Blob | null> {
  if (!net.online || (onlineFailures > 6 && performance.now() - net.lastFail < 15000)) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(url, { signal: ctl.signal, mode: 'cors' });
    clearTimeout(t);
    if (!r.ok) return null;
    onlineFailures = 0;
    return await r.blob();
  } catch {
    onlineFailures++; net.lastFail = performance.now();
    return null;
  }
}

export const onlineSource: Source = {
  name: 'online', maxImageryZ: 16, maxDemZ: 13,
  hasImagery: (z) => z <= 16,
  hasDem: (z) => z <= 13,
  imagery: async (z, x, y) => (await fetchBlob(EOX(z, x, y))) ?? (pack.ready ? pack.tile('i', z, x, y) : null),
  elevation: async (z, x, y) => {
    const b = await fetchBlob(AWS(z, x, y));
    if (b) return { blob: b, masked: false };
    const p = pack.ready ? await pack.tile('e', z, x, y) : null;
    return p ? { blob: p, masked: true } : null;
  }
};

// ---------- DEM cache ----------
export class DemCache {
  private map = new Map<string, DEM>();
  private pending = new Map<string, Promise<DEM | null>>();
  private missing = new Set<string>();
  constructor(public src: Source, public max = 260) {}
  setSource(s: Source) { this.src = s; this.missing.clear(); }
  key(z: number, x: number, y: number) { return `${z}/${x}/${y}`; }
  get(z: number, x: number, y: number) {
    const k = this.key(z, x, y), d = this.map.get(k);
    if (d) { this.map.delete(k); this.map.set(k, d); }
    return d;
  }
  load(z: number, x: number, y: number): Promise<DEM | null> {
    const k = this.key(z, x, y);
    const d = this.get(z, x, y);
    if (d) return Promise.resolve(d);
    if (this.missing.has(k)) return Promise.resolve(null);
    let p = this.pending.get(k);
    if (!p) {
      p = (async () => {
        const r = await this.src.elevation(z, x, y);
        if (!r) { this.missing.add(k); return null; }
        try {
          const dem = await decodeDEM(r.blob, z, x, y, r.masked);
          this.map.set(k, dem);
          while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
          return dem;
        } catch (e) { console.warn('dem decode', k, e); this.missing.add(k); return null; }
      })().finally(() => this.pending.delete(k));
      this.pending.set(k, p);
    }
    return p;
  }
  /** Best loaded DEM covering lat/lon at zoom <= maxZ (sync). */
  best(lat: number, lon: number, maxZ: number): { dem: DEM; fx: number; fy: number } | null {
    for (let z = maxZ; z >= 0; z--) {
      const tx = lon2tx(lon, z), ty = lat2ty(lat, z);
      const x = Math.floor(tx), y = Math.floor(ty);
      const d = this.get(z, x, y);
      if (d) return { dem: d, fx: tx - x, fy: ty - y };
    }
    return null;
  }
  height(lat: number, lon: number, maxZ = 13): { h: number; water: number } {
    const b = this.best(lat, lon, maxZ);
    if (!b) return { h: 0, water: 0 };
    return { h: b.dem.sample(b.fx, b.fy), water: b.dem.isWater(b.fx, b.fy) };
  }
}

// ---------- imagery texture cache (ref-counted) ----------
interface TexEntry { tex: THREE.Texture; refs: number; last: number }
export class TextureCache {
  private map = new Map<string, TexEntry>();
  private pending = new Map<string, Promise<THREE.Texture | null>>();
  anisotropy = 4;
  constructor(public src: Source) {}
  async acquire(z: number, x: number, y: number): Promise<THREE.Texture | null> {
    const k = `${z}/${x}/${y}`;
    const e = this.map.get(k);
    if (e) { e.refs++; e.last = performance.now(); return e.tex; }
    let p = this.pending.get(k);
    if (!p) {
      p = (async () => {
        const blob = await this.src.imagery(z, x, y);
        if (!blob) return null;
        try {
          const bmp = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' } as ImageBitmapOptions);
          const tex = new THREE.Texture(bmp as any);
          tex.flipY = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.anisotropy;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.needsUpdate = true;
          this.map.set(k, { tex, refs: 0, last: performance.now() });
          return tex;
        } catch (err) { console.warn('img decode', k, err); return null; }
      })().finally(() => this.pending.delete(k));
      this.pending.set(k, p);
    }
    const t = await p;
    const en = this.map.get(k);
    if (t && en) { en.refs++; en.last = performance.now(); }
    return t;
  }
  release(z: number, x: number, y: number) {
    const e = this.map.get(`${z}/${x}/${y}`);
    if (e) e.refs = Math.max(0, e.refs - 1);
  }
  /** dispose unreferenced textures beyond a budget */
  gc(budget: number) {
    if (this.map.size <= budget) return;
    const free = [...this.map.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].last - b[1].last);
    for (const [k, e] of free) {
      if (this.map.size <= budget) break;
      e.tex.dispose(); (e.tex.image as ImageBitmap)?.close?.();
      this.map.delete(k);
    }
  }
  clear() { for (const e of this.map.values()) e.tex.dispose(); this.map.clear(); }
  get size() { return this.map.size; }
}
