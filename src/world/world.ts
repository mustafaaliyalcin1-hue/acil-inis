// World manager: projection, data sources, terrain LOD, airports (3D + flattening), sky, height queries.
import * as THREE from 'three';
import { Projection, lat2ty, lon2tx, haversine } from '../core/geo';
import regionCfg from '../data/region.json';
import { AirportDB, Airport, FlatRect, flatRects, flatWeight, buildAirport, Obstacle, setAirportNight } from './airports';
import { DemCache, TextureCache, Source, offlineSource, onlineSource } from './tiles';
import { Terrain } from './terrain';
import { Sky } from './sky';
import { pack } from './pack';
import { store } from '../core/store';

export interface Ground { h: number; water: boolean; flat: boolean }

export class World {
  proj: Projection;
  db: AirportDB;
  src: Source;
  dem: DemCache;
  tex: TextureCache;
  terrain: Terrain;
  sky: Sky;
  scene: THREE.Scene;
  mode: 'offline' | 'online';
  active = new Map<string, Airport>();
  private flats: { apt: Airport; rects: FlatRect[] }[] = [];
  private lastAptCheck = -1e9;
  regionAirports: Airport[] = [];

  constructor(scene: THREE.Scene, mode: 'offline' | 'online') {
    this.scene = scene;
    this.mode = mode;
    this.proj = new Projection(regionCfg.origin.lat, regionCfg.origin.lon);
    this.db = new AirportDB(this.proj);
    this.src = mode === 'online' ? onlineSource : offlineSource;
    this.dem = new DemCache(this.src);
    this.tex = new TextureCache(this.src);
    this.terrain = new Terrain({ proj: this.proj, flatAt: (x, z) => this.flatsNear(x, z) }, this.src, this.dem, this.tex);
    this.sky = new Sky(scene);
    scene.add(this.terrain.group);
    this.applyQuality();
  }

  applyQuality(q = store.settings.quality) {
    const lvl = q === 'auto' ? 'med' : q;
    this.terrain.splitFactor = lvl === 'low' ? 1.35 : lvl === 'med' ? 1.9 : 2.5;
    this.terrain.maxZ = this.mode === 'online' ? (lvl === 'high' ? 16 : 15) : 15;
    this.tex.anisotropy = lvl === 'low' ? 2 : lvl === 'med' ? 4 : 8;
  }

  async init() {
    await this.db.load(import.meta.env.BASE_URL + 'data/airports.json');
    const b = regionCfg.bbox;
    this.regionAirports = regionCfg.airports.map(id => this.db.byId.get(id)!).filter(Boolean);
    if (this.mode === 'offline') {
      const w = regionCfg.wide.bbox;
      this.terrain.setRoots(this.terrain.rootsForBox(5, w.south, w.north, w.west, w.east));
      // all paved airports inside the pack region get exact elevations + flattening up-front
      const inBox = this.db.list.filter(a => a.lat > b.south && a.lat < b.north && a.lon > b.west && a.lon < b.east && a.runways.some(r => r.length >= 1300));
      await Promise.all(inBox.map(a => this.prepareAirport(a)));
    } else this.setOnlineRoots(regionCfg.origin.lat, regionCfg.origin.lon);
  }

  /** online: move the local origin to (lat, lon) — keeps float precision anywhere in the world */
  async rebase(lat: number, lon: number) {
    for (const a of this.active.values()) if (a.group) { this.scene.remove(a.group); disposeGroup(a.group); a.group = undefined; a.built = false; }
    this.active.clear();
    this.proj.setOrigin(lat, lon);
    this.db.reproject();
    this.flats = [];
    for (const a of this.db.list) a.elevReady = false;
    this.setOnlineRoots(lat, lon);
  }

  /** online: (re)build root tiles around a point */
  setOnlineRoots(lat: number, lon: number) {
    this.terrain.setRoots(this.terrain.rootsForBox(6, lat - 4, lat + 4, lon - 5, lon + 5));
  }

  /** sample DEM along runways (best zoom) → runway elevations, then register flat areas */
  async prepareAirport(a: Airport) {
    if (a.elevReady) return;
    const z = Math.min(this.src.maxDemZ, 12);
    const tiles = new Set<string>();
    for (const r of a.runways) for (const e of r.ends) for (let zz = z; zz >= 9; zz--) tiles.add(`${zz}/${Math.floor(lon2tx(e.lon, zz))}/${Math.floor(lat2ty(e.lat, zz))}`);
    await Promise.all([...tiles].map(k => { const [zz, x, y] = k.split('/').map(Number); return this.dem.load(zz, x, y); }));
    for (const r of a.runways) {
      let sum = 0, n = 0;
      for (let t = 0.1; t <= 0.91; t += 0.2) {
        const lat = r.ends[0].lat + (r.ends[1].lat - r.ends[0].lat) * t, lon = r.ends[0].lon + (r.ends[1].lon - r.ends[0].lon) * t;
        const s = this.dem.height(lat, lon, z);
        if (!s.water) { sum += s.h; n++; }
      }
      const demElev = n ? sum / n : a.elevM;
      r.elev = Math.abs(demElev - a.elevM) > 40 ? demElev : demElev * 0.7 + a.elevM * 0.3;
      if (r.elev < 1) r.elev = Math.max(1, a.elevM);
    }
    a.elevReady = true;
    if (!this.flats.find(f => f.apt === a)) this.flats.push({ apt: a, rects: flatRects(a) });
  }

  flatsNear(x: number, z: number): FlatRect[] {
    const out: FlatRect[] = [];
    for (const f of this.flats) if (Math.abs(f.apt.x - x) < 30000 && Math.abs(f.apt.z - z) < 30000) out.push(...f.rects);
    return out;
  }

  /** ground under a local point (physics) */
  ground(x: number, z: number): Ground {
    const lat = this.proj.lat(z), lon = this.proj.lon(x);
    const s = this.dem.height(lat, lon, this.src.maxDemZ);
    let h = s.h, water = !!s.water, flat = false;
    for (const f of this.flats) {
      if (Math.abs(f.apt.x - x) > 9000 || Math.abs(f.apt.z - z) > 9000) continue;
      for (const r of f.rects) {
        const w = flatWeight(r, x, z);
        if (w > 0) { h += (r.elev - h) * w; if (w > 0.5) water = false; if (w >= 1) flat = true; }
      }
    }
    if (water) h = Math.max(h, 0);
    return { h, water, flat };
  }

  obstacles(x: number, z: number, r: number): Obstacle[] {
    const out: Obstacle[] = [];
    for (const a of this.active.values()) {
      if (Math.abs(a.x - x) > 8000 || Math.abs(a.z - z) > 8000) continue;
      for (const o of a.obstacles) if (x > o.min.x - r && x < o.max.x + r && z > o.min.z - r && z < o.max.z + r) out.push(o);
    }
    return out;
  }

  /** keep airports near the camera built; dispose far ones */
  private async updateAirports(cam: THREE.Vector3, now: number) {
    if (now - this.lastAptCheck < 1500) return;
    this.lastAptCheck = now;
    const lat = this.proj.lat(cam.z), lon = this.proj.lon(cam.x);
    const near = this.db.near(lat, lon, 45000).filter(a => a.runways.some(r => r.length >= 1100));
    for (const a of near.slice(0, 14)) {
      if (this.active.has(a.ident)) continue;
      this.active.set(a.ident, a);
      if (!a.elevReady) {
        await this.prepareAirport(a);
        this.terrain.invalidate(a.x, a.z, 6000);
      }
      if (!this.active.has(a.ident)) continue;
      a.group = buildAirport(a);
      this.scene.add(a.group);
      a.built = true;
    }
    for (const [id, a] of this.active) {
      if (haversine(lat, lon, a.lat, a.lon) > 65000) {
        if (a.group) { this.scene.remove(a.group); disposeGroup(a.group); a.group = undefined; }
        a.built = false; this.active.delete(id);
      }
    }
  }

  update(cam: THREE.PerspectiveCamera, now: number) {
    const { night } = this.sky.update(cam, this.scene);
    setAirportNight(night);
    this.terrain.update(cam.position, now);
    this.updateAirports(cam.position, now);
  }

  /** force the airport around a point to be ready (used before spawning on a runway) */
  async ensureAirport(a: Airport) {
    await this.prepareAirport(a);
    if (!this.active.has(a.ident)) {
      this.active.set(a.ident, a);
      this.terrain.invalidate(a.x, a.z, 6000);
      a.group = buildAirport(a); this.scene.add(a.group); a.built = true;
    }
  }

  /** wait until terrain around the camera has loaded (with timeout) */
  async warmup(cam: THREE.PerspectiveCamera, ms = 6000) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      this.update(cam, performance.now());
      await new Promise(r => setTimeout(r, 60));
      if (this.terrain.pending === 0 && performance.now() - t0 > 400) break;
    }
  }

  get packReady() { return pack.ready; }
  dispose() {
    this.terrain.dispose();
    for (const a of this.active.values()) if (a.group) { this.scene.remove(a.group); disposeGroup(a.group); }
    this.active.clear();
    this.tex.clear();
  }
}

export function disposeGroup(g: THREE.Object3D) {
  g.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat && !Array.isArray(mat) && (mat as any).isShaderMaterial) mat.dispose();
  });
}
