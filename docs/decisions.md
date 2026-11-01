# Decisions

What was decided, by whom, and why. When a decision is reversed, edit its entry in place.

## Product (asked for by the owner)

- **Concept:** web visualiser for photos as old transparent "clear plastic" Pokémon-style cards: subject printed in the middle, the rest of the card transparent plastic.
- **Upload → auto-rescale** so the subject fills the art area (crop to content, then fit).
- **Background removal is in scope**, done in the browser.
- **Balatro-like interaction:** smooth, satisfying card handling, plus good sound design. This is the quality bar.
- **Three.js** for rendering (owner's choice).
- **Background:** a tablecloth that is warm and cozy but doesn't grab attention.
- **Sound:** "the easiest solution", hence fully synthesised Web Audio (no asset files, no licences).
- **Style:** clean and minimal for now ("get the first one good first"). No frames or rarity effects yet.
- **Mobile:** first desktop-only; later the owner asked for full mobile support (touch drag/pick, correct sizing, non-blocking processing, progress feedback, discoverability).
- **Samples:** removed automatically on the first upload, with Undo (the owner chose the recommended option).
- **Deck while processing:** uploaded photos stack face up in a deck at the top left that floats and rocks slowly, showing the photo blurred and distorted; the card being processed is on top and has a running rim light; pressing the deck refuses it (shake plus knock). Each card is drawn into the hand, Balatro-style, as soon as it's processed. New uploads go to the bottom (FIFO). Previews are cover-fitted into the art window. (Replaced the earlier shimmering placeholder dealt straight into the hand.)
- **Phone tilt** for inspect: wanted now, partly to help debug the look on devices.

## Technical (proposed by the agent, accepted)

- **Single WebGL canvas with custom shaders** rather than CSS 3D: real refraction, specular and Fresnel need shaders.
- **Refraction via framebuffer copies per card** (sub-rect only), instead of a separate render target per layer: simple, and lets stacked clear cards see each other.
- **No MSAA, SDF anti-aliasing:** copying from a multisampled framebuffer isn't allowed.
- **Springs for everything**, fixed-step integration: frame-rate independent feel, easy to tune.
- **Hand/table zones:** dropping above the hand leaves a card on the table; dropping in the hand inserts or reorders. Tapping returns the card.
- **Remove via inspect bar** (works on touch); `Del` stays as a desktop shortcut.
- **Pipeline in a Web Worker** with a main-thread fallback; queue processes one photo at a time.
- **Smaller model on phones** (`isnet_quint8`) for download size and memory, on the CPU path. WebGPU always uses `isnet_fp16`.
- **Speed up inference client-side before adding a backend:** the owner found ~1 min per photo on the phone and floated a server that processes uploads in the background. Agreed to first try WebGPU, multi-threaded WASM (via a COOP/COEP service worker on Pages), a wake lock and a resumable queue, and to revisit the backend only if that's still too slow.
- **Onboarding:** intro strip ("These are sample cards…") plus a pulsing **Add photos** button until first use. Pulsing is disabled under `prefers-reduced-motion`.
- **Two-step Clear** (button turns into "Remove all?") instead of `confirm()`, which sandboxed frames block.
- **Deploy on GitHub Pages** via Actions; a claude.ai artifact build is used for quick private tests.
- **Imgly CDN for model files** (not self-hosted) for now; see `image-pipeline.md` for the trade-off.
