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

Desktop browsers with WebGL2 only for now.

## Use

- **Add photos** (button, drag & drop anywhere, or paste). The background is removed automatically, the subject is cropped to its content and fitted to the card.
  Images that already have transparency skip the ML step.
- **Drag** cards around. Drop above the hand to leave a card on the table; drop into the hand to reorder.
- **Double-click** to inspect a card up close (move the mouse to tilt it). Click or `Esc` to put it back.
- **Del / Backspace** removes the hovered card.
- Your deck is saved in IndexedDB.

## How it works

| Piece | Where | Notes |
| --- | --- | --- |
| Image pipeline | `src/pipeline/` | `@imgly/background-removal` (ONNX in the browser, lazy-loaded) → alpha bounding-box crop with a noise floor → contain-fit into the card's art window. |
| Plastic card | `src/render/cardMaterials.ts` | Custom shader: rounded-rect SDF, bevelled edge normals, refraction of the backdrop with slight dispersion, specular, a glare band driven by tilt, thin-film tint on the rim. |
| Refraction backdrop | `src/app.ts` (`frame`) | Cards are drawn back-to-front. Before each card the framebuffer is copied to a texture, so stacked cards refract each other, not just the table. |
| Shadows | `src/render/cardMaterials.ts` | Art alpha sampled from a blurred mip level; offset and softness grow with lift. |
| Tablecloth | `src/render/table.ts` | Procedural plain-weave linen under a warm lamp pool, dithered. |
| Feel | `src/physics/spring.ts`, `src/app.ts` | Every property (x, y, lift, rotation, tilt, scale) is a damped spring stepped at 240 Hz. Drag leans into velocity; hover tilts toward the cursor; idle sway keeps the glare alive. |
| Sound | `src/audio/sfx.ts` | 100% synthesised with Web Audio (no assets): hover ticks that climb in pitch when sweeping, pickup/drop, cloth "slide" that follows drag speed, deal, chime, small generated reverb. |

## Licensing note

`@imgly/background-removal` is **AGPL-3.0**. Fine for an open-source toy; if this ever becomes closed-source or a hosted product, swap it (e.g. a self-hosted `rembg` endpoint or another ONNX segmentation model).
