import { blobToCanvas, canvasToBlob, cropToContent, fitToArt, transparentFraction } from './crop';

export type Progress = (stage: string, frac?: number) => void;
export type Model = 'isnet' | 'isnet_fp16' | 'isnet_quint8';

export interface ProcessOptions {
  model: Model;
  /** Longest side the source is downscaled to before processing. */
  maxSide: number;
}

export interface ProcessResult {
  art: Blob;
  warning?: string;
}

/** Images that already have a meaningful alpha channel skip the ML step. */
const ALREADY_CUT_OUT = 0.04;

/**
 * imgly memoises its model session keyed on JSON.stringify(config), which
 * drops functions: the progress callback of the *first* call would be reused
 * forever. So we pass one stable callback and redirect it per call.
 */
let report: Progress = () => {};
const stableProgress = (key: string, current: number, total: number) => {
  if (key.startsWith('fetch')) report('download', total ? current / total : undefined);
  else report('remove', total ? current / total : undefined);
};
const configs = new Map<Model, object>();

async function removeBg(blob: Blob, model: Model): Promise<Blob> {
  const { removeBackground } = await import('@imgly/background-removal');
  if (!configs.has(model)) {
    configs.set(model, { model, output: { format: 'image/png' }, progress: stableProgress });
  }
  return removeBackground(blob, configs.get(model)!);
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch|network|load/i.test(msg)) return "Couldn't download the background-removal model, so the original image was used.";
  if (/memory|allocation|OOM/i.test(msg)) return 'Not enough memory to remove the background, so the original image was used.';
  return `Background removal failed (${msg}), so the original image was used.`;
}

/** Full pipeline: file -> transparent, content-filling art PNG. */
export async function processImage(file: Blob, progress: Progress, opts: ProcessOptions): Promise<ProcessResult> {
  report = progress;
  let warning: string | undefined;
  progress('decode');
  let src = await blobToCanvas(file, opts.maxSide);
  if (transparentFraction(src) < ALREADY_CUT_OUT) {
    try {
      const cut = await removeBg(await canvasToBlob(src), opts.model);
      src = await blobToCanvas(cut, opts.maxSide);
    } catch (err) {
      console.warn('background removal failed', err);
      warning = describe(err);
    }
  }
  progress('fit');
  const art = await canvasToBlob(fitToArt(cropToContent(src)));
  report = () => {};
  return { art, warning };
}
