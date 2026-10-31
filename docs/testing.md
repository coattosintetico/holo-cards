# Testing

No unit tests. Changes are verified by typecheck plus a production build plus **screenshots from headless Chromium** driving the real app.

## Environment notes (cloud sessions)

- Chromium and Playwright are preinstalled: `require('playwright')` works from any directory. Don't `playwright install`.
- WebGL in headless mode: launch with `args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']`. SwiftShader is slow (~30 fps), so allow a few seconds after load for the demo cards to deal in.
- Start servers as background tasks (they time out after a while; restart when needed):
  - dev: `npx vite --port 5173 --strictPort`
  - prod: `npm run build && npx vite preview --port 4173 --strictPort` (use this to check the worker and lazy chunks in the real bundle)
- **Don't `pkill -f vite`** from a shell whose own command line contains "vite": it kills the shell itself.
- Keep test scripts and screenshots in the session scratchpad, not in the repo.

## Desktop recipe

```js
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:5173/'); await sleep(4500);
await p.mouse.move(720, 760, { steps: 5 });                    // hover a hand card
await p.mouse.down(); await p.mouse.move(900, 450, { steps: 8 }); // drag onto table
await p.mouse.up();
await p.mouse.dblclick(900, 450);                              // inspect
await p.click('#inspect-remove');                              // remove
await p.setInputFiles('#file', [...paths]);                    // upload
```

`window.app` exposes the `App` instance (e.g. `app.count`, `app.cards`, `app.hand`) for assertions.

## Mobile recipe

- Use `devices['iPhone 13']` **without** `defaultBrowserType` (spread it out) so it runs in Chromium. The viewport is 390×664 CSS px (not the 844 screen height): compute coordinates from `innerHeight`.
- Playwright's touchscreen only taps; for **press-and-drag** send CDP touch events:

```js
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent',
  { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
await touch('touchStart', 195, innerH - 80);
for (let i = 1; i <= 10; i++) await touch('touchMove', 195 + i * 6, innerH - 80 - i * 30);
await touch('touchEnd');
```

- Double-tap: two `touchStart`/`touchEnd` pairs about 120 ms apart on the same card.
- Touches outside the canvas hit `<html>`, scroll, and produce `pointercancel`; if nothing happens, check the coordinates first.

## Test fixtures

- `public/demo/*.png`: transparent art placed off-centre (exercises crop/fit without the ML step).
- For the background-removal path, use any opaque image (e.g. a creature drawn on a gradient). In the sandbox the model download is blocked, so the expected result is the fallback card plus the notice "Couldn't download the background-removal model…".

## Can't be verified in the sandbox

Real background-removal output and speed, real-device touch feel, phone tilt, haptics, iOS audio. Ask the owner to check those on the Pages deployment.
