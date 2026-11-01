# Image pipeline

Photo → transparent, content-filling card art.

## Flow

1. **Upload sources** (`main.ts`): Add photos button / file input (`accept="image/*"`, multiple), drag-and-drop anywhere, paste.
2. `addFiles()`: if only sample cards are showing, they are removed first (with an Undo notice). For each file, a **pending card** is tossed onto the bottom of the **deck** (top left) right away (`app.addPending`), a job is queued, and the original file is saved to the IndexedDB `pending` store. `app.setPreview` decodes a small, cover-fitted preview of the photo (`coverToArt`, ~384 px, main thread via `createImageBitmap` with `resizeWidth`) and prints it on the card, distorted by the pending shader; if the browser can't decode it (e.g. HEIC outside Safari) the card stays blank. The deck order equals the queue order, so the top card is always the one being processed.
3. `run()` processes the queue **one photo at a time**, updating the status toast: "Processing i of N · about X s left" plus a stage line ("Downloading the background-removal model NN % (first time only)", "Removing background (GPU)…" or "Removing background…", "Fitting to the card…"). ETA is an exponential moving average of per-photo time; photos during which the page was hidden don't count towards it. On touch devices the hint adds "Locking the phone pauses it."
   - While the queue runs, a **Screen Wake Lock** is held (`src/wakeLock.ts`) so the phone doesn't auto-lock. The browser drops it whenever the page is hidden, so it's re-requested on `visibilitychange`. No-op where unsupported or blocked.
4. When done: `app.resolvePending(card, art)` swaps the art in and **draws the card from the deck into the hand** (right end), the chime plays and the record is saved. On failure the card is discarded off the left edge (`app.discardPending`) and the error is listed in the final notice.
5. The final notice summarises: "N cards added." plus any warnings.
6. After each job (success or failure) its `pending` record is deleted. Jobs whose card was removed meanwhile (Clear) are skipped; Clear also empties `pending`.

## Locked screen / background tabs

Browsers can't keep doing heavy compute in the background: iOS suspends a hidden page, workers included, almost immediately; Android Chrome throttles and then freezes it. No web API changes that (Background Fetch only downloads; service workers are killed after a short time). So the design is "pause and resume", not "keep running":
- Wake lock keeps the screen on while processing, so the phone doesn't lock by itself.
- If the user locks it anyway, the worker is frozen and normally continues when the page is visible again.
- If the browser discarded the tab (memory pressure), `boot()` re-queues everything left in `pending` (skipping ids already in `cards`, which means the tab died between saving the card and deleting its pending record).
- Really continuing in the background would need a server doing the processing (discussed with the owner; not done for the POC).

## Worker (`pipeline/client.ts`, `pipeline/worker.ts`)

- `Pipeline` spawns a module worker (`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`; `vite.config.ts` sets `worker.format = 'es'`).
- Messages: `{id, file, opts}` → `progress | done | error`.
- If the worker can't be created, or crashes (`onerror`), jobs fall back to `processImage` on the main thread. That fallback still blocks rendering during inference.
- Demo PNGs are also processed through the pipeline on first boot (they're already transparent, so they only get crop/fit).

## Processing (`pipeline/process.ts`, `pipeline/crop.ts`)

All image work uses **OffscreenCanvas** (works in the worker and on the main thread).

1. Decode with `createImageBitmap`, downscaled so the longest side is ≤ `maxSide` (2048 desktop, 1600 on touch devices).
2. If < 4 % of pixels are transparent (`ALREADY_CUT_OUT`), run **background removal**; otherwise skip it (already a cut-out).
3. `cropToContent`: alpha > 24 counts as content; per-row and per-column histograms with a noise floor (0.3 % of the other dimension) so stray speckles don't inflate the box; alpha < 8 is zeroed (removes grey halos on the plastic).
4. `fitToArt`: contain-fit into a canvas with the card's art-window aspect (`ART_ASPECT`), longest side `ART_MAX_PX = 1024`, 3 % padding.
5. Encode PNG → `Blob` (stored in IndexedDB, turned into a mipmapped texture in `App.makeTexture`).

## Background removal (`@imgly/background-removal` 1.7.0)

- Lazily imported; runs ONNX Runtime Web in the worker.
- **Input size doesn't change inference cost:** imgly resizes every input to the ISNet input of 1024×1024 and scales the mask back up. `maxSide` only affects decode, mask resampling and the source used for the crop. Speed comes from the backend.
- **WebGPU is opt-in, off by default** (`?gpu` in the URL sets `ProcessOptions.gpu`). Tried as the default and reverted: on the owner's phone it was faster but (1) produced a near-transparent mask, so the card showed a faint ghost of the photo (likely fp16 precision on a mobile GPU; imgly offers no fp32 WebGPU path), and (2) froze the whole app during each photo, because the WebGPU compute shares the GPU queue with the WebGL renderer, and one long ISNet pass starves the frames even though it's dispatched from the worker. The CPU path in a worker doesn't touch the GPU, so rendering stays smooth.
- When enabled: `process.ts` probes `navigator.gpu.requestAdapter()` in the worker; if there's an adapter it runs `{ model: 'isnet_fp16', device: 'gpu' }`. On any GPU error it logs, sets `gpuUsable = false` for the session and retries that photo on the CPU. `ProcessResult.backend` says which backend ran.
- **CPU path:** `isnet_fp16` on desktop, `isnet_quint8` (smaller, about half the download and memory) on touch devices.
- **Gotcha:** imgly loads `onnxruntime-web` once per worker (`getOrt` is a module singleton). If the WebGPU bundle was loaded first, the CPU fallback reuses it with the `wasm` EP, which works, but if the WASM runtime itself failed to start, the fallback will fail too (and the original image is used).
- **Multi-threaded WASM needs cross-origin isolation.** imgly sets `numThreads = navigator.hardwareConcurrency`, but ORT drops to 1 thread unless `crossOriginIsolated`. GitHub Pages can't send COOP/COEP, so `public/coi-sw.js` (a tiny service worker, registered by an inline script in `index.html`) adds `COOP: same-origin`, `COEP: require-corp` and `CORP: same-origin` to same-origin responses. The first visit reloads once so the page comes back isolated. The inline script skips frames (the artifact build), insecure contexts and already-isolated pages; if a controlled page is still not isolated it sets `holo-cards:coi-failed` in localStorage and stops trying; `?nocoi` unregisters the worker. `vite.config.ts` sends the same headers in dev and preview.
- **Consequence of `require-corp`:** any new cross-origin resource loaded without CORS (an `<img>`, font or script from another host) must send `Cross-Origin-Resource-Policy`, or it's blocked. imgly's CDN fetches are CORS requests, so they're fine.
- Model and WASM files are fetched at runtime from imgly's CDN (`staticimgly.com/@imgly/background-removal-data/1.7.0/...`) and cached by the browser. The first photo pays the download (tens of MB).
- **Gotcha (fixed):** imgly memoises `init` keyed on `JSON.stringify(config)`. Functions don't serialise, so the first call's `progress` callback is reused forever (this caused the "1/8 on every photo" bug). `process.ts` keeps one config object per model with a stable progress function that forwards to a module-level `report`, which is reassigned per photo.
- Failure handling: on any error the original (non-cut-out) image is used and a human-readable warning is returned: model download failed, out of memory, or another error.
- **Where it can't work:** anywhere that blocks requests to `staticimgly.com`: the claude.ai artifact test build (CSP) and the cloud sandbox used for development (network policy). It works on GitHub Pages.
- **Self-hosting option (not done):** the npm package `@imgly/background-removal-data` only exists up to 1.4.5 (old resource layout: models `small` 44 MB / `medium` 88 MB in 4 MB chunks, plus ORT wasm variants), which is incompatible with lib 1.7.0. Self-hosting would mean downgrading the lib to 1.4.5 and serving those chunks from `public/` (or the artifact's files) via `publicPath`.
- **Licence:** imgly's lib is **AGPL-3.0**. Fine for this open-source project; swap it (e.g. a `rembg` endpoint or another ONNX segmentation model) if that ever changes.

## Known limits

- HEIC from iPhones decodes only where the browser supports it (Safari yes; others may fail → "couldn't be read").
- Low-memory phones may fail inference → fallback to the original image with a warning.
