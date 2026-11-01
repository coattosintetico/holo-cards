import { ART_ASPECT, ART_MAX_PX } from '../config';

/** All image work uses OffscreenCanvas so it runs both in a worker and on the main thread. */
export type Canvas = OffscreenCanvas;

export function makeCanvas(w: number, h: number): Canvas {
  return new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

const ctx2d = (c: Canvas) => c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

export async function blobToCanvas(blob: Blob, maxSide = 2048): Promise<Canvas> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(bmp.width * s, bmp.height * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** Fraction of pixels that are (nearly) fully transparent. */
export function transparentFraction(c: Canvas): number {
  const { data } = ctx2d(c).getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) n++;
  return n / (c.width * c.height);
}

/**
 * Crop to the bounding box of visible content. Uses per-row/column
 * histograms with a small noise floor so stray speckles left by background
 * removal do not inflate the box.
 */
export function cropToContent(c: Canvas, alphaThreshold = 24): Canvas {
  const ctx = ctx2d(c);
  const { width: w, height: h } = c;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Clean faint halo so it does not show up as a grey fringe on plastic.
      if (d[i + 3] < 8) d[i + 3] = 0;
      if (d[i + 3] > alphaThreshold) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const floorR = Math.max(1, Math.floor(w * 0.003));
  const floorC = Math.max(1, Math.floor(h * 0.003));
  let y0 = 0, y1 = h - 1, x0 = 0, x1 = w - 1;
  while (y0 < h && rows[y0] < floorR) y0++;
  while (y1 > y0 && rows[y1] < floorR) y1--;
  while (x0 < w && cols[x0] < floorC) x0++;
  while (x1 > x0 && cols[x1] < floorC) x1--;
  if (y0 >= h || x0 >= w) return c; // nothing visible: keep as-is

  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  ctx2d(out).drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Quick, low-res preview of a photo cover-fitted into the art window (shown
 * on queued cards while the real art is processed). Decodes downscaled.
 */
export async function coverToArt(blob: Blob, maxPx = 384): Promise<Canvas> {
  const outH = ART_ASPECT >= 1 ? maxPx / ART_ASPECT : maxPx;
  const out = makeCanvas(outH * ART_ASPECT, outH);
  const probe = await createImageBitmap(blob, { resizeWidth: out.width * 2, resizeQuality: 'medium' });
  const s = Math.max(out.width / probe.width, out.height / probe.height);
  const dw = probe.width * s;
  const dh = probe.height * s;
  const ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(probe, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  probe.close();
  return out;
}

/** Contain-fit the cropped art into a canvas with the card's art aspect. */
export function fitToArt(c: Canvas, padding = 0.03): Canvas {
  const outH = ART_ASPECT >= 1 ? ART_MAX_PX / ART_ASPECT : ART_MAX_PX;
  const outW = outH * ART_ASPECT;
  const out = makeCanvas(outW, outH);
  const ctx = ctx2d(out);
  const availW = out.width * (1 - 2 * padding);
  const availH = out.height * (1 - 2 * padding);
  const s = Math.min(availW / c.width, availH / c.height);
  const dw = c.width * s;
  const dh = c.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  return out;
}

export function canvasToBlob(c: Canvas): Promise<Blob> {
  return c.convertToBlob({ type: 'image/png' });
}
