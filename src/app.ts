import * as THREE from 'three';
import { Sfx } from './audio/sfx';
import { Card } from './card';
import { CARD_H, CARD_W } from './config';
import { stepSprings } from './physics/spring';
import { blobToCanvas } from './pipeline/crop';
import { createTable } from './render/table';
import { db, type CardRecord } from './store/db';

const VIEW_H = 10;
const FOV = 35;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class App {
  readonly sfx = new Sfx();
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private tableScene = new THREE.Scene();
  private table = createTable();
  private backdrop!: THREE.FramebufferTexture;
  private bufW = 1;
  private bufH = 1;
  private viewW = 16;

  private cards: Card[] = [];
  /** Hand, left to right. Table cards are the rest. */
  private hand: Card[] = [];
  private topOrder = 0;

  private pointer = { x: 0, y: 0, nx: 0, ny: 0, vx: 0, vy: 0, inside: false };
  private hovered: Card | null = null;
  private hoverLocal = { u: 0, v: 0 };
  private drag: { card: Card; ox: number; oy: number; sx: number; sy: number; t: number; insert: number } | null = null;
  private inspecting: Card | null = null;
  private time = 0;
  private last = performance.now();
  private saveTimer = 0;
  private raycaster = new THREE.Raycaster();
  private prevPtr: THREE.Vector3 | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x1a0d09, 1);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, VIEW_H / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    this.tableScene.add(this.table.mesh);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- setup

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewW = VIEW_H * this.camera.aspect;
    this.table.mesh.scale.set(this.viewW * 1.3, VIEW_H * 1.3, 1);
    this.table.material.uniforms.uView.value.set(this.viewW, VIEW_H);

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bufW = size.x;
    this.bufH = size.y;
    this.backdrop?.dispose();
    this.backdrop = new THREE.FramebufferTexture(this.bufW, this.bufH);
    for (const c of this.cards) c.setBackdrop(this.backdrop, this.bufW, this.bufH);
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      if (!this.drag) this.setHovered(null);
    });
    c.addEventListener('dblclick', () => this.onDouble());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.inspecting) this.endInspect();
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.hovered && !this.drag) {
        void this.removeCard(this.hovered);
      }
    });
  }

  // ------------------------------------------------------------- geometry

  private get handY(): number {
    return -VIEW_H / 2 + CARD_H * 0.64;
  }

  /** Above this line a dropped card stays on the table. */
  private get handZoneTop(): number {
    return -VIEW_H / 2 + CARD_H * 1.12;
  }

  /** Project the pointer onto the plane z = planeZ (world units). */
  private pointerAt(planeZ: number): THREE.Vector3 {
    this.raycaster.setFromCamera(new THREE.Vector2(this.pointer.nx, this.pointer.ny), this.camera);
    const { origin, direction } = this.raycaster.ray;
    const t = (planeZ - origin.z) / direction.z;
    return origin.clone().addScaledVector(direction, t);
  }

  private drawOrder(): Card[] {
    const key = (c: Card) => {
      if (c === this.inspecting) return 1e6;
      if (this.drag?.card === c) return 1e5;
      if (c.zone === 'hand') return 1e4 + this.hand.indexOf(c) + (c === this.hovered ? 500 : 0);
      return c.order;
    };
    return [...this.cards].sort((a, b) => key(a) - key(b));
  }

  private pick(): { card: Card; u: number; v: number } | null {
    const order = this.drawOrder().reverse();
    for (const c of order) {
      if (this.drag?.card === c) continue;
      const p = this.pointerAt(c.z.value);
      const h = c.hit(p.x, p.y);
      if (h) return { card: c, ...h };
    }
    return null;
  }

  // ---------------------------------------------------------------- input

  private onMove(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.pointer.inside = true;
    if (this.drag || this.inspecting) return;
    const hit = this.pick();
    this.setHovered(hit?.card ?? null);
    if (hit) this.hoverLocal = { u: hit.u, v: hit.v };
  }

  private setHovered(c: Card | null): void {
    if (c === this.hovered) return;
    this.hovered = c;
    if (c) this.sfx.hover();
    this.canvas.style.cursor = c ? 'grab' : 'default';
  }

  private onDown(e: PointerEvent): void {
    this.sfx.unlock();
    if (e.button !== 0) return;
    if (this.inspecting) return; // handled on pointerup (click to dismiss)
    const hit = this.pick();
    if (!hit) return;
    const card = hit.card;
    const p = this.pointerAt(0);
    this.drag = { card, ox: card.x.value - p.x, oy: card.y.value - p.y, sx: e.clientX, sy: e.clientY, t: performance.now(), insert: -1 };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
    if (card.zone === 'hand') {
      this.drag.insert = this.hand.indexOf(card);
      this.hand.splice(this.drag.insert, 1);
    }
    card.x.stiffness = card.y.stiffness = 520;
    card.x.damping = card.y.damping = 34;
    card.scale.impulse(1.2);
    this.sfx.pickup();
  }

  private onUp(e: PointerEvent): void {
    if (this.inspecting) {
      if (e.button === 0 && performance.now() - this.inspectStart > 300) this.endInspect();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const card = d.card;
    card.x.stiffness = card.y.stiffness = 210;
    card.x.damping = card.y.damping = 21;

    const p = this.pointerAt(0);
    const speed = Math.hypot(this.pointer.vx, this.pointer.vy);
    if (p.y < this.handZoneTop) {
      card.zone = 'hand';
      this.hand.splice(clamp(d.insert < 0 ? this.insertIndex(p.x) : d.insert, 0, this.hand.length), 0, card);
    } else {
      card.zone = 'table';
      card.rest = { x: card.x.target, y: card.y.target, rot: clamp(card.rot.value * 0.4, -0.25, 0.25) + (Math.random() - 0.5) * 0.08 };
      card.order = ++this.topOrder;
    }
    card.z.impulse(-3 - speed * 0.1);
    card.scale.impulse(-0.9);
    this.sfx.drop(0.45 + Math.min(0.55, speed / 30));
    this.sfx.setSlide(0);
    this.canvas.style.cursor = 'grab';
    this.scheduleSave();
  }

  private inspectStart = 0;

  private onDouble(): void {
    if (this.inspecting) return;
    const hit = this.pick();
    if (!hit) return;
    this.inspecting = hit.card;
    this.inspectStart = performance.now();
    this.canvas.style.cursor = 'zoom-out';
    this.sfx.whoosh(true);
  }

  private endInspect(): void {
    this.inspecting = null;
    this.sfx.whoosh(false);
    this.sfx.drop(0.3);
    this.canvas.style.cursor = 'default';
  }

  private insertIndex(x: number): number {
    let i = 0;
    while (i < this.hand.length && this.hand[i].x.target < x) i++;
    return i;
  }

  // ---------------------------------------------------------------- cards

  async addCard(rec: CardRecord, opts: { deal?: number } = {}): Promise<Card> {
    const canvas = await blobToCanvas(rec.art);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const card = new Card(rec.id, tex, rec.art, this.backdrop);
    card.setBackdrop(this.backdrop, this.bufW, this.bufH);
    card.zone = rec.zone;
    card.order = rec.order;
    card.rest = { x: rec.x, y: rec.y, rot: rec.rot };
    this.topOrder = Math.max(this.topOrder, rec.order);

    if (opts.deal !== undefined) {
      // Fly in from off-screen right, spinning, then settle into the hand.
      card.x.snap(this.viewW / 2 + CARD_W * 1.5);
      card.y.snap(this.handY - 1.5);
      card.rot.snap(-0.9);
      card.z.snap(1.5);
      card.delay = opts.deal;
      this.sfx.deal(opts.deal);
    } else if (rec.zone === 'table') {
      card.x.snap(rec.x);
      card.y.snap(rec.y);
      card.rot.snap(rec.rot);
    } else {
      card.x.snap(0);
      card.y.snap(this.handY);
    }
    this.cards.push(card);
    if (card.zone === 'hand') this.hand.push(card);
    return card;
  }

  async removeCard(card: Card): Promise<void> {
    this.cards = this.cards.filter((c) => c !== card);
    this.hand = this.hand.filter((c) => c !== card);
    if (this.hovered === card) this.setHovered(null);
    if (this.inspecting === card) this.inspecting = null;
    card.dispose();
    this.sfx.remove();
    await db.remove(card.id);
    this.scheduleSave();
  }

  async clearAll(): Promise<void> {
    for (const c of [...this.cards]) {
      c.dispose();
    }
    this.cards = [];
    this.hand = [];
    this.hovered = this.inspecting = null;
    this.sfx.remove();
    await db.clear();
  }

  get count(): number {
    return this.cards.length;
  }

  records(): CardRecord[] {
    return this.cards.map((c) => ({
      id: c.id,
      art: c.art,
      zone: c.zone,
      x: c.rest.x,
      y: c.rest.y,
      rot: c.rest.rot,
      order: c.zone === 'hand' ? this.hand.indexOf(c) : c.order,
      created: 0,
    }));
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void db.putMany(this.records()), 400);
  }

  // ---------------------------------------------------------------- frame

  private layout(dt: number): void {
    const drag = this.drag;
    const ptr = this.pointerAt(0);

    // Pointer velocity (world units/s), smoothed.
    const prev = this.prevPtr ?? ptr;
    const k = 1 - Math.exp(-dt * 18);
    this.pointer.vx += ((ptr.x - prev.x) / Math.max(dt, 1e-4) - this.pointer.vx) * k;
    this.pointer.vy += ((ptr.y - prev.y) / Math.max(dt, 1e-4) - this.pointer.vy) * k;
    this.prevPtr = ptr;

    // Hand slots, leaving a gap where the dragged card would land.
    const slots: (Card | null)[] = [...this.hand];
    if (drag && ptr.y < this.handZoneTop) {
      const idx = this.insertIndex(ptr.x);
      if (idx !== drag.insert) {
        drag.insert = idx;
        this.sfx.tick();
      }
      slots.splice(idx, 0, null);
    } else if (drag && drag.insert !== -1) {
      drag.insert = -1;
    }

    const n = slots.length;
    const span = Math.min(this.viewW * 0.6, (n - 1) * CARD_W * 0.95);
    const spacing = n > 1 ? span / (n - 1) : 0;
    const hoverIdx = this.hovered && this.hovered.zone === 'hand' && !drag ? slots.indexOf(this.hovered) : -1;

    slots.forEach((c, i) => {
      if (!c) return;
      const t = i - (n - 1) / 2;
      const x0 = t * spacing;
      let x = x0;
      if (hoverIdx >= 0 && i !== hoverIdx) x += (Math.sign(i - hoverIdx) * 0.32) / Math.abs(i - hoverIdx);
      c.x.target = x;
      c.y.target = this.handY - x0 * x0 * 0.012;
      c.rot.target = -x0 * 0.028;
      c.z.target = 0;
      c.scale.target = 1;
      c.tiltX.target = 0;
      c.tiltY.target = 0;
      c.hover.target = 0;
    });

    for (const c of this.cards) {
      c.dim.target = this.inspecting && this.inspecting !== c ? 1 : 0;
      if (c.zone === 'table' && c !== drag?.card) {
        c.x.target = c.rest.x;
        c.y.target = c.rest.y;
        c.rot.target = c.rest.rot;
        c.z.target = 0;
        c.scale.target = 1;
        c.tiltX.target = c.tiltY.target = 0;
        c.hover.target = 0;
      }
    }

    // Hovered: lift and lean towards the cursor.
    const h = this.hovered;
    if (h && !drag && !this.inspecting) {
      if (h.zone === 'hand') {
        h.y.target += 0.42;
        h.rot.target = 0;
      }
      h.z.target = 0.45;
      h.scale.target = 1.07;
      h.tiltX.target = -this.hoverLocal.v * 0.32;
      h.tiltY.target = this.hoverLocal.u * 0.32;
      h.hover.target = 1;
      const hit = this.pointerAt(h.z.value);
      const l = h.hit(hit.x, hit.y);
      if (l) this.hoverLocal = { u: l.u, v: l.v };
    }

    // Dragged: follow the pointer, lean into the motion.
    if (drag) {
      const c = drag.card;
      const vx = this.pointer.vx;
      const vy = this.pointer.vy;
      c.x.target = ptr.x + drag.ox;
      c.y.target = ptr.y + drag.oy;
      c.z.target = 1.4;
      c.scale.target = 1.08;
      c.rot.target = clamp(-vx * 0.022, -0.5, 0.5);
      c.tiltY.target = clamp(vx * 0.03, -0.55, 0.55);
      c.tiltX.target = clamp(-vy * 0.03, -0.55, 0.55);
      c.hover.target = 1;
      this.sfx.setSlide(Math.hypot(vx, vy));
    }

    // Inspect: big, centred, tilts with the mouse.
    const ins = this.inspecting;
    if (ins) {
      ins.x.target = 0;
      ins.y.target = 0.3;
      ins.z.target = 3.2;
      ins.rot.target = 0;
      ins.scale.target = 1.55;
      ins.tiltX.target = -this.pointer.ny * 0.45;
      ins.tiltY.target = this.pointer.nx * 0.45;
      ins.hover.target = 1;
    }
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.time += dt;

    if (this.pointer.inside && !this.drag && !this.inspecting) {
      const hit = this.pick();
      this.setHovered(hit?.card ?? null);
    }
    this.layout(dt);
    for (const c of this.cards) {
      if (c.delay > 0) {
        c.delay -= dt;
        continue;
      }
      stepSprings(c.springs, dt);
    }

    const dimTarget = this.inspecting ? 1 : 0;
    const u = this.table.material.uniforms;
    u.uDim.value += (dimTarget - u.uDim.value) * (1 - Math.exp(-dt * 8));
    u.uTime.value = this.time;

    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear();
    for (const c of this.cards) {
      const idle = c === this.drag?.card || c === this.inspecting ? 0 : 1;
      c.sync(this.time, idle);
    }
    r.render(this.tableScene, this.camera);
    // Each card: its shadow lands on everything below it, then the card
    // refracts a fresh copy of the framebuffer (so stacked cards see each other).
    for (const c of this.drawOrder()) {
      r.render(c.shadowScene, this.camera);
      r.copyFramebufferToTexture(this.backdrop);
      r.render(c.scene, this.camera);
    }
  };
}
