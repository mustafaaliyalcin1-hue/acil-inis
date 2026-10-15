// Quadtree terrain LOD on web-mercator tiles. Heightmap from DEM tiles, Sentinel-2 imagery draped,
// animated water where the DEM water mask is set (sea + lakes). Runways/aprons are flattened.
import * as THREE from 'three';
import { Projection, tx2lon, ty2lat, lat2ty, lon2tx, tileSizeM } from '../core/geo';
import { curvedProject } from './curvature';
import { env, fogGLSL } from './env';
import { DemCache, TextureCache, Source } from './tiles';
import type { FlatRect } from './airports';
import { flatWeight } from './airports';
import type { Obstacle } from './airports';
import { makeBuildings, BuildingSet } from './buildings';

const N = 32; // grid segments per tile

const terrainVS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float water;
  uniform mat3 uUvT;
  varying vec2 vUv; varying float vWater; varying vec3 vNormal; varying vec3 vWorld; varying float vDist;
  void main() {
    vUv = (uUvT * vec3(uv, 1.0)).xy;
    vWater = water;
    vNormal = normal;
    vec3 transformed = position;
    ${curvedProject}
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vDist = length(wPos.xyz - cameraPosition);
    #include <logdepthbuf_vertex>
  }`;
const terrainFS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map; uniform float uHasMap;
  uniform vec3 uSunDir, uSunColor, uAmbient, uSkyColor; uniform float uNight, uTime, uRain;
  varying vec2 vUv; varying float vWater; varying vec3 vNormal; varying vec3 vWorld; varying float vDist;
  ${fogGLSL}
  float h2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 base = uHasMap > 0.5 ? texture2D(map, vUv).rgb : vec3(0.34, 0.37, 0.3);
    // Sentinel-2 cloudless is fairly dark/saturated: gentle tone mapping
    base = pow(base, vec3(1.04)) * 0.97;
    vec3 n = normalize(vNormal);
    float diff = max(dot(n, uSunDir), 0.0);
    float relief = 0.55 + 0.6 * diff;           // imagery already contains shading → mild relief
    vec3 col = base * (uAmbient * 0.68 + uSunColor * relief * 0.5);
    float w = smoothstep(0.35, 0.75, vWater);
    if (w > 0.0) {
      vec2 p = vWorld.xz;
      float t = uTime;
      vec2 g = vec2(vn(p * 0.045 + vec2(t * 0.25, t * 0.11)) - 0.5, vn(p * 0.05 - vec2(t * 0.17, -t * 0.21)) - 0.5)
             + 0.5 * vec2(vn(p * 0.21 + t * 0.6) - 0.5, vn(p * 0.19 - t * 0.55) - 0.5);
      vec3 wn = normalize(vec3(g.x * 0.35, 1.0, g.y * 0.35));
      vec3 v = normalize(cameraPosition - vWorld);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(v, wn), 0.0), 5.0);
      vec3 deep = mix(vec3(0.02, 0.07, 0.11), base * 0.7, 0.35);
      vec3 refl = mix(uSkyColor, uAmbient, 0.25);
      vec3 wcol = mix(deep * (uAmbient * 0.8 + uSunColor * 0.3), refl, clamp(fres, 0.0, 0.85));
      vec3 h = normalize(v + uSunDir);
      wcol += uSunColor * pow(max(dot(wn, h), 0.0), 220.0) * 2.5 * (1.0 - uNight) * (1.0 - uRain * 0.7);
      col = mix(col, wcol, w * 0.92);
    }
    col *= mix(1.0, 0.82, uRain);
    gl_FragColor = vec4(applyFog(col, vDist), 1.0);
    #include <colorspace_fragment>
  }`;

const baseMat = new THREE.ShaderMaterial({
  vertexShader: terrainVS, fragmentShader: terrainFS,
  uniforms: {
    map: { value: null }, uHasMap: { value: 0 }, uUvT: { value: new THREE.Matrix3() },
    uSunDir: env.uSunDir, uSunColor: env.uSunColor, uAmbient: env.uAmbient, uSkyColor: env.uSkyColor,
    uNight: env.uNight, uTime: env.uTime, uRain: env.uRain, uFogColor: env.uFogColor, uFogDensity: env.uFogDensity
  }
});
const SHARED = ['uSunDir', 'uSunColor', 'uAmbient', 'uSkyColor', 'uNight', 'uTime', 'uRain', 'uFogColor', 'uFogDensity'];
function nodeMaterial() {
  const m = baseMat.clone();
  for (const k of SHARED) m.uniforms[k] = (baseMat.uniforms as any)[k];
  return m;
}

export interface TerrainHost {
  proj: Projection;
  flatAt(x: number, z: number): FlatRect[];
}

class Node {
  children: Node[] | null = null;
  mesh: THREE.Mesh | null = null;
  building = false;
  texKey: [number, number, number] | null = null;
  bld: (BuildingSet & { grid: Obstacle[][]; top: number }) | null = null;
  demZ = -1;
  imgZ = -1;
  dirty = false;
  minH = 0; maxH = 300;
  lastUsed = 0;
  center = new THREE.Vector3();
  size: number;
  constructor(public z: number, public x: number, public y: number, public parent: Node | null, proj: Projection) {
    const lat = ty2lat(y + 0.5, z), lon = tx2lon(x + 0.5, z);
    this.center.set(proj.x(lon), 0, proj.z(lat));
    this.size = tileSizeM(z, lat);
    if (parent) { this.minH = parent.minH; this.maxH = parent.maxH; }
  }
}

export class Terrain {
  group = new THREE.Group();
  roots: Node[] = [];
  private queue: Node[] = [];
  private active = 0;
  splitFactor = 2.0;
  maxZ = 15;
  frame = 0;
  stats = { nodes: 0, meshes: 0, tex: 0, buildings: 0 };
  buildingDensity = 1; // 0 = off
  private bldNodes = new Set<Node>();
  constructor(public host: TerrainHost, public src: Source, public dem: DemCache, public tex: TextureCache) {
    this.group.name = 'terrain';
  }

  setRoots(tiles: [number, number, number][]) {
    for (const r of this.roots) this.disposeTree(r);
    this.roots = tiles.map(([z, x, y]) => new Node(z, x, y, null, this.host.proj));
  }
  rootsForBox(z: number, south: number, north: number, west: number, east: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let x = Math.floor(lon2tx(west, z)); x <= Math.floor(lon2tx(east, z)); x++)
      for (let y = Math.floor(lat2ty(north, z)); y <= Math.floor(lat2ty(south, z)); y++) out.push([z, x, y]);
    return out;
  }

  /** best available DEM zoom for node (<= node z) */
  private demZoomFor(n: Node) {
    for (let z = Math.min(n.z, this.src.maxDemZ); z >= 0; z--) {
      const s = n.z - z;
      if (this.src.hasDem(z, n.x >> s, n.y >> s)) return z;
    }
    return -1;
  }
  private imgZoomFor(n: Node) {
    for (let z = Math.min(n.z, this.src.maxImageryZ); z >= 0; z--) {
      const s = n.z - z;
      if (this.src.hasImagery(z, n.x >> s, n.y >> s)) return z;
    }
    return -1;
  }
  canSplit(n: Node) {
    if (n.z >= this.maxZ) return false;
    // only split where finer data exists (imagery or elevation)
    const z = n.z + 1;
    for (let i = 0; i < 4; i++) {
      const cx = n.x * 2 + (i & 1), cy = n.y * 2 + (i >> 1);
      if (this.src.hasImagery(z, cx, cy)) return true;
    }
    return false;
  }

  update(cam: THREE.Vector3, now: number) {
    this.frame++;
    const visible: Node[] = [];
    const want = (n: Node) => {
      const dx = Math.max(Math.abs(cam.x - n.center.x) - n.size / 2, 0);
      const dz = Math.max(Math.abs(cam.z - n.center.z) - n.size / 2, 0);
      const dy = cam.y > n.maxH ? cam.y - n.maxH : cam.y < n.minH ? n.minH - cam.y : 0;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return d < n.size * this.splitFactor;
    };
    const walk = (n: Node) => {
      n.lastUsed = now;
      if (!n.mesh && !n.building) this.enqueue(n);
      else if (n.mesh && n.dirty && !n.building) this.enqueue(n);
      if (want(n) && this.canSplit(n)) {
        if (!n.children) n.children = [0, 1, 2, 3].map(i => new Node(n.z + 1, n.x * 2 + (i & 1), n.y * 2 + (i >> 1), n, this.host.proj));
        const ready = n.children.every(c => c.mesh);
        for (const c of n.children) walk(c);
        if (ready) return;
        // children not ready: draw self meanwhile (hide children)
        for (const c of n.children) this.hideTree(c);
        if (n.mesh) visible.push(n);
        return;
      }
      if (n.children) { for (const c of n.children) this.disposeTree(c); n.children = null; }
      if (n.mesh) visible.push(n);
    };
    for (const r of this.roots) walk(r);
    const vis = new Set(visible);
    for (const ch of this.group.children) ch.visible = false;
    for (const n of vis) n.mesh!.visible = true;
    this.pump(cam);
    this.stats.nodes = vis.size;
    this.stats.meshes = this.group.children.length;
    this.stats.tex = this.tex.size;
    this.stats.buildings = [...this.bldNodes].reduce((a, n) => a + (n.mesh?.visible ? n.bld!.obstacles.length : 0), 0);
    if (this.frame % 120 === 0) this.tex.gc(this.stats.meshes + 80);
  }

  private enqueue(n: Node) { if (!this.queue.includes(n)) this.queue.push(n); }
  private pump(cam: THREE.Vector3) {
    if (!this.queue.length) return;
    // closest / coarsest first
    this.queue.sort((a, b) => (a.z - b.z) * 3000 + (a.center.distanceTo(cam) / a.size - b.center.distanceTo(cam) / b.size));
    while (this.active < 6 && this.queue.length) {
      const n = this.queue.shift()!;
      if (n.building) continue;
      n.building = true; this.active++;
      this.build(n).catch(e => console.warn('tile', n.z, n.x, n.y, e)).finally(() => { n.building = false; this.active--; });
    }
  }

  private async build(n: Node) {
    const dz = this.demZoomFor(n);
    const iz = this.imgZoomFor(n);
    let dem = null;
    if (dz >= 0) { const s = n.z - dz; dem = await this.dem.load(dz, n.x >> s, n.y >> s); }
    if (this.isDisposed(n)) return;
    // texture
    let tex: THREE.Texture | null = null;
    if (iz >= 0) { const s = n.z - iz; tex = await this.tex.acquire(iz, n.x >> s, n.y >> s); }
    if (this.isDisposed(n)) { if (tex) this.tex.release(iz, n.x >> (n.z - iz), n.y >> (n.z - iz)); return; }
    const geo = this.geometry(n, dem);
    let mat = n.mesh?.material as THREE.ShaderMaterial | undefined;
    if (!mat) mat = nodeMaterial();
    if (tex) {
      if (n.texKey) this.tex.release(...n.texKey);
      const s = n.z - iz, k = 2 ** s;
      const ox = (n.x / k) - (n.x >> s), oy = (n.y / k) - (n.y >> s);
      mat.uniforms.map.value = tex; mat.uniforms.uHasMap.value = 1;
      (mat.uniforms.uUvT.value as THREE.Matrix3).set(1 / k, 0, ox, 0, 1 / k, oy, 0, 0, 1);
      n.texKey = [iz, n.x >> s, n.y >> s];
    }
    if (n.mesh) { n.mesh.geometry.dispose(); n.mesh.geometry = geo; }
    else {
      n.mesh = new THREE.Mesh(geo, mat);
      n.mesh.position.copy(n.center);
      n.mesh.matrixAutoUpdate = false; n.mesh.updateMatrix();
      n.mesh.visible = false;
      n.mesh.frustumCulled = n.z >= 10;
      this.group.add(n.mesh);
    }
    n.demZ = dz; n.imgZ = iz; n.dirty = false;
    if (n.bld) this.dropBuildings(n);
    if (this.buildingDensity > 0 && n.z >= 14 && iz >= 14 && tex?.image) this.addBuildings(n, tex, geo);
  }

  private addBuildings(n: Node, tex: THREE.Texture, geo: THREE.BufferGeometry) {
    const s = n.z - n.imgZ, k = 2 ** s;
    const flats = this.host.flatAt(n.center.x, n.center.z).filter(f => Math.hypot(f.cx - n.center.x, f.cz - n.center.z) < n.size + f.halfL + 2000);
    const set = makeBuildings({
      z: n.z, x: n.x, y: n.y, center: n.center, proj: this.host.proj, img: tex.image as any,
      uv: { k, ox: (n.x / k) - (n.x >> s), oy: (n.y / k) - (n.y >> s) },
      pos: geo.attributes.position.array as Float32Array, water: geo.attributes.water.array as Float32Array, N, flats, density: this.buildingDensity
    });
    if (!set || !n.mesh) return;
    n.mesh.add(set.mesh);
    // 8×8 bucket grid for collision queries
    const grid: Obstacle[][] = Array.from({ length: 64 }, () => []);
    let top = -1e9;
    const x0 = n.center.x - n.size / 2, z0 = n.center.z - n.size / 2, cs = n.size / 8;
    for (const o of set.obstacles) {
      top = Math.max(top, o.y1);
      const i0 = Math.max(0, Math.floor((o.cx - o.r - x0) / cs)), i1 = Math.min(7, Math.floor((o.cx + o.r - x0) / cs));
      const j0 = Math.max(0, Math.floor((o.cz - o.r - z0) / cs)), j1 = Math.min(7, Math.floor((o.cz + o.r - z0) / cs));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * 8 + i].push(o);
    }
    n.bld = { ...set, grid, top };
    this.bldNodes.add(n);
  }
  private dropBuildings(n: Node) {
    if (!n.bld) return;
    n.bld.mesh.removeFromParent(); n.bld.mesh.dispose();
    n.bld = null; this.bldNodes.delete(n);
  }
  /** building obstacles near (x, z) from the finest loaded tile */
  obstacles(x: number, z: number, r: number, y: number, out: Obstacle[]) {
    let best: Node | null = null;
    for (const n of this.bldNodes) {
      if (Math.abs(x - n.center.x) > n.size / 2 || Math.abs(z - n.center.z) > n.size / 2) continue;
      if (!best || n.z > best.z) best = n;
    }
    if (!best || !best.bld || y > best.bld.top + r) return;
    const cs = best.size / 8, x0 = best.center.x - best.size / 2, z0 = best.center.z - best.size / 2;
    const i = Math.min(7, Math.max(0, Math.floor((x - x0) / cs))), j = Math.min(7, Math.max(0, Math.floor((z - z0) / cs)));
    for (const o of best.bld.grid[j * 8 + i]) if (Math.abs(x - o.cx) < o.r + r && Math.abs(z - o.cz) < o.r + r) out.push(o);
  }
  setBuildingDensity(d: number) {
    if (d === this.buildingDensity) return;
    this.buildingDensity = d;
    for (const n of [...this.bldNodes]) this.dropBuildings(n);
    const mark = (n: Node) => { if (n.mesh && n.z >= 14) n.dirty = true; n.children?.forEach(mark); };
    this.roots.forEach(mark);
  }
  private isDisposed(n: Node): boolean {
    let p: Node | null = n;
    while (p.parent) { if (!p.parent.children || !p.parent.children.includes(p)) return true; p = p.parent; }
    return !this.roots.includes(p);
  }

  private geometry(n: Node, dem: import('./tiles').DEM | null): THREE.BufferGeometry {
    const proj = this.host.proj;
    const V = (N + 1) * (N + 1);
    const skirt = 4 * (N + 1);
    const pos = new Float32Array((V + skirt) * 3), uv = new Float32Array((V + skirt) * 2), wat = new Float32Array(V + skirt);
    const flats = this.host.flatAt(n.center.x, n.center.z).filter(f => Math.hypot(f.cx - n.center.x, f.cz - n.center.z) < n.size + f.halfL + 2000);
    let minH = 1e9, maxH = -1e9;
    const s = dem ? n.z - dem.z : 0, k = 2 ** s;
    for (let j = 0; j <= N; j++) {
      const ty = n.y + j / N;
      const lat = ty2lat(ty, n.z);
      for (let i = 0; i <= N; i++) {
        const tx = n.x + i / N;
        const lon = tx2lon(tx, n.z);
        const x = proj.x(lon), zz = proj.z(lat);
        let h = 0, w = 0;
        if (dem) {
          const fx = tx / k - dem.x, fy = (ty / k) - dem.y;
          h = dem.sample(fx, fy); w = dem.isWater(fx, fy);
        }
        for (const f of flats) {
          const wt = flatWeight(f, x, zz);
          if (wt > 0) { h = h + (f.elev - h) * wt; if (wt > 0.5) w = 0; }
        }
        if (w > 0.5) h = Math.max(h, 0) - 0.0; // water surface at mask level
        const vi = j * (N + 1) + i;
        pos[vi * 3] = x - n.center.x; pos[vi * 3 + 1] = h; pos[vi * 3 + 2] = zz - n.center.z;
        uv[vi * 2] = i / N; uv[vi * 2 + 1] = j / N;
        wat[vi] = w;
        if (h < minH) minH = h; if (h > maxH) maxH = h;
      }
    }
    n.minH = minH; n.maxH = maxH;
    // skirts
    const depth = Math.max(15, n.size * 0.02);
    let si = V;
    const edge: number[] = [];
    for (let i = 0; i <= N; i++) edge.push(i);                       // top
    for (let i = 0; i <= N; i++) edge.push(N * (N + 1) + i);         // bottom
    for (let j = 0; j <= N; j++) edge.push(j * (N + 1));             // left
    for (let j = 0; j <= N; j++) edge.push(j * (N + 1) + N);         // right
    for (const vi of edge) {
      pos[si * 3] = pos[vi * 3]; pos[si * 3 + 1] = pos[vi * 3 + 1] - depth; pos[si * 3 + 2] = pos[vi * 3 + 2];
      uv[si * 2] = uv[vi * 2]; uv[si * 2 + 1] = uv[vi * 2 + 1]; wat[si] = wat[vi];
      si++;
    }
    const idx: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const sk = (o: number, flip: boolean) => {
      for (let i = 0; i < N; i++) {
        const a = edge[o + i], b = edge[o + i + 1], a2 = V + o + i, b2 = V + o + i + 1;
        if (flip) idx.push(a, b, a2, b, b2, a2); else idx.push(a, a2, b, b, a2, b2);
      }
    };
    sk(0, false); sk(N + 1, true); sk(2 * (N + 1), true); sk(3 * (N + 1), false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('water', new THREE.BufferAttribute(wat, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    // skirt normals: copy from edge
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let q = 0; q < edge.length; q++) nor.setXYZ(V + q, nor.getX(edge[q]), nor.getY(edge[q]), nor.getZ(edge[q]));
    g.computeBoundingSphere();
    return g;
  }

  /** mark nodes overlapping a circle for rebuild (e.g. new airport flattening) */
  invalidate(cx: number, cz: number, r: number) {
    const go = (n: Node) => {
      if (Math.abs(n.center.x - cx) > n.size / 2 + r || Math.abs(n.center.z - cz) > n.size / 2 + r) return;
      if (n.mesh) n.dirty = true;
      if (n.children) for (const c of n.children) go(c);
    };
    for (const r0 of this.roots) go(r0);
  }
  private hideTree(n: Node) { if (n.mesh) n.mesh.visible = false; if (n.children) for (const c of n.children) this.hideTree(c); }
  private disposeTree(n: Node) {
    if (n.children) for (const c of n.children) this.disposeTree(c);
    n.children = null;
    if (n.bld) this.dropBuildings(n);
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      (n.mesh.material as THREE.Material).dispose();
      n.mesh = null;
    }
    if (n.texKey) { this.tex.release(...n.texKey); n.texKey = null; }
    const qi = this.queue.indexOf(n); if (qi >= 0) this.queue.splice(qi, 1);
  }
  dispose() { for (const r of this.roots) this.disposeTree(r); this.roots = []; }
  get pending() { return this.queue.length + this.active; }
}
