// Airport database (OurAirports) + procedural 3D airports: runways with real markings, lights, PAPI, ILS,
// taxiways, aprons, terminals, towers, hangars.
import * as THREE from 'three';
import { Projection, haversine, DEG, clamp, wrap360 } from '../core/geo';
import { curve, curvedProject } from './curvature';
import { env, fogGLSL } from './env';

export interface RunwayEnd { ident: string; lat: number; lon: number; x: number; z: number; hdg: number; disp: number; ils: boolean }
export interface Runway {
  apt: Airport; ends: [RunwayEnd, RunwayEnd]; length: number; width: number; concrete: boolean;
  cx: number; cz: number; dirx: number; dirz: number; elev: number; hdg: number; side: number;
}
export interface Airport {
  ident: string; name: string; type: number; lat: number; lon: number; elevM: number; city: string; country: string;
  runways: Runway[]; x: number; z: number; built: boolean; group?: THREE.Group; obstacles: Obstacle[]; elevReady: boolean;
  tower?: THREE.Vector3;
}
export interface Obstacle { min: THREE.Vector3; max: THREE.Vector3; kind: string }
type RawRwy = [string, string, number, number, number, number, number, number, number, number, number];
type RawApt = [string, string, number, number, number, number, RawRwy[], string, string];

export class AirportDB {
  list: Airport[] = [];
  byId = new Map<string, Airport>();
  private grid = new Map<string, Airport[]>();
  constructor(public proj: Projection) {}
  async load(url: string) {
    const r = await fetch(url);
    const d = await r.json() as { airports: RawApt[] };
    for (const a of d.airports) {
      const apt: Airport = {
        ident: a[0], name: a[1], type: a[2], lat: a[3], lon: a[4], elevM: a[5] * 0.3048, city: a[7], country: a[8],
        runways: [], x: 0, z: 0, built: false, obstacles: [], elevReady: false
      };
      for (const w of a[6]) {
        const len = w[6], wid = w[7];
        const hasIls = apt.type >= 1 && len >= 1800;
        const e1: RunwayEnd = { ident: w[0], lat: w[2], lon: w[3], x: 0, z: 0, hdg: 0, disp: w[8], ils: hasIls };
        const e2: RunwayEnd = { ident: w[1], lat: w[4], lon: w[5], x: 0, z: 0, hdg: 0, disp: w[9], ils: hasIls };
        apt.runways.push({ apt, ends: [e1, e2], length: len, width: wid, concrete: !!w[10], cx: 0, cz: 0, dirx: 0, dirz: -1, elev: apt.elevM, hdg: 0, side: 1 });
      }
      this.list.push(apt);
      this.byId.set(apt.ident, apt);
      const k = `${Math.floor(apt.lat)},${Math.floor(apt.lon)}`;
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(apt);
    }
    this.reproject();
  }
  /** recompute local coordinates (after origin rebase) */
  reproject() {
    const p = this.proj;
    for (const a of this.list) {
      a.x = p.x(a.lon); a.z = p.z(a.lat);
      for (const r of a.runways) {
        for (const e of r.ends) { e.x = p.x(e.lon); e.z = p.z(e.lat); }
        const [e1, e2] = r.ends;
        const dx = e2.x - e1.x, dz = e2.z - e1.z, L = Math.hypot(dx, dz) || 1;
        r.dirx = dx / L; r.dirz = dz / L;
        r.cx = (e1.x + e2.x) / 2; r.cz = (e1.z + e2.z) / 2;
        // geometric length from coordinates (OurAirports length may include stopways)
        r.length = L;
        r.hdg = wrap360(Math.atan2(r.dirx, -r.dirz) / DEG);
        e1.hdg = r.hdg; e2.hdg = wrap360(r.hdg + 180);
        // terminal side: towards airport reference point, else right side
        const px = -r.dirz, pz = r.dirx;
        const s = (a.x - r.cx) * px + (a.z - r.cz) * pz;
        r.side = Math.abs(s) > 30 ? Math.sign(s) : 1;
      }
    }
  }
  near(lat: number, lon: number, radiusM: number, minType = 0): Airport[] {
    const out: Airport[] = [];
    const dl = Math.ceil(radiusM / 111000) + 1;
    for (let la = Math.floor(lat) - dl; la <= Math.floor(lat) + dl; la++)
      for (let lo = Math.floor(lon) - dl * 2; lo <= Math.floor(lon) + dl * 2; lo++)
        for (const a of this.grid.get(`${la},${lo}`) ?? [])
          if (a.type >= minType && haversine(lat, lon, a.lat, a.lon) <= radiusM) out.push(a);
    return out.sort((a, b) => haversine(lat, lon, a.lat, a.lon) - haversine(lat, lon, b.lat, b.lon));
  }
}

// ---------------------------------------------------------------- flattening helpers
export interface FlatRect { cx: number; cz: number; ax: number; az: number; halfL: number; halfW0: number; halfW1: number; elev: number; blend: number }
/** Areas that terrain + physics flatten to runway elevation (runway, shoulders, taxiway, apron). */
export function flatRects(apt: Airport): FlatRect[] {
  const out: FlatRect[] = [];
  for (const r of apt.runways) {
    const tw = r.width / 2 + 165 + 120 + 300; // runway + parallel taxiway + apron + terminal
    out.push({ cx: r.cx, cz: r.cz, ax: r.dirx, az: r.dirz, halfL: r.length / 2 + 320, halfW0: r.side > 0 ? r.width / 2 + 70 : tw, halfW1: r.side > 0 ? tw : r.width / 2 + 70, elev: r.elev, blend: 380 });
  }
  return out;
}
/** returns blend weight 0..1 of being on the flat area */
export function flatWeight(f: FlatRect, x: number, z: number) {
  const dx = x - f.cx, dz = z - f.cz;
  const a = Math.abs(dx * f.ax + dz * f.az);
  const c = -dx * f.az + dz * f.ax; // + toward side +1 (perp = (-az, ax))
  const da = a - f.halfL;
  const dc = c >= 0 ? c - f.halfW1 : -c - f.halfW0;
  const d = Math.max(da, dc, 0) + Math.min(Math.max(da, dc), 0) * 0;
  if (da <= 0 && dc <= 0) return 1;
  const t = clamp(1 - Math.hypot(Math.max(da, 0), Math.max(dc, 0)) / f.blend, 0, 1);
  return d < 0 ? 1 : t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- ILS
export function ilsDeviation(r: Runway, endIdx: 0 | 1, x: number, y: number, z: number) {
  const thr = r.ends[endIdx];
  const sgn = endIdx === 0 ? 1 : -1; // landing direction unit vector
  const ux = r.dirx * sgn, uz = r.dirz * sgn;
  // localizer antenna beyond far end
  const lx = thr.x + ux * (r.length + 300), lz = thr.z + uz * (r.length + 300);
  const dx = x - lx, dz = z - lz;
  const along = -(dx * ux + dz * uz);
  const lat = -dx * uz + dz * ux;
  const locDeg = Math.atan2(lat, along) / DEG;
  // glideslope from aim point 300 m past threshold
  const gx = thr.x + ux * (300 + thr.disp), gz = thr.z + uz * (300 + thr.disp);
  const gd = -((x - gx) * ux + (z - gz) * uz);
  const gsAng = Math.atan2(y - r.elev, Math.max(1, gd)) / DEG;
  return { loc: clamp(locDeg / 1.25, -2.5, 2.5), gs: clamp((gsAng - 3) / 0.35, -2.5, 2.5), dist: gd, valid: gd > 0 && gd < 35000 && Math.abs(locDeg) < 35 };
}

// ---------------------------------------------------------------- 3D builder
const glyphs = '0123456789LRC';
let glyphTex: THREE.CanvasTexture | null = null;
function glyphAtlas() {
  if (glyphTex) return glyphTex;
  const cw = 64, ch = 128, c = document.createElement('canvas');
  c.width = cw * glyphs.length; c.height = ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 118px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  for (let i = 0; i < glyphs.length; i++) {
    g.save(); g.translate(i * cw + cw / 2, ch / 2 + 4); g.scale(0.62, 1); g.fillText(glyphs[i], 0, 0); g.restore();
  }
  glyphTex = new THREE.CanvasTexture(c);
  glyphTex.anisotropy = 8; glyphTex.colorSpace = THREE.SRGBColorSpace;
  return glyphTex;
}

const runwayVS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 rw; varying vec2 vRw; varying float vDist; varying vec3 vWorld;
  void main() {
    vRw = rw;
    vec3 transformed = position;
    ${curvedProject}
    vDist = length(wPos.xyz - cameraPosition); vWorld = (modelMatrix * vec4(position,1.0)).xyz;
    #include <logdepthbuf_vertex>
  }`;
const runwayFS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uL, uW, uT1, uT2, uMode, uConcrete, uNight, uRain, uTime; uniform vec3 uSunDir, uSunColor, uAmbient;
  uniform float uKeys, uIls1, uIls2;
  varying vec2 vRw; varying float vDist; varying vec3 vWorld;
  ${fogGLSL}
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float band(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }
  float box(vec2 p, vec2 a, vec2 b, vec2 w) { return band(p.x, a.x, b.x, w.x) * band(p.y, a.y, b.y, w.y); }
  // markings measured from one threshold: d = distance past threshold, c = lateral (m)
  float endMarks(float d, float c, float hw, vec2 w, float ils) {
    float m = 0.0;
    // threshold piano keys (6 m after threshold, 30 m long)
    if (d > 4.0 && d < 40.0) {
      float span = hw - 3.0; float sw = span * 2.0 / (uKeys * 2.0 + 1.0);
      float k = abs(c) - sw * 0.5; // central gap
      float s = mod(k, sw * 2.0);
      float inKey = step(0.0, k) * step(abs(c), span) * band(s, 0.0, sw, w.y);
      m = max(m, inKey * band(d, 6.0, 36.0, w.x));
    }
    // aiming point (300 m, 45 m long)
    m = max(m, box(vec2(d, abs(c)), vec2(300.0, hw * 0.33), vec2(345.0, hw * 0.33 + max(6.0, hw * 0.2)), w));
    // touchdown zone markings (only precision runways)
    if (ils > 0.5) {
      for (int i = 0; i < 6; i++) {
        float at = 150.0 + 150.0 * float(i);
        if (abs(at - 300.0) < 1.0) continue;
        float bars = (i < 2) ? 3.0 : ((i < 4) ? 2.0 : 1.0);
        float x0 = hw * 0.33;
        for (int b = 0; b < 3; b++) {
          if (float(b) >= bars) break;
          float lo = x0 + float(b) * 3.0;
          m = max(m, box(vec2(d, abs(c)), vec2(at, lo), vec2(at + 22.5, lo + 1.8), w));
        }
      }
    }
    // threshold bar
    m = max(m, band(d, 0.0, 1.8, w.x) * step(abs(c), hw - 1.0));
    return m;
  }
  void main() {
    #include <logdepthbuf_fragment>
    float a = vRw.x, c = vRw.y, hw = uW * 0.5;
    vec2 w = vec2(fwidth(a), fwidth(c)) * 0.75 + 0.02;
    vec3 asphalt = mix(vec3(0.105, 0.11, 0.115), vec3(0.42, 0.42, 0.40), uConcrete);
    float n = noise(vec2(a, c) * 0.6) * 0.5 + noise(vec2(a, c) * 3.1) * 0.3 + noise(vec2(a * 0.05, c * 0.4)) * 0.4;
    vec3 col = asphalt * (0.82 + 0.3 * n);
    float paint = 0.0; vec3 paintCol = vec3(0.92);
    if (uMode < 0.5) {
      // runway
      if (abs(c) > hw) { col *= 0.72; }  // shoulders
      // tyre marks around touchdown zones
      float d1 = a - uT1, d2 = uT2 - a;
      float tz = max(band(d1, 120.0, 900.0, 40.0), band(d2, 120.0, 900.0, 40.0));
      float streak = noise(vec2(c * 1.7, a * 0.012)) * band(abs(c), 0.0, 9.0, 2.0);
      col *= 1.0 - 0.5 * tz * streak;
      if (abs(c) <= hw) {
        paint = max(paint, band(abs(c), hw - 1.9, hw - 1.0, w.y)); // edge lines
        float cl = band(abs(c), 0.0, 0.45, w.y) * band(mod(a - uT1 - 60.0, 50.0), 0.0, 30.0, w.x);
        paint = max(paint, cl * step(uT1 + 60.0, a) * step(a, uT2 - 60.0));
        if (d1 > -1.0) paint = max(paint, endMarks(d1, c, hw, w, uIls1));
        if (d2 > -1.0) paint = max(paint, endMarks(d2, -c, hw, w, uIls2));
        // displaced threshold: arrows region shown as dashed centre line already; mark area before threshold yellow-ish
        if (d1 < 0.0 || d2 < 0.0) col *= 0.9;
      }
    } else {
      // taxiway / apron: yellow centre line + edges
      paintCol = vec3(0.95, 0.72, 0.12);
      if (uMode > 2.5) {
        col *= 0.8;
      } else if (uMode < 1.5) {
        paint = max(paint, band(abs(c), 0.0, 0.18, w.y));
        paint = max(paint, band(abs(c), hw - 0.6, hw - 0.3, w.y) + band(abs(c), hw - 1.2, hw - 0.9, w.y));
      } else {
        col = mix(col, vec3(0.45, 0.45, 0.44), 0.7);
        paint = max(paint, band(mod(a, 60.0), 0.0, 0.25, w.x) * step(mod(c, 40.0), 26.0) * 0.8);
      }
    }
    // distance fade of fine paint (avoid shimmer)
    paint *= clamp(1.0 - (max(w.x, w.y) - 0.6) / 2.0, 0.0, 1.0);
    col = mix(col, paintCol * (0.9 + 0.1 * n), paint * 0.92);
    // wet runway: darker + specular sheen
    col *= 1.0 - 0.28 * uRain;
    float diff = max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0);
    vec3 lit = col * (uAmbient * 0.9 + uSunColor * diff * 0.75);
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 h = normalize(v + uSunDir);
    lit += uSunColor * pow(max(h.y, 0.0), 60.0) * (0.04 + 0.5 * uRain) * (1.0 - uNight);
    gl_FragColor = vec4(applyFog(lit, vDist), 1.0);
    #include <colorspace_fragment>
  }`;

const lightVS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 colA; attribute vec3 colB; attribute vec4 info; // info: size, dirx, dirz, kind
  attribute float papi; attribute float phase;
  uniform float uNight, uTime, uPx, uLightBoost; uniform float uFogDensity;
  varying vec3 vCol; varying float vA;
  void main() {
    vec3 transformed = position;
    ${curvedProject}
    vec3 toCam = cameraPosition - wPos.xyz;
    float dist = length(toCam);
    vec2 d = info.yz;
    vec3 col = colA;
    float vis = 1.0;
    if (dot(d, d) > 0.0) {
      float f = dot(normalize(toCam.xz), d);
      if (info.w > 1.5) { vis = smoothstep(-0.2, 0.35, f); } // unidirectional approach light
      else col = f >= 0.0 ? colA : colB;                   // bidirectional colour
    }
    if (papi > 0.0) {
      float ang = degrees(atan(toCam.y, length(toCam.xz)));
      col = ang > papi ? vec3(1.0, 0.95, 0.9) : vec3(1.0, 0.08, 0.05);
      vis *= smoothstep(-0.1, 0.4, dot(normalize(toCam.xz), d));
    }
    if (phase >= 0.0) { // sequenced flashers ("rabbit")
      float t = fract(uTime * 2.0 - phase);
      vis *= step(t, 0.06) * 1.6;
    }
    float bright = mix(uLightBoost, 1.0, uNight);
    float fog = exp(-pow(uFogDensity * dist, 1.35) * 0.55);
    vCol = col * bright * fog; vA = vis;
    float px = info.x * uPx / max(dist, 1.0);
    gl_PointSize = clamp(px * (0.5 + uNight * 1.2), 1.4, 26.0) * (vis > 0.01 ? 1.0 : 0.0);
    #include <logdepthbuf_vertex>
  }`;
const lightFS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vCol; varying float vA;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
    if (r > 1.0 || vA < 0.01) discard;
    float core = exp(-r * 7.0), halo = exp(-r * 2.2) * 0.35;
    gl_FragColor = vec4(vCol * (core * 1.6 + halo) * vA, 1.0);
  }`;

export const lightUniforms = { uPx: { value: 800 } };

class LightBuilder {
  pos: number[] = []; colA: number[] = []; colB: number[] = []; info: number[] = []; papi: number[] = []; phase: number[] = [];
  add(x: number, y: number, z: number, a: number[], b: number[] | null, size: number, dx = 0, dz = 0, kind = 0, papi = 0, phase = -1) {
    this.pos.push(x, y, z); this.colA.push(...a); this.colB.push(...(b ?? a)); this.info.push(size, dx, dz, kind); this.papi.push(papi); this.phase.push(phase);
  }
  build(): THREE.Points | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('colA', new THREE.Float32BufferAttribute(this.colA, 3));
    g.setAttribute('colB', new THREE.Float32BufferAttribute(this.colB, 3));
    g.setAttribute('info', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('papi', new THREE.Float32BufferAttribute(this.papi, 1));
    g.setAttribute('phase', new THREE.Float32BufferAttribute(this.phase, 1));
    g.computeBoundingSphere();
    const m = new THREE.ShaderMaterial({
      vertexShader: lightVS, fragmentShader: lightFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uNight: env.uNight, uTime: env.uTime, uPx: lightUniforms.uPx, uFogDensity: env.uFogDensity, uLightBoost: env.uLightBoost }
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false; p.renderOrder = 5;
    return p;
  }
}

const WHITE = [1, 0.95, 0.85], YELLOW = [1, 0.8, 0.35], GREEN = [0.25, 1, 0.4], RED = [1, 0.12, 0.08], BLUE = [0.3, 0.45, 1], AMBER = [1, 0.6, 0.15];

function runwayMaterial(mode: number, r: Runway | null, L: number, W: number) {
  const m = new THREE.ShaderMaterial({
    vertexShader: runwayVS, fragmentShader: runwayFS,
    uniforms: {
      uL: { value: L }, uW: { value: W }, uT1: { value: r ? r.ends[0].disp : 0 }, uT2: { value: r ? L - r.ends[1].disp : L },
      uMode: { value: mode }, uConcrete: { value: r?.concrete ? 1 : mode === 2 ? 1 : 0 }, uKeys: { value: W >= 58 ? 8 : W >= 44 ? 6 : W >= 29 ? 4 : 3 },
      uIls1: { value: r?.ends[0].ils ? 1 : 0 }, uIls2: { value: r?.ends[1].ils ? 1 : 0 },
      uNight: env.uNight, uRain: env.uRain, uTime: env.uTime, uSunDir: env.uSunDir, uSunColor: env.uSunColor, uAmbient: env.uAmbient,
      uFogColor: env.uFogColor, uFogDensity: env.uFogDensity
    },
    polygonOffset: true, polygonOffsetFactor: -2 - mode, polygonOffsetUnits: -4 - mode * 2
  });
  m.extensions = { derivatives: true } as any;
  return m;
}

/** strip of quads along a direction with rw attribute (along, across) in metres */
function strip(x0: number, z0: number, ax: number, az: number, L: number, W: number, y: number, segL = 200): THREE.BufferGeometry {
  const px = -az, pz = ax;
  const n = Math.max(1, Math.ceil(L / segL));
  const pos: number[] = [], rw: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = L * i / n;
    for (const s of [-1, 1]) {
      const c = s * W / 2;
      pos.push(x0 + ax * a + px * c, y, z0 + az * a + pz * c);
      rw.push(a, c);
    }
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('rw', new THREE.Float32BufferAttribute(rw, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function boxGeo(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rot: number, color: THREE.Color, geos: THREE.BufferGeometry[]) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.rotateY(rot);
  g.translate(cx, cy + sy / 2, cz);
  const c = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < c.length; i += 3) { c[i] = color.r; c[i + 1] = color.g; c[i + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geos.push(g);
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  const parts = geos.map(g => g.index ? g.toNonIndexed() : g);
  for (const g of parts) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

let bldMat: THREE.MeshLambertMaterial | null = null;
let winMat: THREE.MeshBasicMaterial | null = null;
let decalMat: THREE.MeshBasicMaterial | null = null;
function materials() {
  if (!bldMat) {
    bldMat = curve(new THREE.MeshLambertMaterial({ vertexColors: true }));
    winMat = curve(new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.0 }));
    decalMat = curve(new THREE.MeshBasicMaterial({ map: glyphAtlas(), transparent: true, depthWrite: false, color: 0xe8e8e8, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }));
  }
  return { bldMat: bldMat!, winMat: winMat!, decalMat: decalMat! };
}
export function setAirportNight(night: number) {
  const { winMat, decalMat } = materials();
  winMat.opacity = night * 0.9;
  decalMat.color.setScalar(0.92 - night * 0.75);
}

/** designator e.g. "16L" → glyph quads placed after the threshold keys */
function designator(ident: string, thrX: number, thrZ: number, ux: number, uz: number, y: number, along: number, W: number): THREE.BufferGeometry {
  const m = /^(\d{1,2})([LRC]?)$/.exec(ident.trim());
  const num = m ? m[1].padStart(2, '0') : ident.slice(0, 2);
  const letter = m?.[2] ?? '';
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const px = -uz, pz = ux; // right of landing direction
  const gh = 9, gw = 3.6;  // glyph height (m) along runway, width across
  const quad = (ch: string, a: number, c: number) => {
    const gi = glyphs.indexOf(ch); if (gi < 0) return;
    const u0 = gi / glyphs.length, u1 = (gi + 1) / glyphs.length;
    const k = pos.length / 3;
    // reading upright from the approach: bottom of glyph nearest threshold
    const pts: [number, number, number, number][] = [[a, c - gw / 2, u0, 0], [a, c + gw / 2, u1, 0], [a + gh, c + gw / 2, u1, 1], [a + gh, c - gw / 2, u0, 1]];
    for (const [aa, cc, uu, vv] of pts) { pos.push(thrX + ux * aa + px * cc, y, thrZ + uz * aa + pz * cc); uv.push(uu, vv); }
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
  };
  const scale = clamp(W / 45, 0.6, 1.2);
  if (num.length === 2) { quad(num[0], along, -2.6 * scale); quad(num[1], along, 2.6 * scale); }
  if (letter) quad(letter, along + gh + 6, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildAirport(apt: Airport): THREE.Group {
  const grp = new THREE.Group();
  grp.name = 'apt-' + apt.ident;
  const L = new LightBuilder();
  const blds: THREE.BufferGeometry[] = [], wins: THREE.BufferGeometry[] = [];
  const mats = materials();
  apt.obstacles = [];
  const big = apt.type === 2, med = apt.type === 1;
  const rnd = mulberry(hashStr(apt.ident));

  apt.runways.forEach((r, ri) => {
    const [e1, e2] = r.ends;
    const W = r.width, y = r.elev + 0.12;
    const ax = r.dirx, az = r.dirz, px = -az, pz = ax;
    // shoulders + blast pads (one slightly wider dark strip under the runway)
    const sh = new THREE.Mesh(strip(e1.x - ax * 60, e1.z - az * 60, ax, az, r.length + 120, W + 15, y - 0.04), runwayMaterial(1.0, null, r.length + 120, W + 15));
    (sh.material as THREE.ShaderMaterial).uniforms.uMode.value = 3; // plain asphalt
    grp.add(sh);
    const rm = new THREE.Mesh(strip(e1.x, e1.z, ax, az, r.length, W, y), runwayMaterial(0, r, r.length, W));
    rm.renderOrder = 1; grp.add(rm);
    // designators
    const d1 = designator(e1.ident, e1.x + ax * e1.disp, e1.z + az * e1.disp, ax, az, y + 0.02, 44, W);
    const d2 = designator(e2.ident, e2.x - ax * e2.disp, e2.z - az * e2.disp, -ax, -az, y + 0.02, 44, W);
    grp.add(new THREE.Mesh(d1, mats.decalMat), new THREE.Mesh(d2, mats.decalMat));

    // --- runway lights
    const hw = W / 2 + 1.5;
    for (let a = 0; a <= r.length + 0.1; a += 60) {
      const fromEnd2 = r.length - a;
      for (const s of [-1, 1]) {
        const lx = e1.x + ax * a + px * s * hw, lz = e1.z + az * a + pz * s * hw;
        // last 600 m appear yellow in each landing direction
        const colTowardE1Approach = fromEnd2 < 600 ? YELLOW : WHITE; // seen by plane landing from e1 (looking toward e2)
        const colTowardE2Approach = a < 600 ? YELLOW : WHITE;
        L.add(lx, y + 0.4, lz, colTowardE2Approach, colTowardE1Approach, 2.6, ax, az, 0);
      }
    }
    if (r.ends.some(e => e.ils) || r.length > 2400) {
      for (let a = 7.5; a < r.length; a += 15) {
        const fe = r.length - a; // for e1 landers, remaining distance
        const cA = a < 300 ? RED : a < 900 ? ((Math.round(a / 15) % 2) ? RED : WHITE) : WHITE;      // seen by e2 landers
        const cB = fe < 300 ? RED : fe < 900 ? ((Math.round(a / 15) % 2) ? RED : WHITE) : WHITE;    // seen by e1 landers
        L.add(e1.x + ax * a, y + 0.15, e1.z + az * a, cA, cB, 1.5, ax, az, 0);
      }
    }
    // threshold / end bars (green toward approach, red toward runway)
    for (const [k, e] of [[0, e1], [1, e2]] as const) {
      const sg = k === 0 ? 1 : -1, ux = ax * sg, uz = az * sg;
      const tx = e.x + ux * e.disp, tz = e.z + uz * e.disp;
      for (let c = -W / 2 - 4; c <= W / 2 + 4.01; c += 3) {
        const lx = tx + px * c, lz = tz + pz * c;
        L.add(lx, y + 0.3, lz, RED, GREEN, 2.4, ux, uz, 0); // in front (from runway) red, behind (approach) green
      }
      // touchdown zone lights (900 m, two barrettes)
      if (e.ils) for (let a = 60; a <= 900; a += 30) for (const s of [-1, 1]) for (let q = 0; q < 3; q++) {
        const c = s * (9 + q * 1.5);
        L.add(tx + ux * a + px * c, y + 0.15, tz + uz * a + pz * c, WHITE, WHITE, 1.2, -ux, -uz, 2);
      }
      // PAPI on the left at ~ aiming point
      const pa = 330, side = -1;
      const angles = [2.5, 2.833, 3.167, 3.5]; // outer → inner
      for (let i = 0; i < 4; i++) {
        const c = side * (W / 2 + 15 + (3 - i) * 9);
        const qx = tx + ux * pa + px * c * sg, qz = tz + uz * pa + pz * c * sg;
        L.add(qx, y + 0.8, qz, WHITE, WHITE, 4.5, -ux, -uz, 0, angles[i]);
      }
      // approach lighting system (ALS) 900 m with crossbar + sequenced flashers
      if (e.ils) {
        for (let a = 30; a <= 900; a += 30) {
          const bx = tx - ux * a, bz = tz - uz * a;
          for (let q = -2; q <= 2; q++) L.add(bx + px * q * 1.0, y + 1.5 + a * 0.006, bz + pz * q * 1.0, WHITE, WHITE, 2.2, -ux, -uz, 2);
          if (a === 300) for (let q = -7; q <= 7; q++) if (Math.abs(q) > 2) L.add(bx + px * q * 2.2, y + 3.3, bz + pz * q * 2.2, WHITE, WHITE, 2.2, -ux, -uz, 2);
          if (a >= 330) L.add(bx, y + 2.0 + a * 0.006, bz, [1, 1, 1], null, 5, -ux, -uz, 2, 0, (900 - a) / 600);
        }
        apt.obstacles.push({ min: new THREE.Vector3(Math.min(tx, tx - ux * 900) - 3, y, Math.min(tz, tz - uz * 900) - 3), max: new THREE.Vector3(Math.max(tx, tx - ux * 900) + 3, y + 7, Math.max(tz, tz - uz * 900) + 3), kind: 'als' });
      }
    }

    // --- parallel taxiway, connectors, apron, buildings on the terminal side
    const s = r.side;
    const toff = W / 2 + 165;
    const tw = 23;
    const tL = r.length * 0.94, t0 = r.length * 0.03;
    const tx0 = e1.x + ax * t0 + px * s * toff, tz0 = e1.z + az * t0 + pz * s * toff;
    const twm = new THREE.Mesh(strip(tx0, tz0, ax, az, tL, tw, y - 0.02), runwayMaterial(1, null, tL, tw)); twm.renderOrder = 1; grp.add(twm);
    const nConn = Math.max(2, Math.round(r.length / 700));
    for (let i = 0; i <= nConn; i++) {
      const a = t0 + tL * i / nConn;
      const cx = e1.x + ax * a + px * s * (W / 2), cz = e1.z + az * a + pz * s * (W / 2);
      const cm = new THREE.Mesh(strip(cx, cz, px * s, pz * s, toff - W / 2 + tw / 2, tw, y - 0.03), runwayMaterial(1, null, toff, tw)); grp.add(cm);
      for (let q = 10; q < toff - W / 2; q += 15) L.add(cx + px * s * q, y + 0.1, cz + pz * s * q, GREEN, GREEN, 1.0);
    }
    for (let a = 0; a < tL; a += 30) for (const q of [-1, 1]) L.add(tx0 + ax * a + px * q * (tw / 2 + 1), y + 0.3, tz0 + az * a + pz * q * (tw / 2 + 1), BLUE, BLUE, 1.4);
    if (ri === 0 || big) {
      const apronW = big ? 260 : med ? 170 : 90, apronL = r.length * (big ? 0.55 : 0.4);
      const aOff = toff + tw / 2 + 25 + apronW / 2;
      const ac = r.length * (0.35 + rnd() * 0.3);
      const ax0 = e1.x + ax * (ac - apronL / 2) + px * s * aOff, az0 = e1.z + az * (ac - apronL / 2) + pz * s * aOff;
      grp.add(new THREE.Mesh(strip(ax0, az0, ax, az, apronL, apronW, y - 0.02), runwayMaterial(2, null, apronL, apronW)));
      // terminal
      const bOff = aOff + apronW / 2 + 40;
      const tLen = apronL * 0.8, tDep = big ? 70 : 45, tH = big ? 22 : 14;
      const bx = e1.x + ax * ac + px * s * bOff, bz = e1.z + az * ac + pz * s * bOff;
      const rot = Math.atan2(-ax, -az);
      boxGeo(bx, y, bz, tDep, tH, tLen, rot, new THREE.Color(0.72, 0.74, 0.77), blds);
      boxGeo(bx - px * s * 0.5, y + tH * 0.35, bz - pz * s * 0.5, tDep + 1, tH * 0.32, tLen + 1, rot, new THREE.Color(0.18, 0.28, 0.36), blds);
      boxGeo(bx - px * s * 1, y + tH * 0.35, bz - pz * s * 1, tDep + 1.2, tH * 0.28, tLen * 0.98, rot, new THREE.Color(1, 1, 1), wins);
      apt.obstacles.push(aabbOf(bx, bz, y, tDep, tH, tLen, rot, 'terminal'));
      // jet bridges
      if (big || med) for (let k = -3; k <= 3; k++) {
        const gx = bx + ax * k * tLen / 8 - px * s * (tDep / 2 + 18), gz = bz + az * k * tLen / 8 - pz * s * (tDep / 2 + 18);
        boxGeo(gx, y + 4, gz, 36, 3.5, 4, rot, new THREE.Color(0.8, 0.8, 0.82), blds);
      }
      // tower
      const tox = e1.x + ax * (ac + apronL / 2 + 120) + px * s * (bOff - 20), toz = e1.z + az * (ac + apronL / 2 + 120) + pz * s * (bOff - 20);
      const th = big ? 85 : med ? 45 : 22;
      boxGeo(tox, y, toz, 9, th, 9, rot, new THREE.Color(0.8, 0.8, 0.8), blds);
      boxGeo(tox, y + th, toz, 16, 6, 16, rot, new THREE.Color(0.2, 0.32, 0.4), blds);
      boxGeo(tox, y + th + 6, toz, 17, 1.5, 17, rot, new THREE.Color(0.85, 0.85, 0.85), blds);
      boxGeo(tox, y + th + 0.5, toz, 16.4, 5, 16.4, rot, new THREE.Color(1, 1, 1), wins);
      apt.obstacles.push(aabbOf(tox, toz, y, 17, th + 8, 17, rot, 'tower'));
      apt.tower = new THREE.Vector3(tox, y + th + 3, toz);
      L.add(tox, y + th + 8, toz, RED, RED, 3, 0, 0, 0, 0, 0.5);
      // hangars
      const nh = big ? 4 : med ? 2 : 1;
      for (let k = 0; k < nh; k++) {
        const hx = e1.x + ax * (ac - apronL / 2 - 90 - k * 95) + px * s * (aOff + 20), hz = e1.z + az * (ac - apronL / 2 - 90 - k * 95) + pz * s * (aOff + 20);
        boxGeo(hx, y, hz, 75, 24, 80, rot, new THREE.Color(0.6 + rnd() * 0.1, 0.62, 0.66), blds);
        apt.obstacles.push(aabbOf(hx, hz, y, 75, 24, 80, rot, 'hangar'));
      }
      // apron floodlights
      for (let k = 0; k <= 4; k++) {
        const fx = e1.x + ax * (ac - apronL / 2 + apronL * k / 4) + px * s * (aOff + apronW / 2 - 5), fz = e1.z + az * (ac - apronL / 2 + apronL * k / 4) + pz * s * (aOff + apronW / 2 - 5);
        L.add(fx, y + 25, fz, AMBER, AMBER, 6);
      }
    }
  });

  if (blds.length) {
    const bm = new THREE.Mesh(mergeGeos(blds), mats.bldMat); grp.add(bm);
  }
  if (wins.length) { const wm = new THREE.Mesh(mergeGeos(wins), mats.winMat); wm.renderOrder = 2; grp.add(wm); }
  const lp = L.build(); if (lp) grp.add(lp);
  grp.traverse(o => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = true; });
  return grp;
}

function aabbOf(cx: number, cz: number, y: number, sx: number, sy: number, sz: number, rot: number, kind: string): Obstacle {
  const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
  const ex = (sx * c + sz * s) / 2, ez = (sx * s + sz * c) / 2;
  return { min: new THREE.Vector3(cx - ex, y, cz - ez), max: new THREE.Vector3(cx + ex, y + sy, cz + ez), kind };
}
function hashStr(s: string) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function mulberry(a: number) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
