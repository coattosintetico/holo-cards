/// <reference lib="webworker" />
import { processImage, type ProcessOptions } from './process';

export type WorkerRequest = { id: number; file: Blob; opts: ProcessOptions };
export type WorkerResponse =
  | { id: number; type: 'progress'; stage: string; frac?: number }
  | { id: number; type: 'done'; art: Blob; warning?: string }
  | { id: number; type: 'error'; message: string };

const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, file, opts } = e.data;
  try {
    const r = await processImage(file, (stage, frac) => post({ id, type: 'progress', stage, frac }), opts);
    post({ id, type: 'done', art: r.art, warning: r.warning });
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
