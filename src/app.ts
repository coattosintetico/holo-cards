import * as THREE from 'three';
import { Sfx } from './audio/sfx';
import { Card } from './card';
import { CARD_H, CARD_W } from './config';
import { DeviceTilt } from './interaction/tilt';
import { stepSprings } from './physics/spring';
import { blobToCanvas, coverToArt, type Canvas } from './pipeline/crop';
import { createTable } from './render/table';
import { db, type CardRecord, type Zone } from './store/db';

const FOV = 35;
/** Minimum visible height of the table in world units (desktop look). */
const MIN_VIEW_H = 10;
/** On narrow screens, keep at least this many card widths across. */
const MIN_CARDS_ACROSS = 4;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const TAP_MS = 280;
const TAP_PX = 10;
const DOUBLE_TAP_MS = 380;
/** Only the top few deck cards are drawn (the rest are hidden under them). */
const DECK_VISIBLE = 6;
/** Height the deck floats at (world units). */
const DECK_Z = 0.7;

export const isCoarse = () => matchMedia('(pointer: coarse)').matches;

export interface AppEvents {
  onInspect?: (card: Card | null) => void;
  onChange?: () => void;
}

export class App {
  readonly sfx = new Sfx();
  readonly tilt = new DeviceTilt();
  events: AppEvents = {};

  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private tableScene = new THREE.Scene();
  private table = createTable();
  private backdrop!: THREE.FramebufferTexture;
  private bufW = 1;
  private bufH = 1;
  private viewW = 16;
  private viewH = MIN_VIEW_H;

  private cards: Card[] = [];
  /** Hand, left to right. Table cards are the rest. */
  private hand: Card[] = [];
  /** Photos waiting to be processed, top first. The top one is being processed. */
  private deck: Card[] = [];
  private topOrder = 0;

  private pointer = { nx: 0, ny: 0, vx: 0, vy: 0, inside: false, touch: false, down: false };
  private hovered: Card | null = null;
  private hoverLocal = { u: 0, v: 0 };
  /** ox/oy: grab offset measured on the card's own (lifted) plane; dist: max pointer travel in px. */
  private drag: { card: Card; ox: number; oy: number; sx: number; sy: number; t: number; insert: number; moved: boolean; dist: number; z0: number } | null = null;
  private lastTap: { card: Card; t: number; x: number; y: number } | null = null;
  private inspecting: Card | null = null;
  private inspectStart = 0;
  /** Pointer position that inspect tilt is measured from (open position, or touch-down point). */
  private inspectBase = { nx: 0, ny: 0 };
  /** Press inside inspect mode, to tell a dismissing tap from a tilt drag. */
  private inspectPress: { x: number; y: number; t: number } | null = null;
  private time = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private last = performance.now();
  private saveTimer = 0;
  private raycaster = new THREE.Raycaster();
  private prevPtr: THREE.Vector3 | null = null;
  private corner = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x1a0d09, 1);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.tableScene.add(this.table.mesh);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.bindInput();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- setup

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const coarse = isCoarse();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.75 : 2));
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Fit the table so cards stay a sensible fraction of the narrow side.
    this.viewH = Math.max(MIN_VIEW_H, (CARD_W * MIN_CARDS_ACROSS) / aspect);
    this.viewW = this.viewH * aspect;
    this.camera.position.set(0, 0, this.viewH / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    this.camera.updateProjectionMatrix();
    this.table.mesh.scale.set(this.viewW * 1.3, this.viewH * 1.3, 1);
    this.table.material.uniforms.uView.value.set(this.viewW, this.viewH);

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bufW = size.x;
    this.bufH = size.y;
    this.backdrop?.dispose();
    this.backdrop = new THREE.FramebufferTexture(this.bufW, this.bufH);
    this.renderer.initTexture(this.backdrop);
    for (const c of this.cards) c.setBackdrop(this.backdrop, this.bufW, this.bufH);
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      if (!this.drag) this.setHovered(null);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.inspecting) this.endInspect();
      const target = this.inspecting ?? this.hovered;
      if ((e.key === 'Delete' || e.key === 'Backspace') && target && !this.drag) void this.removeCard(target);
    });
  }

  // ------------------------------------------------------------- geometry

  private get handY(): number {
    return -this.viewH / 2 + CARD_H * 0.64;
  }

  /** Above this line a dropped card stays on the table. */
  private get handZoneTop(): number {
    return -this.viewH / 2 + CARD_H * 1.12;
  }

  /**
   * Deck size and resting centre: top left, below the brand and hint lines.
   * The deck floats at DECK_Z, so the position is divided by the perspective
   * factor to keep its on-screen margins.
   */
  private get deckBase(): { x: number; y: number; s: number } {
    const narrow = this.viewW < CARD_W * 5;
    const s = narrow ? 0.62 : 0.78;
    const camZ = this.camera.position.z;
    const persp = camZ / (camZ - DECK_Z);
    const pxToWorld = this.viewH / window.innerHeight;
    const topPx = narrow ? 214 : 96; // below the hint (desktop) or the full-width toasts (phones)
    const halfW = CARD_W * s * 0.5 * persp;
    const halfH = CARD_H * s * 0.5 * persp;
    return {
      x: (-this.viewW / 2 + halfW + Math.max(26 * pxToWorld, 0.3)) / persp,
      y: (this.viewH / 2 - topPx * pxToWorld - halfH) / persp,
      s,
    };
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
      if (c.zone === 'deck') return 5e3 - this.deck.indexOf(c);
      if (c.zone === 'out') return 4e3;
      return c.order;
    };
    return this.cards.filter((c) => c.zone !== 'deck' || this.deck.indexOf(c) < DECK_VISIBLE).sort((a, b) => key(a) - key(b));
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

  private setPointer(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.pointer.touch = e.pointerType !== 'mouse';
  }

  private onMove(e: PointerEvent): void {
    if (!e.isPrimary) return;
    this.setPointer(e);
    // Touch has no hover: only track while a finger is down.
    this.pointer.inside = !this.pointer.touch || this.pointer.down;
    if (this.drag) {
      this.drag.dist = Math.max(this.drag.dist, Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy));
      if (this.drag.dist > TAP_PX) this.drag.moved = true;
    }
    if (this.drag || this.inspecting || !this.pointer.inside) return;
    const hit = this.pick();
    this.setHovered(hit?.card ?? null);
    if (hit) this.hoverLocal = { u: hit.u, v: hit.v };
  }

  private setHovered(c: Card | null): void {
    const busy = c?.zone === 'deck';
    if (c && c.zone !== 'hand' && c.zone !== 'table') c = null;
    if (!this.drag && !this.inspecting) this.canvas.style.cursor = busy ? 'not-allowed' : c ? 'grab' : 'default';
    if (c === this.hovered) return;
    this.hovered = c;
    if (c && !this.pointer.touch) this.sfx.hover();
  }

  private onDown(e: PointerEvent): void {
    this.sfx.unlock();
    if (!e.isPrimary || e.button !== 0) return;
    this.setPointer(e);
    this.pointer.down = true;
    this.pointer.inside = true;
    this.prevPtr = null;
    if (this.inspecting) {
      // Tilt is relative to where this touch started; dismissal happens on a tap (pointerup).
      this.inspectBase = { nx: this.pointer.nx, ny: this.pointer.ny };
      this.inspectPress = { x: e.clientX, y: e.clientY, t: performance.now() };
      return;
    }
    const hit = this.pick();
    if (!hit) return;
    const card = hit.card;
    if (card.zone === 'deck') return this.refuseDeck();
    if (card.zone === 'out') return;
    this.setHovered(card);
    // Measure the grab offset on the card's current plane so perspective
    // doesn't shift the card when it starts following the pointer.
    const p = this.pointerAt(card.z.value);
    this.drag = {
      card,
      ox: card.x.value - p.x,
      oy: card.y.value - p.y,
      sx: e.clientX,
      sy: e.clientY,
      t: performance.now(),
      insert: -1,
      moved: false,
      dist: 0,
      z0: card.z.value,
    };
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
    navigator.vibrate?.(6);
  }

  private onUp(e: PointerEvent): void {
    if (!e.isPrimary) return;
    this.sfx.unlock(); // iOS prefers unlocking on touchend
    this.pointer.down = false;
    if (this.pointer.touch) this.pointer.inside = false;

    if (this.inspecting) {
      const pr = this.inspectPress;
      this.inspectPress = null;
      const wasTap = !!pr && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < TAP_PX && performance.now() - pr.t < 400;
      if (e.target === this.canvas && wasTap && performance.now() - this.inspectStart > 300) this.endInspect();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const card = d.card;
    card.x.stiffness = card.y.stiffness = 210;
    card.x.damping = card.y.damping = 21;

    const isTap = !d.moved && performance.now() - d.t < TAP_MS;
    const p = this.pointerAt(0);
    const speed = Math.hypot(this.pointer.vx, this.pointer.vy);
    if (card.zone === 'hand' && (isTap || p.y < this.handZoneTop)) {
      this.hand.splice(clamp(d.insert < 0 ? this.insertIndex(p.x) : d.insert, 0, this.hand.length), 0, card);
    } else if (p.y < this.handZoneTop && !isTap) {
      card.zone = 'hand';
      this.hand.splice(clamp(d.insert < 0 ? this.insertIndex(p.x) : d.insert, 0, this.hand.length), 0, card);
    } else if (!isTap) {
      card.zone = 'table';
      card.rest = { x: card.x.target, y: card.y.target, rot: clamp(card.rot.value * 0.4, -0.25, 0.25) + (Math.random() - 0.5) * 0.08 };
      card.order = ++this.topOrder;
    } else {
      card.order = ++this.topOrder;
    }
    card.z.impulse(-3 - speed * 0.1);
    card.scale.impulse(-0.9);
    this.sfx.drop(isTap ? 0.3 : 0.45 + Math.min(0.55, speed / 30));
    this.sfx.setSlide(0);
    navigator.vibrate?.(isTap ? 4 : 10);
    this.canvas.style.cursor = this.pointer.touch ? 'default' : 'grab';
    if (this.pointer.touch) this.setHovered(null);

    // Double-tap / double-click to inspect.
    if (isTap) {
      const now = performance.now();
      const lt = this.lastTap;
      if (lt && lt.card === card && now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        this.lastTap = null;
        this.startInspect(card);
      } else {
        this.lastTap = { card, t: now, x: e.clientX, y: e.clientY };
      }
    } else {
      this.lastTap = null;
    }
    this.scheduleSave();
  }

  startInspect(card: Card): void {
    this.inspecting = card;
    this.inspectStart = performance.now();
    // Start flat: tilt is measured from where the pointer is now, not from screen centre.
    this.inspectBase = { nx: this.pointer.nx, ny: this.pointer.ny };
    this.inspectPress = null;
    this.setHovered(null);
    this.canvas.style.cursor = 'zoom-out';
    this.sfx.whoosh(true);
    this.events.onInspect?.(card);
  }

  endInspect(): void {
    if (!this.inspecting) return;
    this.inspecting = null;
    this.sfx.whoosh(false);
    this.sfx.drop(0.3);
    this.canvas.style.cursor = 'default';
    this.events.onInspect?.(null);
  }

  get inspected(): Card | null {
    return this.inspecting;
  }

  private insertIndex(x: number): number {
    let i = 0;
    while (i < this.hand.length && this.hand[i].x.target < x) i++;
    return i;
  }

  // ---------------------------------------------------------------- cards

  private async makeTexture(art: Blob): Promise<THREE.Texture> {
    return this.canvasTexture(await blobToCanvas(art));
  }

  private canvasTexture(canvas: Canvas): THREE.Texture {
    const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  private blankTexture(): THREE.Texture {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    t.needsUpdate = true;
    return t;
  }

  private place(card: Card, opts: { deal?: number }): void {
    if (card.zone === 'deck') {
      // Tossed onto the deck from off-screen, top left.
      const b = this.deckBase;
      card.x.snap(-this.viewW / 2 - CARD_W);
      card.y.snap(b.y + CARD_H * 0.6);
      card.rot.snap(0.7);
      card.z.snap(1.2);
      card.scale.snap(b.s);
      card.delay = opts.deal ?? 0;
      this.sfx.deal(card.delay);
      this.cards.push(card);
      this.deck.push(card);
      return;
    }
    if (opts.deal !== undefined) {
      // Fly in from off-screen right, spinning, then settle into the hand.
      card.x.snap(this.viewW / 2 + CARD_W * 1.5);
      card.y.snap(this.handY - 1.5);
      card.rot.snap(-0.9);
      card.z.snap(1.5);
      card.delay = opts.deal;
      this.sfx.deal(opts.deal);
    } else if (card.zone === 'table') {
      card.x.snap(card.rest.x);
      card.y.snap(card.rest.y);
      card.rot.snap(card.rest.rot);
    } else {
      card.x.snap(0);
      card.y.snap(this.handY);
    }
    this.cards.push(card);
    if (card.zone === 'hand') this.hand.push(card);
  }

  async addCard(rec: CardRecord, opts: { deal?: number } = {}): Promise<Card> {
    const card = new Card(rec.id, await this.makeTexture(rec.art), rec.art, this.backdrop);
    card.setBackdrop(this.backdrop, this.bufW, this.bufH);
    card.zone = rec.zone;
    card.order = rec.order;
    card.demo = !!rec.demo;
    card.rest = { x: rec.x, y: rec.y, rot: rec.rot };
    this.topOrder = Math.max(this.topOrder, rec.order);
    this.place(card, opts);
    return card;
  }

  /**
   * A queued photo: goes to the bottom of the deck (FIFO) with a blank print
   * until `setPreview` swaps in a low-res, distorted preview of the photo.
   */
  addPending(id: string, opts: { deal?: number } = {}): Card {
    const card = new Card(id, this.blankTexture(), null, this.backdrop);
    card.setBackdrop(this.backdrop, this.bufW, this.bufH);
    card.isPending = true;
    card.pending.snap(1);
    card.zone = 'deck';
    this.place(card, opts);
    return card;
  }

  /** Print a quick cover-fitted preview of the photo on a queued card. */
  async setPreview(card: Card, file: Blob): Promise<void> {
    let canvas: Canvas;
    try {
      canvas = await coverToArt(file);
    } catch {
      return; // undecodable here (e.g. HEIC): keep the blank print
    }
    if (!this.cards.includes(card) || !card.isPending) return;
    card.setTexture(this.canvasTexture(canvas));
  }

  /** Processing finished: swap in the art and draw the card from the deck into the hand. */
  async resolvePending(card: Card, art: Blob): Promise<void> {
    if (!this.cards.includes(card)) return; // removed meanwhile
    const tex = await this.makeTexture(art);
    if (!this.cards.includes(card)) return tex.dispose();
    card.setArt(tex, art);
    this.deck = this.deck.filter((c) => c !== card);
    card.zone = 'hand';
    this.hand.push(card);
    // Arc up off the deck and spin into the hand (the springs do the travel).
    card.z.impulse(7);
    card.rot.impulse(-2.4);
    card.scale.impulse(1.2);
    this.sfx.deal();
    this.scheduleSave();
  }

  /** Processing failed: the card is tossed off the table, then removed. */
  discardPending(card: Card): void {
    if (!this.cards.includes(card)) return;
    this.deck = this.deck.filter((c) => c !== card);
    card.zone = 'out';
    card.isPending = false;
    card.loading.target = 0;
    card.x.target = -this.viewW / 2 - CARD_W * 1.5;
    card.y.target = card.y.value + 1.2;
    card.rot.target = 1.2;
    card.z.target = 0.8;
    this.sfx.remove();
    window.setTimeout(() => {
      if (this.cards.includes(card)) void this.removeCard(card, { silent: true });
    }, 900);
  }

  /** The deck is busy: shake it off and knock. */
  private refuseDeck(): void {
    this.deck.forEach((c, i) => {
      const k = 1 / (1 + i * 0.6);
      c.x.impulse(3.2 * k * (i % 2 ? -1 : 1));
      c.rot.impulse(-2.2 * k);
      c.scale.impulse(-0.9 * k);
      c.z.impulse(-1.5 * k);
    });
    this.sfx.blocked();
    navigator.vibrate?.([8, 50, 8]);
  }

  has(card: Card): boolean {
    return this.cards.includes(card);
  }

  private detach(card: Card): void {
    this.cards = this.cards.filter((c) => c !== card);
    this.hand = this.hand.filter((c) => c !== card);
    this.deck = this.deck.filter((c) => c !== card);
    if (this.hovered === card) this.setHovered(null);
    if (this.inspecting === card) {
      this.inspecting = null;
      this.events.onInspect?.(null);
    }
    if (this.drag?.card === card) this.drag = null;
    card.dispose();
  }

  async removeCard(card: Card, opts: { silent?: boolean } = {}): Promise<void> {
    this.detach(card);
    if (!opts.silent) this.sfx.remove();
    await db.remove(card.id);
    this.scheduleSave();
  }

  /** Remove the sample cards; returns their records so the caller can undo. */
  async removeDemo(): Promise<CardRecord[]> {
    const demos = this.cards.filter((c) => c.demo);
    const recs = this.records().filter((r) => r.demo);
    for (const c of demos) {
      this.detach(c);
      await db.remove(c.id);
    }
    if (demos.length) this.sfx.remove();
    this.events.onChange?.();
    return recs;
  }

  async clearAll(): Promise<void> {
    for (const c of [...this.cards]) this.detach(c);
    this.sfx.remove();
    await db.clear();
    this.events.onChange?.();
  }

  get count(): number {
    return this.cards.length;
  }

  get onlyDemo(): boolean {
    return this.cards.length > 0 && this.cards.every((c) => c.demo);
  }

  records(): CardRecord[] {
    return this.cards
      .filter((c): c is Card & { zone: Zone } => !c.isPending && !!c.art && (c.zone === 'hand' || c.zone === 'table'))
      .map((c) => ({
        id: c.id,
        art: c.art!,
        zone: c.zone,
        x: c.rest.x,
        y: c.rest.y,
        rot: c.rest.rot,
        order: c.zone === 'hand' ? this.hand.indexOf(c) : c.order,
        created: 0,
        demo: c.demo,
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
    const tilt = this.tilt.enabled ? this.tilt : null;

    // Pointer velocity (world units/s), smoothed.
    const prev = this.prevPtr ?? ptr;
    const k = 1 - Math.exp(-dt * 18);
    this.pointer.vx += ((ptr.x - prev.x) / Math.max(dt, 1e-4) - this.pointer.vx) * k;
    this.pointer.vy += ((ptr.y - prev.y) / Math.max(dt, 1e-4) - this.pointer.vy) * k;
    this.prevPtr = ptr;

    // Hand slots, leaving a gap where the dragged card would land.
    const slots: (Card | null)[] = [...this.hand];
    if (drag && drag.moved && ptr.y < this.handZoneTop) {
      const idx = this.insertIndex(ptr.x);
      if (idx !== drag.insert) {
        drag.insert = idx;
        this.sfx.tick();
      }
      slots.splice(idx, 0, null);
    } else if (drag && drag.moved && drag.insert !== -1) {
      drag.insert = -1;
    } else if (drag && !drag.moved && drag.insert !== -1) {
      slots.splice(drag.insert, 0, null);
    }

    const n = slots.length;
    // Keep the outer card edges on screen, not just the card centres.
    const maxSpan = Math.max(0, Math.min(this.viewW * 0.6, this.viewW - CARD_W * 1.2));
    const span = Math.min(maxSpan, (n - 1) * CARD_W * 0.95);
    const spacing = n > 1 ? span / (n - 1) : 0;
    const hoverIdx = this.hovered && this.hovered.zone === 'hand' && !drag ? slots.indexOf(this.hovered) : -1;
    const push = Math.min(0.32, spacing * 0.5);

    slots.forEach((c, i) => {
      if (!c) return;
      const t = i - (n - 1) / 2;
      const x0 = t * spacing;
      let x = x0;
      if (hoverIdx >= 0 && i !== hoverIdx) x += (Math.sign(i - hoverIdx) * push) / Math.abs(i - hoverIdx);
      c.x.target = x;
      c.y.target = this.handY - x0 * x0 * 0.012;
      c.rot.target = -x0 * 0.028;
      c.z.target = 0;
      c.scale.target = 1;
      c.tiltX.target = tilt ? -tilt.y * 0.15 : 0;
      c.tiltY.target = tilt ? tilt.x * 0.15 : 0;
      c.hover.target = 0;
    });

    const xLim = this.viewW / 2 - CARD_W * 0.35;
    const yLim = this.viewH / 2 - CARD_H * 0.35;
    for (const c of this.cards) {
      c.dim.target = this.inspecting && this.inspecting !== c ? 1 : 0;
      c.shadowMul = 1;
      if (c.zone === 'table' && c !== drag?.card) {
        // Saved positions from a bigger screen stay reachable.
        c.x.target = clamp(c.rest.x, -xLim, xLim);
        c.y.target = clamp(c.rest.y, -yLim, yLim);
        c.rot.target = c.rest.rot;
        c.z.target = 0;
        c.scale.target = 1;
        c.tiltX.target = tilt ? -tilt.y * 0.15 : 0;
        c.tiltY.target = tilt ? tilt.x * 0.15 : 0;
        c.hover.target = 0;
      }
    }

    // Deck: floats in place, drifting and slowly rocking. Lower cards follow
    // the top one with a small lag, so the pile shears a little.
    if (this.deck.length) {
      const b = this.deckBase;
      const calm = this.reducedMotion.matches ? 0.35 : 1;
      this.deck.forEach((c, i) => {
        const t = this.time - i * 0.18;
        const k = Math.min(i, DECK_VISIBLE);
        c.x.target = b.x + (Math.sin(t * 0.53) * 0.07 + Math.sin(t * 0.31 + 1.3) * 0.04) * calm + k * 0.035 * b.s;
        c.y.target = b.y + (Math.cos(t * 0.41) * 0.06 + Math.sin(t * 0.27 + 0.4) * 0.03) * calm - k * 0.05 * b.s;
        c.z.target = DECK_Z + Math.sin(t * 0.7) * 0.06 * calm - k * 0.03;
        c.rot.target = (i ? c.deckRot : 0) + Math.sin(t * 0.23) * 0.035 * calm;
        c.tiltX.target = Math.sin(t * 0.37 + 0.8) * 0.13 * calm;
        c.tiltY.target = Math.cos(t * 0.29) * 0.15 * calm;
        c.scale.target = b.s;
        c.hover.target = 0;
        c.loading.target = i === 0 ? 1 : 0;
        c.shadowMul = i === 0 ? 0.65 : 0.3;
        if (i > 0) c.dim.target = Math.max(c.dim.target, 0.35);
      });
    }

    // Hovered: lift and lean towards the pointer. A held card is handled by
    // the drag branch below (its targets aren't reset by the hand loop, so
    // the relative `+=` here would accumulate every frame).
    const h = this.hovered;
    if (h && !this.inspecting && h !== drag?.card) {
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

    // Held / dragged: follow the pointer from the first frame (no catch-up
    // jump at the tap threshold), lean into the motion.
    if (drag) {
      const c = drag.card;
      const vx = this.pointer.vx;
      const vy = this.pointer.vy;
      // Follow on the card's own plane so the grab point stays under the pointer.
      const pz = this.pointerAt(c.z.value);
      // On touch, float the card above the finger, easing in with travel distance.
      const ease = clamp((drag.dist - TAP_PX) / 120, 0, 1);
      const lift = this.pointer.touch ? CARD_H * 0.28 * ease * ease * (3 - 2 * ease) : 0;
      // Scale the offset with depth so its on-screen size stays constant while lifting.
      const camZ = this.camera.position.z;
      const k = (camZ - c.z.value) / (camZ - drag.z0);
      c.x.target = pz.x + drag.ox * k;
      c.y.target = pz.y + drag.oy * k + lift;
      c.z.target = 1.4;
      c.scale.target = 1.08;
      c.rot.target = clamp(-vx * 0.022, -0.5, 0.5);
      c.tiltY.target = clamp(vx * 0.03, -0.55, 0.55);
      c.tiltX.target = clamp(-vy * 0.03, -0.55, 0.55);
      c.hover.target = 1;
      this.sfx.setSlide(Math.hypot(vx, vy));
    }

    // Inspect: big, centred, tilts with the pointer or the phone.
    const ins = this.inspecting;
    if (ins) {
      const z = 3.2;
      const camZ = this.camera.position.z;
      const persp = camZ / (camZ - z);
      const fit = Math.min((this.viewH * 0.72) / (CARD_H * persp), (this.viewW * 0.86) / (CARD_W * persp));
      ins.x.target = 0;
      ins.y.target = this.viewH * 0.03;
      ins.z.target = z;
      ins.rot.target = 0;
      ins.scale.target = Math.min(1.55, fit);
      // Relative to the gesture's start, so the card opens flat. On touch it only
      // tilts while a finger is down and settles back to flat on release.
      let tx = 0;
      let ty = 0;
      if (tilt) {
        tx = tilt.x;
        ty = tilt.y;
      } else if (!this.pointer.touch || this.pointer.down) {
        tx = clamp((this.pointer.nx - this.inspectBase.nx) * 1.6, -1, 1);
        ty = clamp((this.pointer.ny - this.inspectBase.ny) * 1.6, -1, 1);
      }
      ins.tiltX.target = -ty * 0.5;
      ins.tiltY.target = tx * 0.5;
      ins.hover.target = 1;
    }
  }

  /**
   * Copy only the part of the framebuffer this card can sample (its screen
   * rect plus the max refraction offset). Much cheaper than a full-screen
   * copy per card, which matters on phones.
   */
  private copyBackdrop(card: Card): void {
    const m = card.mesh;
    m.updateMatrixWorld();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.corner.set((sx * CARD_W) / 2, (sy * CARD_H) / 2, 0).applyMatrix4(m.matrixWorld).project(this.camera);
      const px = (this.corner.x * 0.5 + 0.5) * this.bufW;
      const py = (this.corner.y * 0.5 + 0.5) * this.bufH;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const pad = Math.max(this.bufW, this.bufH) * 0.03 + 4;
    const ix0 = clamp(Math.floor(x0 - pad), 0, this.bufW);
    const iy0 = clamp(Math.floor(y0 - pad), 0, this.bufH);
    const ix1 = clamp(Math.ceil(x1 + pad), 0, this.bufW);
    const iy1 = clamp(Math.ceil(y1 + pad), 0, this.bufH);
    if (ix1 <= ix0 || iy1 <= iy0) return;

    const gl = this.renderer.getContext();
    const tex = (this.renderer.properties.get(this.backdrop) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!tex) {
      this.renderer.copyFramebufferToTexture(this.backdrop);
      return;
    }
    this.renderer.state.bindTexture(gl.TEXTURE_2D, tex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, ix0, iy0, ix0, iy0, ix1 - ix0, iy1 - iy0);
    this.renderer.state.unbindTexture();
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.time += dt;

    if (this.pointer.inside && !this.drag && !this.inspecting && !this.pointer.touch) {
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
      this.copyBackdrop(c);
      r.render(c.scene, this.camera);
    }
  };
}
