# Architecture

How rendering, motion and input work. Source of truth is the code; update this file when the code changes it.

## World and camera

- Perspective camera, `FOV = 35°`, looking down -z at the table plane `z = 0`.
- World units: the visible table height is `viewH` units, and the camera z is chosen so that `z = 0` spans exactly `viewH`.
- **Responsive scale** (`App.resize`): `viewH = max(MIN_VIEW_H = 10, CARD_W * MIN_CARDS_ACROSS / aspect)` with `MIN_CARDS_ACROSS = 4`. On desktop that is 10 units tall. On a portrait phone the table grows so that at least 4 card widths fit across.
- Cards are `CARD_H = 3` × `CARD_W = 3 × 63/88` units (`src/config.ts`).
- Lifting a card means increasing its `z`. Perspective makes it bigger, and the shadow offset and blur grow with `z`.
- Pixel ratio cap: 2 on fine pointers, 1.75 on coarse (touch) devices.

## Frame loop (`App.frame`)

1. Per-frame hover re-pick (mouse only), so cards that slide under a still cursor react.
2. `layout(dt)` sets spring **targets** for every card (hand fan, table rest positions, hover, drag, inspect, phone tilt).
3. Step each card's springs (`stepSprings`, fixed 1/240 s substeps). Cards with `delay > 0` (being dealt) wait.
4. `card.sync()` pushes spring values into the mesh and shadow transforms and uniforms. Idle sway (small sin on rotation and tilt) is applied here, not through springs.
5. Render: clear, then the table scene, then for each card in `drawOrder()` (back to front):
   1. render its **shadow** (lands on everything already drawn),
   2. `copyBackdrop(card)`: `copyTexSubImage2D` of only the card's projected screen rect (+3 % pad for the refraction offset) into a `FramebufferTexture`,
   3. render the **card**, which samples that backdrop for refraction.

   This makes stacked cards refract each other, and keeps phones from paying for N full-screen copies.

Draw order: table cards by `order` (bumped on every touch) < hand cards by index (hovered +500) < dragged < inspected.

## Plastic card shader (`render/cardMaterials.ts`)

All in card-local units `p` (centred), with a rounded-rect SDF `d`:
- **Alpha / AA:** `smoothstep` on `d` with `fwidth`, so there's no MSAA dependency.
- **Bevel:** within `bevelW = 0.05` of the edge, the normal tilts outward along the SDF gradient. This drives the rim refraction, a greenish edge tint, and a faint thin-film iridescence.
- **Refraction:** `refract(-V, N, 1/1.49)`; screen-UV offset `(R.xy + V.xy) × 0.05` with slight per-channel dispersion. The plastic body is the backdrop, slightly milky and cool.
- **Lighting:** fixed light from the upper left (`(-0.45, 0.65, 1)`), sharp plus broad specular, Fresnel, a soft "sky" gradient, a thin rim line, and a faint inner bevel line that reads as thickness.
- **Glare band:** a diagonal double band whose position depends on the card normal (tilt), so it sweeps when cards lean, plus a tiny time drift.
- **Art:** sampled inside `ART_RECT` and composited opaque over the plastic. It also receives specular and glare (it sits under the plastic surface).
- `uDim`: inspect mode dims only the art (the backdrop is already dimmed via the table).
- `uPending`: placeholder state; a shimmer sweep plus a spinning arc ring.

Shadow shader: blurred rounded rect (plastic, faint: `0.07 + 0.15·blur`) plus the art's alpha from a **blurred mip level** (`textureLod`, level `2 + 4·blur`). The art textures therefore need mipmaps (`LinearMipmapLinearFilter`).

## Tablecloth (`render/table.ts`)

Procedural plain weave (22 threads/unit, over/under per cell, slub noise) with antialias fade by `fwidth`, two fbm fold layers, deep terracotta palette, a warm lamp pool slightly above centre, dark falloff to the edges, and 2/255 dithering against banding. `uDim` darkens it in inspect mode.

## Motion: springs (`physics/spring.ts`, `card.ts`)

Every animated property is a damped spring (`stiffness`, `damping`):

| Spring | k / c | Notes |
| --- | --- | --- |
| x, y | 210 / 21 | set to 520 / 34 while dragging (tight follow), restored on drop |
| z (lift) | 160 / 16 | drop applies `impulse(-3 - speed·0.1)`, which gives a bounce |
| rot (in-plane) | 180 / 15 | |
| tiltX, tiltY | 220 / 14 | |
| scale | 260 / 15 | pick-up `impulse(+1.2)`, drop `impulse(-0.9)` (squash) |
| hover, dim | 200 / 25, 120 / 22 | shader uniforms |
| pending | 90 / 14 | 1 → 0 when the art arrives |

Euler order is `'XYZ'`, so in-plane rotation applies first and tilt is about the screen axes.

## Layout (`App.layout`)

- **Hand:** `handY = -viewH/2 + 0.64·CARD_H`. Span `= min(viewW·0.6, viewW − 1.2·CARD_W, (n−1)·0.95·CARD_W)`, so the outer card edges stay on screen. Slight arc (`y −= x0²·0.012`) and fan rotation (`−x0·0.028`).
- While dragging over the hand zone (`y < -viewH/2 + 1.12·CARD_H`), a gap opens at the insertion index, with a tick sound when it changes.
- **Hover:** in-hand cards rise 0.42 and straighten; all hovered cards lift (`z 0.45`), scale 1.07 and tilt toward the pointer (±0.32 rad). Neighbours are pushed aside by `min(0.32, spacing/2)`.
- **Hold / drag:** from the moment of press (not only after the 10 px tap threshold), the held card follows the pointer, lifts to `z 1.4` and scale 1.08, and leans into velocity: `rot = −vx·0.022`, `tiltY = vx·0.03`, `tiltX = −vy·0.03` (clamped). The cloth slide sound follows speed.
  - The grab offset is measured on the **card's own plane** at press (`z0`) and scaled by `(camZ − z)/(camZ − z0)` while following, so the grabbed point stays exactly under the pointer while the card lifts (no perspective shift).
  - On touch the card floats up to `0.28·CARD_H` above the finger, easing in (smoothstep) over the first 120 px of travel after the tap threshold, so there's no jump at drag start.
  - The hover branch skips the held card. It isn't in the hand slots while held, so its targets aren't reset each frame and the hover's relative `y += 0.42` would accumulate (this was the "card flies off the top" bug).
- **Drop:** in the hand zone it joins the hand at the insertion index; above it, it stays on the table at its position with a small random rotation (`rest`). A tap (no move, < 280 ms) returns the card to where it was.
- **Table cards** saved on a larger screen are clamped into view.
- **Inspect:** centred, `z 3.2`, scale `min(1.55, fit-to-screen)`, tilt follows the pointer (`±0.5`) or phone tilt; other cards dimmed.
- **Phone tilt** (when enabled): all hand and table cards get a subtle tilt (`±0.15`), and the inspected card follows it fully.

## Input (`App`)

- Pointer events only (mouse and touch unified); non-primary pointers are ignored; `pointercancel` is treated as up.
- Touch has no hover: the hover state is set on press and cleared on release, and hover ticks are mouse-only.
- **Double-tap / double-click** detection is custom (two taps < 380 ms, < 30 px apart, same card); the native `dblclick` is not used.
- Inspect is dismissed by tapping the canvas (> 300 ms after opening), `Esc`, or the Close button. Events from UI buttons never dismiss it (target check).
- `Del` / `Backspace` removes the inspected or hovered card.
- Haptics: `navigator.vibrate` (6 ms pick-up, 10 ms drop; Android only).

## Sound (`audio/sfx.ts`)

All synthesised (oscillators plus filtered noise), routed through a compressor and a generated-IR convolver reverb (~0.9 s, low-passed, 16 % wet). Random pitch and gain per voice. Voices: hover tick (pitch climbs in whole tones when sweeping within 260 ms), reorder tick, pick-up, drop (strength-scaled), deal, chime (new card), remove, inspect whoosh, and a continuous band-passed noise "slide" whose gain and cutoff follow drag speed. `unlock()` runs on pointerdown and pointerup (iOS).

## Persistence (`store/db.ts`)

IndexedDB DB `holo-cards`, store `cards`, key `id`. `CardRecord = { id, art: Blob (processed PNG), zone: 'hand'|'table', x, y, rot, order, created, demo? }`. Saves are debounced by 400 ms after drops and changes. Pending (unfinished) cards are never saved. localStorage flag `holo-cards:added` remembers that the user has uploaded or pressed Add, which stops the pulse and stops samples from reloading.
