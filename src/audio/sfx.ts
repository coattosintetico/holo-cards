/**
 * Procedural sound design with the Web Audio API: no assets, no licences.
 * Every voice gets a little random pitch/gain so repeats never sound robotic.
 */
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Sfx {
  private ctx?: AudioContext;
  private out!: GainNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private slideGain?: GainNode;
  private slideFilter?: BiquadFilterNode;
  private hoverStep = 0;
  private lastHover = 0;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);

    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(comp);

    // Small, warm room: generated impulse response.
    const len = Math.floor(ctx.sampleRate * 0.9);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    const verbLp = ctx.createBiquadFilter();
    verbLp.type = 'lowpass';
    verbLp.frequency.value = 3500;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.16;
    this.wet.connect(verb).connect(verbLp).connect(comp);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    this.startSlideLoop();
  }

  private get ready(): boolean {
    return !!this.ctx && !this.muted;
  }

  private bus(gain: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = gain;
    g.connect(this.out);
    g.connect(this.wet);
    return g;
  }

  private tone(freq: number, dur: number, gain: number, opts: { type?: OscillatorType; to?: number; attack?: number; delay?: number } = {}): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
    o.connect(g).connect(this.bus(1));
    o.start(t);
    o.stop(t + a + dur + 0.05);
  }

  private burst(dur: number, gain: number, filter: { type: BiquadFilterType; f: number; q?: number; to?: number }, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.8, 1.2);
    const bq = ctx.createBiquadFilter();
    bq.type = filter.type;
    bq.frequency.setValueAtTime(filter.f, t);
    if (filter.to) bq.frequency.exponentialRampToValueAtTime(filter.to, t + dur);
    bq.Q.value = filter.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bq).connect(g).connect(this.bus(1));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  /** Light tick; pitch climbs when sweeping quickly across cards. */
  hover(): void {
    if (!this.ready) return;
    const now = performance.now();
    this.hoverStep = now - this.lastHover < 260 ? Math.min(this.hoverStep + 1, 9) : 0;
    this.lastHover = now;
    const m = Math.pow(2, (this.hoverStep * 2) / 12) * rand(0.97, 1.03);
    this.tone(1250 * m, 0.05, 0.05);
    this.burst(0.018, 0.035, { type: 'bandpass', f: 5200 * m, q: 2.5 });
  }

  /** Quieter tick used while reordering the hand. */
  tick(): void {
    if (!this.ready) return;
    this.tone(rand(820, 900), 0.03, 0.03, { type: 'triangle' });
    this.burst(0.02, 0.03, { type: 'bandpass', f: 3500, q: 3 });
  }

  /** Plastic card lifted off cloth. */
  pickup(): void {
    if (!this.ready) return;
    this.burst(0.08, 0.10, { type: 'bandpass', f: 700, to: 3200, q: 1.4 });
    this.tone(rand(380, 420), 0.06, 0.06, { to: 640 });
  }

  /** Plastic card landing on cloth; strength in [0, 1]. */
  drop(strength = 0.6): void {
    if (!this.ready) return;
    const s = Math.max(0.2, Math.min(1, strength));
    this.burst(0.05, 0.22 * s, { type: 'lowpass', f: 1600 * rand(0.9, 1.1), q: 0.8 });
    this.tone(rand(150, 175), 0.08, 0.28 * s, { to: 80 });
    this.tone(rand(2900, 3300), 0.02, 0.04 * s, { type: 'triangle', delay: 0.004 });
  }

  /** Card dealt from off-screen. */
  deal(delay = 0): void {
    if (!this.ready) return;
    this.burst(0.16, 0.06, { type: 'bandpass', f: 500, to: 2600, q: 0.9 }, delay);
    this.burst(0.04, 0.10, { type: 'lowpass', f: 1500 }, delay + 0.14);
    this.tone(rand(160, 180), 0.06, 0.12, { to: 90, delay: delay + 0.14 });
  }

  /** New card created: soft two-note chime. */
  chime(): void {
    if (!this.ready) return;
    const b = rand(660, 700);
    this.tone(b, 0.5, 0.035, { attack: 0.01 });
    this.tone(b * 1.5, 0.6, 0.03, { attack: 0.01, delay: 0.07 });
  }

  /** Card removed: downward swoosh. */
  remove(): void {
    if (!this.ready) return;
    this.burst(0.22, 0.08, { type: 'bandpass', f: 3000, to: 400, q: 1.2 });
    this.tone(500, 0.18, 0.05, { to: 180 });
  }

  /** Inspect zoom in/out. */
  whoosh(up: boolean): void {
    if (!this.ready) return;
    this.burst(0.2, 0.06, { type: 'bandpass', f: up ? 600 : 2400, to: up ? 2400 : 600, q: 1 });
  }

  private startSlideLoop(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.slideFilter = ctx.createBiquadFilter();
    this.slideFilter.type = 'bandpass';
    this.slideFilter.frequency.value = 900;
    this.slideFilter.Q.value = 0.6;
    this.slideGain = ctx.createGain();
    this.slideGain.gain.value = 0;
    src.connect(this.slideFilter).connect(this.slideGain).connect(this.out);
    src.start();
  }

  /** Continuous air/cloth whisper following drag speed (world units / s). */
  setSlide(speed: number): void {
    if (!this.ctx || !this.slideGain || !this.slideFilter) return;
    const v = this.muted ? 0 : Math.min(speed / 25, 1);
    const t = this.ctx.currentTime;
    this.slideGain.gain.setTargetAtTime(v * v * 0.07, t, 0.05);
    this.slideFilter.frequency.setTargetAtTime(600 + v * 1800, t, 0.05);
  }
}
