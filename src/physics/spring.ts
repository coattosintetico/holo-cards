/**
 * Critically-tunable damped spring, integrated with semi-implicit Euler in
 * fixed substeps so behaviour is frame-rate independent.
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;

  constructor(
    initial = 0,
    public stiffness = 170,
    public damping = 18,
  ) {
    this.value = initial;
    this.target = initial;
  }

  step(dt: number): void {
    const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += f * dt;
    this.value += this.velocity * dt;
  }

  snap(v: number): void {
    this.value = this.target = v;
    this.velocity = 0;
  }

  impulse(v: number): void {
    this.velocity += v;
  }
}

/** Advance a set of springs using fixed substeps. */
export function stepSprings(springs: Spring[], dt: number, sub = 1 / 240): void {
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-6) {
    const h = Math.min(sub, remaining);
    for (const s of springs) s.step(h);
    remaining -= h;
  }
}
