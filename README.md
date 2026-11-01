# holo-cards

A web toy that turns your photos into clear-plastic trading cards, like the old transparent Pokémon cards (opaque creature in the middle, see-through plastic everywhere else), with a tactile, Balatro-style hand you can play with.

Everything runs in the browser. No backend, and nothing leaves your machine (apart from a one-time download of the background-removal model).

## Run

```bash
npm install
```

```bash
npm run dev
```

Works on desktop and phones (WebGL2 required).

## Use

- **Add photos** (button, drag & drop anywhere, or paste). The background is removed automatically, the subject is cropped to its content and fitted to the card.
  Images that already have transparency skip the ML step.
- Photos are processed in a background worker: each photo waits in a floating deck at the top left (shown blurred and warped), and is drawn into your hand as soon as it's ready, while you keep playing. The first photo downloads the model once (~40–80 MB); after that each photo takes a few seconds.
- Your first upload replaces the sample cards (with Undo).
- **Drag** cards around (press & drag on touch). Drop above the hand to leave a card on the table; drop into the hand to reorder.
- **Double-click / double-tap** to inspect a card up close: it tilts with the mouse, your finger, or, on phones, with **Tilt with phone** (motion sensor; iOS asks for permission). From there you can **Remove** it.
- **Del / Backspace** removes the hovered card on desktop.
- Your deck is saved in IndexedDB.

## How it works

| Piece | Where | Notes |
| --- | --- | --- |
| Image pipeline | `src/pipeline/` | Runs in a Web Worker (`worker.ts`, main-thread fallback in `client.ts`). `@imgly/background-removal` (ONNX in the browser, lazy-loaded; smaller quantised model on phones) → alpha bounding-box crop with a noise floor → contain-fit into the card's art window, all on OffscreenCanvas. |
| Plastic card | `src/render/cardMaterials.ts` | Custom shader: rounded-rect SDF, bevelled edge normals, refraction of the backdrop with slight dispersion, specular, a glare band driven by tilt, thin-film tint on the rim. |
| Refraction backdrop | `src/app.ts` (`copyBackdrop`) | Cards are drawn back-to-front. Before each card, only the screen rect it can sample is copied from the framebuffer, so stacked cards refract each other and phones don't pay for full-screen copies. |
| Responsive scale | `src/app.ts` (`resize`) | The visible table grows on narrow screens so a card is at most ~¼ of the width; the hand fan keeps its outer edges on screen. |
| Phone tilt | `src/interaction/tilt.ts` | DeviceOrientation mapped to screen axes, with a slowly re-centring neutral pose. |
| Shadows | `src/render/cardMaterials.ts` | Art alpha sampled from a blurred mip level; offset and softness grow with lift. |
| Tablecloth | `src/render/table.ts` | Procedural plain-weave linen under a warm lamp pool, dithered. |
| Feel | `src/physics/spring.ts`, `src/app.ts` | Every property (x, y, lift, rotation, tilt, scale) is a damped spring stepped at 240 Hz. Drag leans into velocity; hover tilts toward the cursor; idle sway keeps the glare alive. |
| Sound | `src/audio/sfx.ts` | 100% synthesised with Web Audio (no assets): hover ticks that climb in pitch when sweeping, pickup/drop, cloth "slide" that follows drag speed, deal, chime, small generated reverb. |

## Licensing note

`@imgly/background-removal` is **AGPL-3.0**. Fine for an open-source toy; if this ever becomes closed-source or a hosted product, swap it (e.g. a self-hosted `rembg` endpoint or another ONNX segmentation model).

## For contributors and coding agents

Start with [`AGENTS.md`](AGENTS.md) (always-relevant context and rules); deeper notes are in [`docs/`](docs/). Keep them in sync with the code.
