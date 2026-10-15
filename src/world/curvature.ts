// Visual earth curvature: vertices drop by d²/2R relative to the camera (physics stays flat).
import * as THREE from 'three';
import { R_EARTH } from '../core/geo';

export const CURV = 1 / (2 * R_EARTH);

/** GLSL: transform `position` to clip space with curvature + log depth (needs logdepthbuf chunks). */
export const curvedProject = /* glsl */ `
  vec4 wPos = modelMatrix * vec4(transformed, 1.0);
  vec2 dCam = wPos.xz - cameraPosition.xz;
  wPos.y -= dot(dCam, dCam) * ${CURV.toExponential(8)};
  vec4 mvPosition = viewMatrix * wPos;
  gl_Position = projectionMatrix * mvPosition;
`;

/** Patch a built-in material so it follows the curvature. */
export function curve<T extends THREE.Material>(m: T): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
      #ifdef USE_INSTANCING
        vec4 wPos = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      #else
        vec4 wPos = modelMatrix * vec4(transformed, 1.0);
      #endif
      vec2 dCam = wPos.xz - cameraPosition.xz;
      wPos.y -= dot(dCam, dCam) * ${CURV.toExponential(8)};
      vec4 mvPosition = viewMatrix * wPos;
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  m.customProgramCacheKey = () => 'curved';
  return m;
}
