import { blobToCanvas, canvasToBlob, cropToContent, fitToArt, transparentFraction } from './crop';

export type Progress = (msg: string, frac?: number) => void;

/** Images that already have a meaningful alpha channel skip the ML step. */
const ALREADY_CUT_OUT = 0.04;

async function removeBg(blob: Blob, progress: Progress): Promise<Blob> {
  const { removeBackground } = await import('@imgly/background-removal');
  return removeBackground(blob, {
    model: 'isnet_fp16',
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      if (key.startsWith('fetch')) progress('Downloading model (first time only)…', total ? current / total : undefined);
      else progress('Removing background…');
    },
  });
}

/** Full pipeline: file -> transparent, content-filling art PNG. */
export async function processImage(file: Blob, progress: Progress = () => {}, onWarn?: (msg: string) => void): Promise<Blob> {
  let src = await blobToCanvas(file);
  if (transparentFraction(src) < ALREADY_CUT_OUT) {
    try {
      const cut = await removeBg(await canvasToBlob(src), progress);
      src = await blobToCanvas(cut);
    } catch (err) {
      // e.g. model CDN unreachable: still make a card, just without the cut-out.
      console.warn('background removal failed', err);
      onWarn?.('Background removal unavailable, using the original image');
    }
  }
  progress('Fitting…');
  return canvasToBlob(fitToArt(cropToContent(src)));
}
