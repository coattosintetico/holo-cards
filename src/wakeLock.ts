/**
 * Keeps the screen on while something long is running (the upload queue), so
 * the phone doesn't auto-lock mid-batch: mobile browsers suspend a page,
 * workers included, as soon as it's hidden. The browser drops the lock
 * whenever the page is hidden, so it's re-requested on return.
 * No-ops where the API is missing or blocked (e.g. sandboxed frames).
 */
type Sentinel = { release(): Promise<void>; released: boolean };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

export function keepAwake(): { hold(): void; release(): void } {
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  let wanted = false;
  let sentinel: Sentinel | null = null;

  const acquire = async () => {
    if (!api || !wanted || document.hidden || (sentinel && !sentinel.released)) return;
    try {
      sentinel = await api.request('screen');
      if (!wanted) void sentinel.release(); // released while the request was in flight
    } catch {
      /* not allowed (low battery, permissions policy): fine */
    }
  };

  document.addEventListener('visibilitychange', () => void acquire());

  return {
    hold() {
      wanted = true;
      void acquire();
    },
    release() {
      wanted = false;
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
}
