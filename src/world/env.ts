// Shared environment uniforms used by every custom shader (sun, fog, night, time).
import * as THREE from 'three';

export const env = {
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
  uAmbient: { value: new THREE.Color(0.55, 0.6, 0.68) },
  uFogColor: { value: new THREE.Color(0.7, 0.78, 0.88) },
  uFogDensity: { value: 0.000012 },
  uNight: { value: 0 },
  uTime: { value: 0 },
  uSkyColor: { value: new THREE.Color(0.45, 0.62, 0.85) },
  uRain: { value: 0 },
  uLightBoost: { value: 0.35 }
};

export const fogGLSL = /* glsl */ `
  uniform vec3 uFogColor; uniform float uFogDensity;
  vec3 applyFog(vec3 c, float dist) {
    float f = 1.0 - exp(-pow(uFogDensity * dist, 1.35));
    return mix(c, uFogColor, clamp(f, 0.0, 1.0));
  }
`;
