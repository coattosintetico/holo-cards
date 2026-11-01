import { processImage, type ProcessOptions, type ProcessResult, type Progress } from './process';
import type { WorkerRequest, WorkerResponse } from './worker';

type Job = { resolve: (r: ProcessResult) => void; reject: (e: Error) => void; progress: Progress };

class WorkerCrashed extends Error {}

/**
 * Runs the image pipeline in a Web Worker so background removal never
 * stalls the render loop. Falls back to the main thread if the worker
 * cannot start or crashes (e.g. no OffscreenCanvas).
 */
export class Pipeline {
  private worker: Worker | null = null;
  private jobs = new Map<number, Job>();
  private nextId = 1;

  constructor(private opts: ProcessOptions) {
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.worker.onerror = (e) => this.crash(e.message || 'worker error');
    } catch (err) {
      console.warn('worker unavailable, using main thread', err);
      this.worker = null;
    }
  }

  get inWorker(): boolean {
    return !!this.worker;
  }

  private onMessage(m: WorkerResponse): void {
    const job = this.jobs.get(m.id);
    if (!job) return;
    if (m.type === 'progress') return job.progress(m.stage, m.frac);
    this.jobs.delete(m.id);
    if (m.type === 'done') job.resolve({ art: m.art, warning: m.warning, backend: m.backend });
    else job.reject(new Error(m.message));
  }

  private crash(reason: string): void {
    console.warn('pipeline worker crashed:', reason);
    this.worker?.terminate();
    this.worker = null;
    for (const j of this.jobs.values()) j.reject(new WorkerCrashed(reason));
    this.jobs.clear();
  }

  async process(file: Blob, progress: Progress): Promise<ProcessResult> {
    if (this.worker) {
      try {
        return await new Promise<ProcessResult>((resolve, reject) => {
          const id = this.nextId++;
          this.jobs.set(id, { resolve, reject, progress });
          this.worker!.postMessage({ id, file, opts: this.opts } satisfies WorkerRequest);
        });
      } catch (err) {
        if (!(err instanceof WorkerCrashed)) throw err;
      }
    }
    return processImage(file, progress, this.opts);
  }
}
