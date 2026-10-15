// Sky dome, sun/moon lighting, fog and time of day.
import * as THREE from 'three';
import { env } from './env';
import { clamp, lerp, smooth } from '../core/geo';

const skyVS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w * 0.99999;
    #include <logdepthbuf_vertex>
  }`;
const skyFS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSunDir, uZenith, uHorizon, uSunColor, uFogColor; uniform float uNight, uFogDensity, uCloud;
  varying vec3 vDir;
  float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 d = normalize(vDir);
    float e = clamp(d.y, -0.2, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(clamp(e, 0.0, 1.0), 0.55));
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 12.0) * 0.25) * (1.0 - uNight * 0.95) * (1.0 - uCloud * 0.8);
    // stars
    if (uNight > 0.3 && d.y > 0.0) {
      vec3 q = floor(d * 380.0);
      float s = step(0.9975, h(q)) * (uNight - 0.3) * 1.4 * (1.0 - uCloud);
      col += vec3(s);
    }
    // overcast / fog: blend toward fog colour near the horizon
    float fogAmt = clamp(uFogDensity * 9000.0, 0.0, 1.0);
    col = mix(col, uFogColor, clamp(max(fogAmt, uCloud * 0.7) * (1.0 - smoothstep(0.0, 0.5, e) * (1.0 - fogAmt)), 0.0, 1.0));
    col = mix(col, uFogColor, smoothstep(0.05, -0.05, d.y));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

export class Sky {
  mesh: THREE.Mesh;
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3326, 1.0);
  uni = {
    uSunDir: env.uSunDir, uSunColor: env.uSunColor, uNight: env.uNight, uFogColor: env.uFogColor, uFogDensity: env.uFogDensity,
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uCloud: { value: 0 }
  };
  hour = 12;
  visibility = 60000; // m
  cloud = 0;
  constructor(scene: THREE.Scene) {
    const g = new THREE.SphereGeometry(1, 32, 16);
    const m = new THREE.ShaderMaterial({ vertexShader: skyVS, fragmentShader: skyFS, uniforms: this.uni, side: THREE.BackSide, depthWrite: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.scale.setScalar(1000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh, this.sun, this.hemi, this.sun.target);
    scene.fog = new THREE.FogExp2(0xffffff, 0.00001);
  }
  /** hour 0..24, day of year ~ Oct, latitude 41° */
  update(cam: THREE.Camera, scene: THREE.Scene) {
    this.mesh.position.copy(cam.position);
    const t = (this.hour - 12) / 24 * Math.PI * 2;
    const decl = -9 * Math.PI / 180, lat = 41 * Math.PI / 180;
    const alt = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(t));
    const az = Math.atan2(Math.sin(t), Math.cos(t) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
    const sun = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const el = alt * 180 / Math.PI;
    const day = smooth(-6, 6, el);            // 0 night → 1 day
    const golden = smooth(14, 0, el) * smooth(-7, 1, el);
    const night = 1 - day;
    env.uNight.value = night;
    // light dir used by shaders: below horizon use moon (opposite-ish, dim)
    const ldir = el > -4 ? sun.clone() : new THREE.Vector3(-sun.x, Math.abs(sun.y) * 0.6 + 0.3, -sun.z).normalize();
    env.uSunDir.value.copy(ldir.y < 0.05 ? ldir.setY(0.05).normalize() : ldir);
    const sunCol = new THREE.Color(1, 0.96, 0.9).lerp(new THREE.Color(1, 0.55, 0.28), golden);
    const moonCol = new THREE.Color(0.32, 0.38, 0.52);
    const cloudDim = 1 - this.cloud * 0.55;
    env.uSunColor.value.copy(sunCol).multiplyScalar(day * cloudDim).add(moonCol.clone().multiplyScalar(night * 0.25));
    const amb = new THREE.Color(0.55, 0.62, 0.72).multiplyScalar(lerp(0.09, 1, day)).lerp(new THREE.Color(0.62, 0.5, 0.42), golden * 0.4);
    env.uAmbient.value.copy(amb.multiplyScalar(lerp(1, 0.9, this.cloud)));
    const zen = new THREE.Color(0.18, 0.38, 0.75).multiplyScalar(day).add(new THREE.Color(0.01, 0.015, 0.04));
    const hor = new THREE.Color(0.62, 0.74, 0.88).multiplyScalar(day).lerp(new THREE.Color(0.95, 0.55, 0.32), golden * 0.8).add(new THREE.Color(0.02, 0.03, 0.06));
    const grey = new THREE.Color(0.55, 0.58, 0.62).multiplyScalar(lerp(0.06, 1, day));
    zen.lerp(grey, this.cloud * 0.85); hor.lerp(grey, this.cloud * 0.7);
    this.uni.uZenith.value.copy(zen); this.uni.uHorizon.value.copy(hor); this.uni.uCloud.value = this.cloud;
    env.uSkyColor.value.copy(hor).lerp(zen, 0.4);
    // fog: visibility (m) → density
    const vis = Math.max(150, this.visibility);
    env.uFogDensity.value = 2.6 / vis;
    env.uFogColor.value.copy(hor).lerp(grey, clamp(1 - vis / 20000, 0, 1) * 0.8);
    const f = scene.fog as THREE.FogExp2;
    f.color.copy(env.uFogColor.value); f.density = 2.0 / vis;
    this.sun.position.copy(cam.position).addScaledVector(env.uSunDir.value, 5000);
    this.sun.target.position.copy(cam.position);
    this.sun.color.copy(env.uSunColor.value);
    this.sun.intensity = 2.4;
    this.hemi.color.copy(env.uAmbient.value).multiplyScalar(1.4);
    this.hemi.groundColor.copy(env.uAmbient.value).multiplyScalar(0.5);
    this.hemi.intensity = 1.0;
    env.uLightBoost.value = lerp(0.22, 0.6, clamp(1 - vis / 8000, 0, 1));
    return { el, night };
  }
}
