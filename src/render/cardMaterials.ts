import * as THREE from 'three';
import { ART_RECT, CARD_H, CARD_RADIUS, CARD_W } from '../config';
import { SD_ROUND_BOX } from './glsl';

const artRect = new THREE.Vector4(...ART_RECT);
const size = new THREE.Vector2(CARD_W, CARD_H);
const radius = CARD_RADIUS * CARD_W;

/** Standard "over" blending that keeps destination alpha at 1 (needed so the
 * framebuffer stays opaque and can be copied as the refraction backdrop). */
const BLEND = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/**
 * Clear-plastic card. The opaque art is printed in the middle; everywhere
 * else the card refracts the backdrop (a copy of what's already drawn),
 * with a bevelled edge, specular glints and a sweeping glare band.
 */
export function createCardMaterial(art: THREE.Texture, backdrop: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uArt: { value: art },
      uBackdrop: { value: backdrop },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSize: { value: size },
      uRadius: { value: radius },
      uArtRect: { value: artRect },
      uTime: { value: 0 },
      uHover: { value: 0 },
      uDim: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vT;
      varying vec3 vB;
      varying vec3 vN;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        mat3 m = mat3(modelMatrix);
        vT = normalize(m * vec3(1, 0, 0));
        vB = normalize(m * vec3(0, 1, 0));
        vN = normalize(m * vec3(0, 0, 1));
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uArt;
      uniform sampler2D uBackdrop;
      uniform vec2 uResolution;
      uniform vec2 uSize;
      uniform float uRadius;
      uniform vec4 uArtRect;
      uniform float uTime;
      uniform float uHover;
      uniform float uDim;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vT;
      varying vec3 vB;
      varying vec3 vN;
      ${SD_ROUND_BOX}

      void main() {
        vec2 hs = uSize * 0.5;
        vec2 p = (vUv - 0.5) * uSize;
        float d = sdRoundBox(p, hs, uRadius);
        float aa = max(fwidth(d), 1e-4) * 0.8;
        float alpha = 1.0 - smoothstep(-aa, aa, d);
        if (alpha <= 0.001) discard;

        // Bevelled edge: tilt the normal outward near the rim.
        vec2 e = vec2(0.002, 0.0);
        vec2 g = vec2(sdRoundBox(p + e.xy, hs, uRadius) - sdRoundBox(p - e.xy, hs, uRadius),
                      sdRoundBox(p + e.yx, hs, uRadius) - sdRoundBox(p - e.yx, hs, uRadius));
        g = g / max(length(g), 1e-5);
        float bevelW = 0.05;
        float bev = smoothstep(-bevelW, 0.0, d);
        vec3 nl = normalize(vec3(g * bev * bev * 1.8, 1.0));
        vec3 N = normalize(vT * nl.x + vB * nl.y + vN * nl.z);
        vec3 V = normalize(cameraPosition - vWorld);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 4.0);

        // Refraction of what's underneath (with a touch of dispersion at the rim).
        vec3 R = refract(-V, N, 1.0 / 1.49);
        vec2 off = (R.xy + V.xy) * 0.05;
        off.x *= uResolution.y / uResolution.x;
        vec2 suv = gl_FragCoord.xy / uResolution;
        vec3 bg = vec3(
          texture2D(uBackdrop, suv + off * 1.00).r,
          texture2D(uBackdrop, suv + off * 1.07).g,
          texture2D(uBackdrop, suv + off * 1.14).b);

        // Plastic body: very slightly milky and cool; greenish glassy rim.
        vec3 plastic = bg * vec3(0.94, 0.97, 1.0) + 0.03;
        plastic = mix(plastic, plastic * vec3(0.82, 0.96, 0.95) + 0.03, bev);

        // Lighting.
        vec3 L = normalize(vec3(-0.45, 0.65, 1.0));
        vec3 H = normalize(L + V);
        float nh = max(dot(N, H), 0.0);
        float spec = pow(nh, 140.0) * 1.1 + pow(nh, 14.0) * 0.05;

        // Glare band that sweeps across as the card tilts.
        float s = dot(vUv - 0.5, normalize(vec2(1.0, -1.35)));
        float shift = dot(vN.xy, vec2(1.8, -1.5)) + sin(uTime * 0.25) * 0.03;
        float band = exp(-pow((s - shift + 0.08) / 0.10, 2.0)) * 0.10
                   + exp(-pow((s - shift - 0.13) / 0.025, 2.0)) * 0.07;

        // Thin rim highlight + faint inner bevel line (reads as thickness).
        float rim = smoothstep(-0.014, -0.005, d) * (1.0 - smoothstep(-0.005, 0.0, d));
        float inner = exp(-pow((d + bevelW) / 0.004, 2.0)) * 0.05;

        // Subtle thin-film iridescence on the bevel.
        vec3 irid = 0.5 + 0.5 * cos(6.2831 * (ndv * 1.6 + vec3(0.0, 0.33, 0.67) + dot(p, vec2(0.35, 0.22))));

        // Printed art.
        vec2 auv = (vUv - uArtRect.xy) / (uArtRect.zw - uArtRect.xy);
        vec4 art = vec4(0.0);
        if (all(greaterThanEqual(auv, vec2(0.0))) && all(lessThanEqual(auv, vec2(1.0)))) {
          art = texture2D(uArt, auv);
        }

        // The backdrop is already dimmed during inspect; only dim the print.
        vec3 col = mix(plastic, art.rgb * (1.0 - uDim * 0.5), art.a);
        // Soft sky reflection across the face, brighter towards the light.
        col += 0.03 * smoothstep(0.9, -0.3, dot(vUv - 0.5, vec2(1.0, -1.0)));
        col += spec + band * (1.0 - 0.35 * art.a);
        col += rim * (0.28 + 1.5 * fres) + inner;
        col += irid * bev * 0.07;
        col += fres * 0.12 + uHover * 0.015;

        gl_FragColor = vec4(col, alpha);
      }`,
    ...BLEND,
  });
}

/** Soft contact shadow; plastic casts a faint shadow, the art a denser one. */
export function createShadowMaterial(art: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uArt: { value: art },
      uSize: { value: size },
      uRadius: { value: radius },
      uArtRect: { value: artRect },
      uPad: { value: 1.5 },
      uBlur: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uArt;
      uniform vec2 uSize;
      uniform float uRadius;
      uniform vec4 uArtRect;
      uniform float uPad;
      uniform float uBlur;
      uniform float uOpacity;
      varying vec2 vUv;
      ${SD_ROUND_BOX}
      void main() {
        vec2 p = (vUv - 0.5) * uSize * uPad;
        float d = sdRoundBox(p, uSize * 0.5, uRadius);
        float bw = 0.04 + uBlur * 0.35;
        float card = 1.0 - smoothstep(-bw, bw, d);
        vec2 cuv = p / uSize + 0.5;
        vec2 auv = (cuv - uArtRect.xy) / (uArtRect.zw - uArtRect.xy);
        float a = textureLod(uArt, clamp(auv, 0.0, 1.0), 2.0 + uBlur * 4.0).a;
        vec2 inside = step(vec2(0.0), auv) * step(auv, vec2(1.0));
        a *= inside.x * inside.y;
        // A resting clear card barely shades the cloth; lifted ones cast more.
        float sh = card * (0.07 + 0.15 * uBlur) + a * 0.5;
        gl_FragColor = vec4(0.05, 0.02, 0.01, sh * uOpacity);
      }`,
    ...BLEND,
  });
}
