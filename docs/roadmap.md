# Roadmap and open items

Keep this current: remove items when done, and add what you learn.

## Needs verification on real devices (owner)

- Background-removal quality and speed on desktop and phone (both models). In particular: does WebGPU kick in on the phone ("Removing background (GPU)…"), and how much faster are the GPU and multi-threaded CPU paths than the old ~1 min per photo?
- The COOP/COEP service worker on GitHub Pages: one reload on first visit, `crossOriginIsolated === true` afterwards, nothing else broken (iOS Safari especially).
- Locking the phone mid-batch: does processing resume on unlock, and does a discarded tab resume the queue on reload?
- Phone tilt axis directions and sensitivity on iOS and Android (`tilt.ts`: ±25° maps to ±1).
- Touch feel: the float-above-finger offset (`0.28·CARD_H`, eased in over 120 px of travel), tap and double-tap thresholds (280 ms / 10 px / 380 ms).
- Performance on mid-range phones with ~10+ cards (per-card sub-rect copies, DPR 1.75 cap).
- iOS audio unlock (silent switch mutes web audio; expected).

## Known gaps

- Background removal can't run where `staticimgly.com` is blocked (artifact build). Option: self-host the model (see `image-pipeline.md`).
- The main-thread fallback still blocks rendering during inference (only used if workers fail).
- HEIC decode outside Safari.
- No way to export or share a card or deck yet.

## Ideas (not committed to)

- Card styles: frame, foil or holo variants, rarity effects, name/caption text printed on the plastic.
- Back face and flip animation; stacking/pile physics on the table.
- Self-hosted model (also enables offline use and testing the ML path in the sandbox).
- Server-side processing (upload, session id, process in the background, fetch results later): the only way to keep working while the phone is locked. Deferred; it gives up the client-only design.
- A smaller/faster segmentation model (320–512 px input) if WebGPU and threads aren't enough.
- Shareable deck (export PNGs or a single image of the table).
- Accessibility: keyboard focus and moving cards with the keyboard.
