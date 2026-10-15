// Procedural 3D buildings on high-zoom terrain tiles. Urban cells are detected from the satellite imagery
// (grey/brown, low saturation, high local contrast, not water/vegetation), then filled with instanced boxes.
// Placement uses a global z20 cell grid + hash so z14 and z15 tiles produce the same buildings.
// Every building is also an Obstacle (wingtip / fuselage strikes).
import * as THREE from 'three';
import { tx2lon, ty2lat, Projection } from '../core/geo';
import { curvedProject } from './curvature';
import { env, fogGLSL } from './env';
import type { Obstacle, FlatRect } from './airports';
import { flatWeight, mulberry } from './airports';

const VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vCol; varying vec3 vN; varying vec3 vLocal; varying float vDist; varying vec3 vScale;
  void main() {
    #ifdef USE_INSTANCING_COLOR
      vCol = instanceColor;
    #else
      vCol = vec3(0.8);
    #endif
    vN = normalize(mat3(instanceMatrix) * normal);
    vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vLocal = position * vScale;
    vec3 transformed = (instanceMatrix * vec4(position, 1.0)).xyz;
    ${curvedProject}
    vDist = length(wPos.xyz - cameraPosition);
    #include <logdepthbuf_vertex>
  }`;
const FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSunDir, uSunColor, uAmbient; uniform float uNight, uRain;
  varying vec3 vCol; varying vec3 vN; varying vec3 vLocal; varying float vDist; varying vec3 vScale;
  ${fogGLSL}
  float hh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vN);
    bool roof = n.y > 0.5;
    vec3 base = vCol;
    if (roof) base = vCol.r > vCol.b * 1.25 ? vec3(0.55, 0.26, 0.18) : vCol * 0.62;
    float diff = max(dot(n, uSunDir), 0.0);
    vec3 col = base * (uAmbient * 0.55 + uSunColor * (0.25 + diff * 0.65));
    // windows: floor bands + columns on walls
    float win = 0.0;
    if (!roof && vDist < 4500.0) {
      float along = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
      float fy = fract(vLocal.y / 3.1), fx = fract(along / 3.4);
      win = step(0.35, fy) * step(fy, 0.8) * step(0.2, fx) * step(fx, 0.75) * step(2.0, vLocal.y);
      col = mix(col, col * 0.55 + vec3(0.06, 0.08, 0.1), win * 0.55 * (1.0 - uNight));
      float lit = step(0.55, hh(floor(vec2(along / 3.4, vLocal.y / 3.1)) + vCol.rg * 91.0));
      col += vec3(1.0, 0.78, 0.45) * win * lit * uNight * 0.9;
    }
    col *= mix(1.0, 0.8, uRain);
    gl_FragColor = vec4(applyFog(col, vDist), 1.0);
    #include <colorspace_fragment>
  }`;

export const buildingMaterial = new THREE.ShaderMaterial({
  vertexShader: VS, fragmentShader: FS,
  uniforms: { uSunDir: env.uSunDir, uSunColor: env.uSunColor, uAmbient: env.uAmbient, uNight: env.uNight, uRain: env.uRain, uFogColor: env.uFogColor, uFogDensity: env.uFogDensity }
});
const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
boxGeo.deleteAttribute('uv');

const PALETTE = [[0.86, 0.83, 0.76], [0.8, 0.76, 0.68], [0.74, 0.74, 0.72], [0.9, 0.88, 0.84], [0.82, 0.72, 0.6], [0.66, 0.68, 0.7], [0.88, 0.8, 0.7]];

let cv: HTMLCanvasElement | OffscreenCanvas | null = null;
let cx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function ctx2d(n: number) {
  if (!cv) {
    cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
    cx = (cv as any).getContext('2d', { willReadFrequently: true });
  }
  if (cv.width !== n) { cv.width = n; cv.height = n; }
  return cx;
}

export interface BuildingSet { mesh: THREE.InstancedMesh; obstacles: Obstacle[] }

/** Tile node info needed to place buildings. `pos` = terrain grid positions (N+1)², local to `center`. */
export function makeBuildings(opts: {
  z: number; x: number; y: number; center: THREE.Vector3; proj: Projection;
  img: CanvasImageSource & { width: number; height: number }; uv: { k: number; ox: number; oy: number };
  pos: Float32Array; water: Float32Array; N: number; flats: FlatRect[]; density: number;
}): BuildingSet | null {
  const { z, x, y, center, proj, img, uv, pos, water, N, flats } = opts;
  const s = 20 - z, G = 2 ** s;             // z20 cells per side in this tile
  const P = Math.min(128, G * 2);           // sample resolution
  const c = ctx2d(P); if (!c) return null;
  const sw = img.width / uv.k, sh = img.height / uv.k;
  try { c.drawImage(img, uv.ox * img.width, uv.oy * img.height, sw, sh, 0, 0, P, P); } catch { return null; }
  let px: Uint8ClampedArray;
  try { px = c.getImageData(0, 0, P, P).data; } catch { return null; }
  const lum = new Float32Array(P * P);
  for (let i = 0; i < P * P; i++) lum[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
  // per-sample urban score
  const urban = new Uint8Array(P * P);
  for (let j = 1; j < P - 1; j++) for (let i = 1; i < P - 1; i++) {
    const k = j * P + i, r = px[k * 4], g = px[k * 4 + 1], b = px[k * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = lum[k];
    if (L < 55 || L > 235) continue;
    if (g > r * 1.04 && g >= b) continue;           // vegetation
    if (b > r * 1.08 && b > g) continue;            // water / shadowed sea
    if ((mx - mn) / mx > 0.42) continue;            // saturated soil / fields
    let m = 0, v = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) m += lum[k + dj * P + di];
    m /= 9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const d = lum[k + dj * P + di] - m; v += d * d; }
    if (Math.sqrt(v / 9) < 9) continue;             // smooth = field, road, bare ground
    urban[k] = 1;
  }
  // neighbourhood density (for tall buildings) on the sample grid
  const dens = (i: number, j: number) => {
    let n = 0, t = 0;
    for (let dj = -4; dj <= 4; dj += 2) for (let di = -4; di <= 4; di += 2) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= P || jj >= P) continue;
      t++; n += urban[jj * P + ii];
    }
    return n / Math.max(1, t);
  };
  const height = (u: number, v: number) => {       // bilinear on terrain grid
    const fx = u * N, fy = v * N, i = Math.min(N - 1, Math.floor(fx)), j = Math.min(N - 1, Math.floor(fy));
    const a = fx - i, b = fy - j, at = (ii: number, jj: number) => pos[(jj * (N + 1) + ii) * 3 + 1];
    const wt = (ii: number, jj: number) => water[jj * (N + 1) + ii];
    const h = (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
    const w = Math.max(wt(i, j), wt(i + 1, j), wt(i, j + 1), wt(i + 1, j + 1));
    const hs = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
    return { h, w, slope: Math.max(...hs) - Math.min(...hs) };
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const mats: number[] = [], cols: number[] = [], obs: Obstacle[] = [];
  const gx0 = x * G, gy0 = y * G;
  for (let cj = 0; cj < G; cj++) for (let ci = 0; ci < G; ci++) {
    const gx = gx0 + ci, gy = gy0 + cj;
    const rnd = mulberry((Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) >>> 0);
    const u = (ci + 0.5) / G, v = (cj + 0.5) / G;
    const si = Math.min(P - 1, Math.floor(u * P)), sj = Math.min(P - 1, Math.floor(v * P));
    if (!urban[sj * P + si]) continue;
    const d = dens(si, sj);
    if (rnd() > (0.35 + d * 0.5) * opts.density) continue;
    const ht = height(u, v);
    if (ht.w > 0.2 || ht.slope > 25) continue;
    const lon = tx2lon(x + u, z), lat = ty2lat(y + v, z);
    const wx = proj.x(lon), wz = proj.z(lat);
    let nearFlat = false;
    for (const f of flats) if (flatWeight(f, wx, wz) > 0 || Math.hypot(wx - f.cx, wz - f.cz) < f.halfL + 450) { nearFlat = true; break; }
    if (nearFlat) continue;
    // block orientation shared by a z17 block (street grid look)
    const blk = mulberry((Math.imul(gx >> 3, 2654435761) ^ Math.imul(gy >> 3, 40503)) >>> 0);
    const rot = blk() * Math.PI + (rnd() - 0.5) * 0.15;
    const cell = 26; // ≈ z20 cell size at 41°N
    const wdt = cell * (0.45 + rnd() * 0.35), dep = cell * (0.4 + rnd() * 0.35);
    let hgt = 6 + rnd() * 9 + d * 14 * rnd();
    if (d > 0.7 && rnd() < 0.04) hgt = 45 + rnd() * 80;   // occasional tower in dense districts
    hgt = Math.round(hgt / 3) * 3;
    const ox = (rnd() - 0.5) * cell * 0.25, oz = (rnd() - 0.5) * cell * 0.25;
    const bx = wx + ox - center.x, bz = wz + oz - center.z;
    const y0 = ht.h - 1.5;
    q.setFromAxisAngle(up, rot); sc.set(wdt, hgt + 1.5, dep); tp.set(bx, y0, bz);
    m4.compose(tp, q, sc);
    mats.push(...m4.elements);
    const p = PALETTE[Math.floor(rnd() * PALETTE.length)], t = 0.74 + rnd() * 0.14;
    cols.push(p[0] * t, p[1] * t, p[2] * t);
    obs.push({ cx: bx + center.x, cz: bz + center.z, hx: wdt / 2, hz: dep / 2, rot, y0, y1: y0 + hgt + 1.5, r: Math.hypot(wdt, dep) / 2, kind: 'bina' });
  }
  if (!obs.length) return null;
  const mesh = new THREE.InstancedMesh(boxGeo, buildingMaterial, obs.length);
  mesh.instanceMatrix.array.set(mats);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.geometry = boxGeo;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cols), 3);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return { mesh, obstacles: obs };
}
