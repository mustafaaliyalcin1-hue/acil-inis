// Lightweight GPU point particles (fuel mist, smoke, fire, tyre smoke, water spray) + detached wing debris.
import * as THREE from 'three';
import { curvedProject } from '../world/curvature';
import type { World } from '../world/world';

const VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size; attribute vec4 col; varying vec4 vCol; uniform float uPx;
  void main() {
    vCol = col;
    vec3 transformed = position;
    ${curvedProject}
    gl_PointSize = clamp(size * uPx / max(1.0, -mvPosition.z), 1.0, 220.0);
    #include <logdepthbuf_vertex>
  }`;
const FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vCol;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p); if (r > 1.0) discard;
    gl_FragColor = vec4(vCol.rgb, vCol.a * (1.0 - r) * (1.0 - r));
  }`;

interface P { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; s0: number; s1: number; r: number; g: number; b: number; a: number; drag: number; rise: number }

export class Particles {
  private list: P[] = [];
  private max = 1800;
  private geo = new THREE.BufferGeometry();
  private pos = new Float32Array(this.max * 3);
  private col = new Float32Array(this.max * 4);
  private size = new Float32Array(this.max);
  points: THREE.Points;
  uPx = { value: 800 };
  constructor(scene: THREE.Scene, blending: THREE.Blending = THREE.NormalBlending) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('col', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { uPx: this.uPx }, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(this.geo, m);
    this.points.frustumCulled = false; this.points.renderOrder = 8;
    scene.add(this.points);
  }
  emit(p: Partial<P> & { x: number; y: number; z: number }) {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ vx: 0, vy: 0, vz: 0, life: 0, max: 2, s0: 1, s1: 4, r: 1, g: 1, b: 1, a: 0.5, drag: 0.5, rise: 0, ...p });
  }
  update(dt: number) {
    const L = this.list;
    let n = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.rise * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const t = p.life / p.max;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.col[n * 4] = p.r; this.col[n * 4 + 1] = p.g; this.col[n * 4 + 2] = p.b; this.col[n * 4 + 3] = p.a * (1 - t);
      this.size[n] = p.s0 + (p.s1 - p.s0) * t;
      L[n] = p; n++;
    }
    L.length = n;
    this.geo.setDrawRange(0, n);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.col as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() { this.list.length = 0; this.geo.setDrawRange(0, 0); }
}

/** a broken-off wing section falling with simple rigid-body physics */
export class Debris {
  vel = new THREE.Vector3(); w = new THREE.Vector3(); rest = false; age = 0;
  constructor(public obj: THREE.Object3D, vel: THREE.Vector3, public world: World) {
    this.vel.copy(vel).add(new THREE.Vector3((Math.random() - 0.5) * 6, 3, (Math.random() - 0.5) * 6));
    this.w.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 4);
  }
  update(dt: number) {
    this.age += dt;
    if (this.rest) return;
    this.vel.y -= 9.81 * dt;
    this.vel.multiplyScalar(Math.exp(-0.35 * dt));
    this.obj.position.addScaledVector(this.vel, dt);
    this.obj.rotation.x += this.w.x * dt; this.obj.rotation.y += this.w.y * dt; this.obj.rotation.z += this.w.z * dt;
    const g = this.world.ground(this.obj.position.x, this.obj.position.z);
    if (this.obj.position.y < g.h + 0.6) {
      this.obj.position.y = g.h + 0.6;
      this.vel.y = Math.abs(this.vel.y) * 0.15; this.vel.x *= 0.6; this.vel.z *= 0.6; this.w.multiplyScalar(0.5);
      if (this.vel.length() < 1) { this.rest = true; if (g.water) this.obj.position.y = g.h - 0.4; }
    }
  }
}
