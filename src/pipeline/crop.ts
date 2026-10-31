import { ART_ASPECT, ART_MAX_PX } from '../config';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export async function blobToCanvas(blob: Blob, maxSide = 2048): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(bmp.width * s, bmp.height * s);
  c.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** Fraction of pixels that are (nearly) fully transparent. */
export function transparentFraction(c: HTMLCanvasElement): number {
  const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) n++;
  return n / (c.width * c.height);
}

/**
 * Crop to the bounding box of visible content. Uses per-row/column
 * histograms with a small noise floor so stray speckles left by background
 * removal do not inflate the box.
 */
export function cropToContent(c: HTMLCanvasElement, alphaThreshold = 24): HTMLCanvasElement {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
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
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Contain-fit the cropped art into a canvas with the card's art aspect. */
export function fitToArt(c: HTMLCanvasElement, padding = 0.03): HTMLCanvasElement {
  const outH = ART_ASPECT >= 1 ? ART_MAX_PX / ART_ASPECT : ART_MAX_PX;
  const outW = outH * ART_ASPECT;
  const out = makeCanvas(outW, outH);
  const ctx = out.getContext('2d')!;
  const availW = out.width * (1 - 2 * padding);
  const availH = out.height * (1 - 2 * padding);
  const s = Math.min(availW / c.width, availH / c.height);
  const dw = c.width * s;
  const dh = c.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  return out;
}

export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}
