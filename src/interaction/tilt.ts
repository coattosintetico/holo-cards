const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

/**
 * Phone tilt from DeviceOrientation, as a value in [-1, 1] per axis relative
 * to how the phone is being held. The neutral pose slowly follows the
 * current one (a high-pass), so it re-centres when you change grip.
 */
export class DeviceTilt {
  enabled = false;
  /** Left/right (+x = right edge down). */
  x = 0;
  /** Forward/back (+y = top edge towards you). */
  y = 0;
  private base: { b: number; g: number } | null = null;

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
  }

  /** Must be called from a user gesture (iOS asks for permission). */
  async enable(): Promise<boolean> {
    if (this.enabled) return true;
    const D = DeviceOrientationEvent as OrientationCtor;
    try {
      if (typeof D.requestPermission === 'function' && (await D.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
    window.addEventListener('deviceorientation', this.onOrient);
    this.enabled = true;
    return true;
  }

  disable(): void {
    window.removeEventListener('deviceorientation', this.onOrient);
    this.enabled = false;
    this.base = null;
    this.x = this.y = 0;
  }

  private onOrient = (e: DeviceOrientationEvent): void => {
    if (e.beta == null || e.gamma == null) return;
    // Map device axes to screen axes for the current orientation.
    const angle = (screen.orientation?.angle ?? 0) % 360;
    let b = e.beta;
    let g = e.gamma;
    if (angle === 90) [b, g] = [-e.gamma, e.beta];
    else if (angle === 270 || angle === -90) [b, g] = [e.gamma, -e.beta];
    else if (angle === 180) [b, g] = [-e.beta, -e.gamma];

    if (!this.base) this.base = { b, g };
    this.base.b += (b - this.base.b) * 0.008;
    this.base.g += (g - this.base.g) * 0.008;
    this.x = clamp((g - this.base.g) / 25, -1, 1);
    this.y = clamp((b - this.base.b) / 25, -1, 1);
  };
}
