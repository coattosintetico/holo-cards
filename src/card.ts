import * as THREE from 'three';
import { CARD_H, CARD_W } from './config';
import { Spring } from './physics/spring';
import { createCardMaterial, createShadowMaterial } from './render/cardMaterials';
import type { Zone } from './store/db';

const SHADOW_PAD = 1.5;
const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
const shadowGeo = new THREE.PlaneGeometry(CARD_W * SHADOW_PAD, CARD_H * SHADOW_PAD);

export class Card {
  // Motion state, all springs.
  readonly x = new Spring(0, 210, 21);
  readonly y = new Spring(0, 210, 21);
  readonly z = new Spring(0, 160, 16);
  readonly rot = new Spring(0, 180, 15);
  readonly tiltX = new Spring(0, 220, 14);
  readonly tiltY = new Spring(0, 220, 14);
  readonly scale = new Spring(1, 260, 15);
  readonly hover = new Spring(0, 200, 25);
  readonly dim = new Spring(0, 120, 22);
  readonly springs: Spring[];

  zone: Zone = 'hand';
  /** Resting position when on the table. */
  rest = { x: 0, y: 0, rot: 0 };
  order = 0;
  /** Seconds until this card starts moving (used for staggered dealing). */
  delay = 0;
  readonly phase = Math.random() * Math.PI * 2;

  readonly scene = new THREE.Scene();
  readonly shadowScene = new THREE.Scene();
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly shadowMaterial: THREE.ShaderMaterial;

  constructor(
    readonly id: string,
    readonly texture: THREE.Texture,
    readonly art: Blob,
    backdrop: THREE.Texture,
  ) {
    this.material = createCardMaterial(texture, backdrop);
    this.shadowMaterial = createShadowMaterial(texture);
    this.shadowMaterial.uniforms.uPad.value = SHADOW_PAD;
    this.mesh = new THREE.Mesh(cardGeo, this.material);
    this.mesh.rotation.order = 'XYZ';
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.shadow = new THREE.Mesh(shadowGeo, this.shadowMaterial);
    this.shadow.frustumCulled = false;
    this.shadowScene.add(this.shadow);
    this.springs = [this.x, this.y, this.z, this.rot, this.tiltX, this.tiltY, this.scale, this.hover, this.dim];
  }

  setBackdrop(t: THREE.Texture, w: number, h: number): void {
    this.material.uniforms.uBackdrop.value = t;
    this.material.uniforms.uResolution.value.set(w, h);
  }

  /** Push spring state into the meshes. `idle` adds a gentle breathing sway. */
  sync(time: number, idle: number): void {
    const sway = Math.sin(time * 0.9 + this.phase) * 0.012 * idle;
    const swayX = Math.sin(time * 0.7 + this.phase * 1.3) * 0.035 * idle;
    const swayY = Math.cos(time * 0.6 + this.phase) * 0.035 * idle;
    const z = this.z.value;
    const s = this.scale.value;

    this.mesh.position.set(this.x.value, this.y.value, z);
    this.mesh.rotation.set(this.tiltX.value + swayX, this.tiltY.value + swayY, this.rot.value + sway);
    this.mesh.scale.setScalar(s);

    // Light comes from the upper left: shadow drifts down-right and softens with height.
    const h = Math.max(0, z);
    this.shadow.position.set(this.x.value + 0.06 + h * 0.22, this.y.value - 0.08 - h * 0.3, 0);
    this.shadow.rotation.z = this.rot.value + sway;
    this.shadow.scale.setScalar(s * (1 + h * 0.04));
    this.shadowMaterial.uniforms.uBlur.value = Math.min(1, h / 2.5);
    this.shadowMaterial.uniforms.uOpacity.value = (1 - Math.min(0.55, h * 0.18)) * (1 - this.dim.value * 0.6);

    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uHover.value = this.hover.value;
    this.material.uniforms.uDim.value = this.dim.value;
  }

  /**
   * Hit-test a world-space point (already projected onto this card's
   * plane). Returns local coords in [-1, 1] or null. Tilt is ignored; at
   * these angles the error is negligible.
   */
  hit(px: number, py: number): { u: number; v: number } | null {
    const dx = px - this.x.value;
    const dy = py - this.y.value;
    const c = Math.cos(-this.rot.value);
    const sn = Math.sin(-this.rot.value);
    const lx = dx * c - dy * sn;
    const ly = dx * sn + dy * c;
    const hw = (CARD_W / 2) * this.scale.value;
    const hh = (CARD_H / 2) * this.scale.value;
    if (Math.abs(lx) > hw || Math.abs(ly) > hh) return null;
    return { u: lx / hw, v: ly / hh };
  }

  dispose(): void {
    this.material.dispose();
    this.shadowMaterial.dispose();
    this.texture.dispose();
  }
}
