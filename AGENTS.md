# AGENTS.md — holo-cards

Always-loaded context for coding agents. Keep it short; details live in `docs/` (listed below) and are read on demand.

## Keep these docs true

**Any code change that makes a statement in `AGENTS.md` or any file in `docs/` (or `README.md`) wrong must update that file in place, in the same commit.** That includes renamed files, changed constants, new gotchas, and decisions that were reversed. Don't append "update:" notes; edit the original statement. If you learn something non-obvious while working, add it to the relevant doc.

## What this is

A browser toy that turns the user's photos into **clear-plastic trading cards**, like the old transparent Pokémon cards: an opaque subject in the middle, see-through plastic everywhere else. The cards live in a **Balatro-style hand** that feels tactile (springs, lean, wobble, synthesised sound). Desktop and mobile. Fully client-side: no backend, nothing leaves the browser except a one-time model download.

- Repo: `coattosintetico/holo-cards` (public). Default branch `main`.
- Live: GitHub Pages, deployed by `.github/workflows/pages.yml` on every push to `main`.
- Stack: Vite + TypeScript (strict) + Three.js (raw `ShaderMaterial`s, no post-processing libs). `@imgly/background-removal` (ONNX, in a Web Worker). IndexedDB. Web Audio.

## Commands

```bash
npm install
```
```bash
npm run dev        # vite dev server
```
```bash
npm run typecheck  # tsc --noEmit; must pass before committing
```
```bash
npm run build      # typecheck + production build to dist/
```

There are no unit tests. Verify visually with headless Playwright; see `docs/testing.md`.

## Source map

| Path | Role |
| --- | --- |
| `src/main.ts` | DOM/UI glue: upload queue (feeds the deck), status/notice toasts, intro strip, sample cards + undo, inspect bar, drag-drop/paste, boot. |
| `src/app.ts` | `App`: renderer, camera, responsive scale, input (mouse + touch), hand/table/deck layout, deck → hand draw, inspect, render loop, persistence scheduling. |
| `src/card.ts` | `Card`: springs + meshes (card, shadow) + per-card scenes; `sync()` pushes springs into transforms; `hit()` hit-test; blank → preview `setTexture()` → real `setArt()`. |
| `src/render/cardMaterials.ts` | Plastic card shader and shadow shader. |
| `src/render/table.ts` | Procedural linen tablecloth shader. |
| `src/render/glsl.ts` | Shared GLSL snippets (noise, rounded-box SDF). |
| `src/physics/spring.ts` | Damped spring with fixed 240 Hz substeps. |
| `src/interaction/tilt.ts` | Phone tilt (DeviceOrientation) normalised to [-1, 1]. |
| `src/pipeline/*` | Photo → card art: `client.ts` (worker wrapper and fallback), `worker.ts`, `process.ts` (background removal), `crop.ts` (OffscreenCanvas crop/fit, deck preview `coverToArt`). |
| `src/audio/sfx.ts` | All sounds, synthesised in code. |
| `src/store/db.ts` | IndexedDB `holo-cards` / store `cards` (`CardRecord`). |
| `src/config.ts` | Card geometry constants (63×88 aspect, margins, art rect). |
| `public/demo/*.png` | Sample creature art (generated, transparent, deliberately off-centre to exercise the crop). |

## Rules that are easy to break

- **Colour management is off** (`THREE.ColorManagement.enabled = false`, linear output, `NoColorSpace` textures). Everything is in display space; don't "fix" this piecemeal.
- **The framebuffer must stay opaque** (dest alpha = 1) because it's copied as the refraction backdrop. Every transparent material uses the custom `BLEND` in `cardMaterials.ts`. The renderer has `antialias: false` (copying from an MSAA framebuffer fails); edges are anti-aliased in the shaders via SDF.
- **Draw order is manual:** table, then for each card back-to-front: its shadow, `copyBackdrop`, then the card. Depth testing is off everywhere.
- **imgly memoises its session on `JSON.stringify(config)`**, which drops functions, so per-call `progress` callbacks are silently ignored after the first call. Use the stable reporter in `process.ts`.
- **Pipeline code must work in a worker:** OffscreenCanvas only, no `document`.
- **The UI runs in sandboxed frames too** (the claude.ai artifact test build): no `alert`/`confirm`/`prompt`, and no network access to other hosts.
- **`[hidden]` must win over button `display`** (there's a global `[hidden]{display:none!important}`); keep it.
- Never put model identifiers in commits, PRs or code.

## User and working preferences

- The owner is a technical user (physics background, AI engineer, open-source, Linux, terminal-first). Be concise; no flattery.
- Work on a `claude/<topic>` branch, push, open a PR to `main`; the owner merges. Never push to `main` directly.
- Plan first for anything sizeable. Default to the agreed plan when in doubt, and flag blockers early.
- Visual direction: clean, minimal plastic card; warm, cozy, low-attention tablecloth; "Balatro feel" is the bar for interaction.

## Optional context (read when relevant)

- `docs/architecture.md`: rendering, shaders, the frame loop, layout and interaction mechanics, tuning constants.
- `docs/image-pipeline.md`: upload queue, worker, background removal, crop/fit, models, licensing, known limits.
- `docs/decisions.md`: product and design decisions with their reasons, and what the user asked for.
- `docs/testing.md`: headless Playwright recipes (desktop and mobile touch), what can't be tested in the sandbox.
- `docs/deploy.md`: GitHub Pages, the claude.ai artifact test build, git and clone quirks in cloud sessions.
- `docs/roadmap.md`: open items, unverified behaviour, ideas.
