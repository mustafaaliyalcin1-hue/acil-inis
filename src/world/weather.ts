// Wind (with shear), gusts, turbulence, rain, fog/visibility, time of day.
import * as THREE from 'three';
import { KT, DEG, clamp } from '../core/geo';
import { curve } from './curvature';
import { env } from './env';

export interface WeatherState {
  windDir: number;   // deg, FROM
  windKt: number;
  gustKt: number;
  turb: number;      // 0..1
  rain: number;      // 0..1
  visibility: number; // m
  cloud: number;     // 0..1
  hour: number;
}
export const defaultWeather = (): WeatherState => ({ windDir: 240, windKt: 6, gustKt: 0, turb: 0.05, rain: 0, visibility: 60000, cloud: 0.15, hour: 13 });

export class Weather {
  s: WeatherState;
  private t = 0;
  private turbV = new THREE.Vector3();
  private gust = 0;
  rainMesh: THREE.Points | null = null;
  constructor(s: WeatherState = defaultWeather()) { this.s = { ...s }; }
  set(p: Partial<WeatherState>) { Object.assign(this.s, p); }

  /** world wind vector (m/s, direction the air moves) at height above ground */
  wind(agl: number, out = new THREE.Vector3()): THREE.Vector3 {
    const shear = agl < 300 ? clamp(Math.pow(Math.max(agl, 3) / 300, 0.16), 0.45, 1) : 1 + Math.min(1.2, (agl - 300) / 9000);
    const spd = (this.s.windKt + this.gust) * KT * shear;
    const to = (this.s.windDir + 180) * DEG; // blowing towards
    out.set(Math.sin(to) * spd, 0, -Math.cos(to) * spd);
    return out.add(this.turbV);
  }
  step(dt: number, agl: number) {
    this.t += dt;
    // gusts: smoothed random bursts
    const gTarget = this.s.gustKt > 0 ? Math.max(0, Math.sin(this.t * 0.37) * Math.sin(this.t * 0.13 + 1.3)) * this.s.gustKt : 0;
    this.gust += (gTarget - this.gust) * Math.min(1, dt * 1.5);
    // turbulence: first-order filtered noise (Dryden-like), stronger below 1500 m with wind
    const I = (this.s.turb * 4.5 + (this.s.windKt > 15 && agl < 1500 ? (this.s.windKt - 15) * 0.08 : 0)) * (agl < 30 ? agl / 30 : 1);
    const a = Math.min(1, dt * 1.4);
    this.turbV.x += ((Math.random() * 2 - 1) * I * 2.2 - this.turbV.x) * a;
    this.turbV.y += ((Math.random() * 2 - 1) * I * 1.6 - this.turbV.y) * a;
    this.turbV.z += ((Math.random() * 2 - 1) * I * 2.2 - this.turbV.z) * a;
    env.uRain.value = this.s.rain;
  }

  /** rain streak particles around the camera */
  updateRain(scene: THREE.Scene, cam: THREE.Camera, vel: THREE.Vector3, dt: number) {
    if (this.s.rain <= 0.01) { if (this.rainMesh) this.rainMesh.visible = false; return; }
    if (!this.rainMesh) {
      const n = 2500, p = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) p[i] = (Math.random() - 0.5) * 60;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      const m = curve(new THREE.PointsMaterial({ color: 0xaab6c6, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false }));
      this.rainMesh = new THREE.Points(g, m); this.rainMesh.frustumCulled = false;
      scene.add(this.rainMesh);
    }
    this.rainMesh.visible = true;
    const pos = this.rainMesh.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = Math.floor(arr.length / 3 * this.s.rain);
    const fall = 9 * dt;
    for (let i = 0; i < arr.length / 3; i++) {
      if (i > n) { arr[i * 3 + 1] = -1000; continue; }
      arr[i * 3] -= vel.x * dt * 0.15; arr[i * 3 + 1] -= fall + Math.max(0, -vel.y) * dt * 0.1; arr[i * 3 + 2] -= vel.z * dt * 0.15;
      for (const k of [0, 1, 2]) { if (arr[i * 3 + k] < -30) arr[i * 3 + k] += 60; if (arr[i * 3 + k] > 30) arr[i * 3 + k] -= 60; }
    }
    pos.needsUpdate = true;
    this.rainMesh.position.copy(cam.position);
  }
}
