import { blobToCanvas, canvasToBlob, cropToContent, fitToArt, transparentFraction } from './crop';

export type Progress = (stage: string, frac?: number) => void;
export type Model = 'isnet' | 'isnet_fp16' | 'isnet_quint8';

export interface ProcessOptions {
  /** Model for the CPU (WASM) path. The WebGPU path always uses `isnet_fp16`. */
  model: Model;
  /** Try WebGPU first and fall back to the CPU if it's missing or fails. */
  gpu: boolean;
  /** Longest side the source is downscaled to before processing. */
  maxSide: number;
}

export type Backend = 'gpu' | 'cpu';

export interface ProcessResult {
  art: Blob;
  warning?: string;
  /** Where background removal ran; absent if it was skipped or failed. */
  backend?: Backend;
}

/** Images that already have a meaningful alpha channel skip the ML step. */
const ALREADY_CUT_OUT = 0.04;

/**
 * imgly memoises its model session keyed on JSON.stringify(config), which
 * drops functions: the progress callback of the *first* call would be reused
 * forever. So we pass one stable callback and redirect it per call.
 */
let report: Progress = () => {};
let backend: Backend = 'cpu';
const stableProgress = (key: string, current: number, total: number) => {
  if (key.startsWith('fetch')) report('download', total ? current / total : undefined);
  else report(`remove-${backend}`, total ? current / total : undefined);
};
const configs = new Map<string, object>();

function config(model: Model, device: Backend): object {
  const key = `${model}:${device}`;
  if (!configs.has(key)) configs.set(key, { model, device, output: { format: 'image/png' }, progress: stableProgress });
  return configs.get(key)!;
}

/** null = not probed yet. Flips to false for the session after any GPU failure. */
let gpuUsable: boolean | null = null;
async function probeGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function removeBg(blob: Blob, opts: ProcessOptions): Promise<{ blob: Blob; backend: Backend }> {
  const { removeBackground } = await import('@imgly/background-removal');
  if (opts.gpu && gpuUsable === null) gpuUsable = await probeGpu();
  if (opts.gpu && gpuUsable) {
    backend = 'gpu';
    try {
      // fp16 is the variant imgly recommends for WebGPU (quint8 runs badly there).
      return { blob: await removeBackground(blob, config('isnet_fp16', 'gpu')), backend };
    } catch (err) {
      console.warn('WebGPU background removal failed, using the CPU from now on', err);
      gpuUsable = false;
    }
  }
  backend = 'cpu';
  return { blob: await removeBackground(blob, config(opts.model, 'cpu')), backend };
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
  let used: Backend | undefined;
  progress('decode');
  let src = await blobToCanvas(file, opts.maxSide);
  if (transparentFraction(src) < ALREADY_CUT_OUT) {
    try {
      const cut = await removeBg(await canvasToBlob(src), opts);
      used = cut.backend;
      src = await blobToCanvas(cut.blob, opts.maxSide);
    } catch (err) {
      console.warn('background removal failed', err);
      warning = describe(err);
    }
  }
  progress('fit');
  const art = await canvasToBlob(fitToArt(cropToContent(src)));
  report = () => {};
  return { art, warning, backend: used };
}
