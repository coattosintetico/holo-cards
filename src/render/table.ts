import * as THREE from 'three';
import { NOISE } from './glsl';

/** Warm linen tablecloth under a soft lamp. Deliberately low-contrast. */
export function createTable(): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uView: { value: new THREE.Vector2(16, 10) },
      uTime: { value: 0 },
      uDim: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPos = w.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uView;
      uniform float uTime;
      uniform float uDim;
      varying vec2 vPos;
      ${NOISE}
      void main() {
        vec2 p = vPos;

        // Large, soft folds in the cloth.
        float folds = fbm(p * 0.16 + vec2(3.1, 1.7));
        float folds2 = fbm(p * 0.05 + vec2(-2.0, 5.0));

        // Plain weave: alternating over/under threads with slubs.
        float f = 22.0;
        vec2 q = p * f;
        vec2 cell = floor(q);
        vec2 fr = fract(q);
        float over = mod(cell.x + cell.y, 2.0);
        float slubX = vnoise(vec2(cell.x * 1.7, p.y * 2.5));
        float slubY = vnoise(vec2(p.x * 2.5, cell.y * 1.3));
        float warp = sin(fr.x * 3.14159) * (0.75 + 0.5 * slubX);
        float weft = sin(fr.y * 3.14159) * (0.75 + 0.5 * slubY);
        float h = mix(weft, warp, over);
        float fw = length(fwidth(q));
        float weave = mix(0.6, h, 1.0 - smoothstep(0.3, 0.9, fw));

        vec3 deep = vec3(0.30, 0.13, 0.09);
        vec3 warm = vec3(0.44, 0.20, 0.13);
        vec3 col = mix(deep, warm, 0.55 + 0.25 * (slubX - slubY) + 0.4 * (folds2 - 0.5));
        col *= 0.90 + 0.14 * weave;
        col *= 0.88 + 0.24 * folds;

        // Warm lamp pool, slightly above centre; dark falloff to the edges.
        vec2 lp = (p - vec2(0.0, uView.y * 0.1)) / uView.y;
        float lamp = exp(-dot(lp, lp) * 2.4);
        col *= mix(0.38, 1.12, lamp);
        col += vec3(0.05, 0.022, 0.0) * lamp;

        col *= 1.0 - uDim * 0.55;

        // Dither to hide banding in the dark gradient.
        col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * (2.0 / 255.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.renderOrder = -10;
  return { mesh, material };
}
