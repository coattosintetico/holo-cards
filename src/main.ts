import { App, isCoarse } from './app';
import type { Card } from './card';
import { Pipeline } from './pipeline/client';
import { db, type CardRecord } from './store/db';
import './style.css';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $<HTMLCanvasElement>('#scene');
const input = $<HTMLInputElement>('#file');
const addBtn = $<HTMLButtonElement>('#add');
const clearBtn = $<HTMLButtonElement>('#clear');
const muteBtn = $<HTMLButtonElement>('#mute');
const statusEl = $<HTMLDivElement>('#status');
const statusText = $<HTMLSpanElement>('#status-text');
const statusSub = $<HTMLSpanElement>('#status-sub');
const notice = $<HTMLDivElement>('#notice');
const noticeText = $<HTMLSpanElement>('#notice-text');
const noticeAction = $<HTMLButtonElement>('#notice-action');
const intro = $<HTMLDivElement>('#intro');
const dropzone = $<HTMLDivElement>('#dropzone');
const empty = $<HTMLDivElement>('#empty');
const inspectBar = $<HTMLDivElement>('#inspect-bar');
const tiltBtn = $<HTMLButtonElement>('#tilt');

const app = new App(canvas);
(window as unknown as { app: App }).app = app;
const coarse = isCoarse();
const pipeline = new Pipeline({ model: coarse ? 'isnet_quint8' : 'isnet_fp16', maxSide: coarse ? 1600 : 2048 });

// --------------------------------------------------------------- storage flags

const flag = {
  get(k: string): boolean {
    try {
      return localStorage.getItem(`holo-cards:${k}`) === '1';
    } catch {
      return false;
    }
  },
  set(k: string): void {
    try {
      localStorage.setItem(`holo-cards:${k}`, '1');
    } catch {
      /* private mode: fine */
    }
  },
};

// ------------------------------------------------------------------ messages

let noticeTimer = 0;
function say(msg: string, action?: { label: string; run: () => void }, ms = 3200): void {
  noticeText.textContent = msg;
  noticeAction.hidden = !action;
  noticeAction.onclick = action
    ? () => {
        notice.classList.remove('show');
        action.run();
      }
    : null;
  if (action) noticeAction.textContent = action.label;
  notice.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => notice.classList.remove('show'), action ? Math.max(ms, 7000) : ms);
}

function refreshChrome(): void {
  empty.classList.toggle('show', app.count === 0 && !running);
  const showIntro = app.onlyDemo && !running && !app.inspected;
  intro.classList.toggle('show', showIntro);
  document.body.classList.toggle('has-intro', showIntro);
  addBtn.classList.toggle('pulse', !flag.get('added') && (app.onlyDemo || app.count === 0));
}
app.events.onChange = refreshChrome;

// --------------------------------------------------------------- upload queue

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

type Job = { file: Blob; card: Card };
const queue: Job[] = [];
let running = false;
let batchTotal = 0;
let batchDone = 0;
let batchAdded = 0;
let batchWarnings = new Set<string>();
let avgMs = 0;

function setStatus(main: string, sub = ''): void {
  statusText.textContent = main;
  statusSub.textContent = sub;
}

function stageText(stage: string, frac?: number): string {
  if (stage === 'download') {
    const pct = frac !== undefined ? ` ${Math.round(frac * 100)}%` : '';
    return `Downloading the background-removal model${pct} (first time only)`;
  }
  if (stage === 'remove') return 'Removing background…';
  if (stage === 'fit') return 'Fitting to the card…';
  return 'Reading image…';
}

function addFiles(files: Iterable<Blob>): void {
  const list = [...files].filter((f) => f.type.startsWith('image/') || f.type === '');
  if (!list.length) return;
  flag.set('added');

  // First photos of your own replace the samples (undoable).
  if (app.onlyDemo) {
    void app.removeDemo().then((recs) => {
      if (!recs.length) return;
      say('Sample cards removed.', {
        label: 'Undo',
        run: async () => {
          for (let i = 0; i < recs.length; i++) await app.addCard(recs[i], { deal: i * 0.1 });
          await db.putMany(recs);
          refreshChrome();
        },
      });
    });
  }

  for (let i = 0; i < list.length; i++) {
    const card = app.addPending(uid(), { deal: 0.1 + i * 0.09 });
    queue.push({ file: list[i], card });
  }
  batchTotal += list.length;
  void run();
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  statusEl.classList.add('show');
  refreshChrome();
  while (queue.length) {
    const job = queue.shift()!;
    const idx = batchDone + 1;
    const head = () => (batchTotal > 1 ? `Processing ${idx} of ${batchTotal}` : 'Processing your photo');
    const eta = () => {
      const left = batchTotal - batchDone;
      return avgMs && left > 1 ? ` · about ${Math.ceil((avgMs * left) / 1000)} s left` : '';
    };
    setStatus(head() + eta(), avgMs ? 'Removing the background can take a few seconds per photo.' : 'Removing the background can take a while. You can keep playing meanwhile.');
    const t0 = performance.now();
    try {
      const { art, warning } = await pipeline.process(job.file, (stage, frac) => setStatus(head() + eta(), stageText(stage, frac)));
      if (warning) batchWarnings.add(warning);
      const ms = performance.now() - t0;
      avgMs = avgMs ? avgMs * 0.6 + ms * 0.4 : ms;
      if (app.has(job.card)) {
        await app.resolvePending(job.card, art);
        const rec: CardRecord = { id: job.card.id, art, zone: job.card.zone, x: job.card.rest.x, y: job.card.rest.y, rot: job.card.rest.rot, order: job.card.order, created: Date.now() };
        await db.put(rec);
        app.sfx.chime();
        batchAdded++;
      }
    } catch (err) {
      console.error(err);
      batchWarnings.add(`One photo couldn't be read (${(err as Error).message}).`);
      if (app.has(job.card)) await app.removeCard(job.card, { silent: true });
    }
    batchDone++;
  }
  running = false;
  statusEl.classList.remove('show');
  const summary = batchAdded === 1 ? '1 card added.' : `${batchAdded} cards added.`;
  say([summary, ...batchWarnings].join(' '), undefined, batchWarnings.size ? 7000 : 2600);
  batchTotal = batchDone = batchAdded = 0;
  batchWarnings = new Set();
  refreshChrome();
}

// ------------------------------------------------------------------- boot

async function loadDemo(): Promise<void> {
  const names = ['ember', 'sprout', 'droplet', 'pebble', 'moth'];
  const blobs = await Promise.all(
    names.map((n) => fetch(`${import.meta.env.BASE_URL}demo/${n}.png`).then((r) => (r.ok ? r.blob() : null))),
  );
  const recs: CardRecord[] = [];
  for (const b of blobs) {
    if (!b) continue;
    const { art } = await pipeline.process(b, () => {});
    recs.push({ id: uid(), art, zone: 'hand', x: 0, y: 0, rot: 0, order: recs.length, created: Date.now(), demo: true });
  }
  for (let i = 0; i < recs.length; i++) await app.addCard(recs[i], { deal: 0.15 + i * 0.12 });
  await db.putMany(recs);
}

async function boot(): Promise<void> {
  const saved = (await db.all()).sort((a, b) => a.order - b.order);
  if (saved.length) {
    for (let i = 0; i < saved.length; i++) await app.addCard(saved[i], saved[i].zone === 'hand' ? { deal: 0.1 + i * 0.08 } : {});
  } else if (!flag.get('added')) {
    await loadDemo().catch((e) => console.warn('demo load failed', e));
  }
  refreshChrome();
}

// --------------------------------------------------------------------- UI

addBtn.addEventListener('click', () => {
  app.sfx.unlock();
  flag.set('added');
  refreshChrome();
  input.click();
});
$('#intro-add').addEventListener('click', () => addBtn.click());
$('#intro-clear').addEventListener('click', async () => {
  app.sfx.unlock();
  const recs = await app.removeDemo();
  say('Sample cards removed.', {
    label: 'Undo',
    run: async () => {
      for (let i = 0; i < recs.length; i++) await app.addCard(recs[i], { deal: i * 0.1 });
      await db.putMany(recs);
      refreshChrome();
    },
  });
  refreshChrome();
});
input.addEventListener('change', () => {
  if (input.files) addFiles(input.files);
  input.value = '';
});

// Two-step confirm in the page itself (native confirm() is unavailable in sandboxed frames).
let clearArmed = 0;
const disarm = () => {
  clearTimeout(clearArmed);
  clearArmed = 0;
  clearBtn.querySelector('span')!.textContent = 'Clear';
  clearBtn.classList.remove('armed');
};
clearBtn.addEventListener('click', async () => {
  app.sfx.unlock();
  if (!app.count) return;
  if (!clearArmed) {
    clearBtn.querySelector('span')!.textContent = 'Remove all?';
    clearBtn.classList.add('armed');
    clearArmed = window.setTimeout(disarm, 2500);
    return;
  }
  disarm();
  await app.clearAll();
  refreshChrome();
});

muteBtn.addEventListener('click', () => {
  app.sfx.unlock();
  app.sfx.muted = !app.sfx.muted;
  if (app.sfx.muted) app.sfx.setSlide(0);
  muteBtn.classList.toggle('off', app.sfx.muted);
  muteBtn.setAttribute('aria-pressed', String(app.sfx.muted));
  muteBtn.querySelector('span')!.textContent = app.sfx.muted ? 'Sound off' : 'Sound on';
});

// Inspect bar: remove / phone tilt / close.
app.events.onInspect = (card) => {
  inspectBar.classList.toggle('show', !!card);
  refreshChrome();
  tiltBtn.hidden = !('DeviceOrientationEvent' in window) || !coarse;
  tiltBtn.classList.toggle('on', app.tilt.enabled);
};
$('#inspect-remove').addEventListener('click', () => {
  const c = app.inspected;
  if (c) void app.removeCard(c).then(refreshChrome);
});
$('#inspect-close').addEventListener('click', () => app.endInspect());
tiltBtn.addEventListener('click', async () => {
  if (app.tilt.enabled) {
    app.tilt.disable();
  } else if (!(await app.tilt.enable())) {
    say('Motion access was not allowed. On iPhone, allow it when asked, or reload and try again.');
  }
  tiltBtn.classList.toggle('on', app.tilt.enabled);
  tiltBtn.querySelector('span')!.textContent = app.tilt.enabled ? 'Tilt on' : 'Tilt with phone';
});

// Drag & drop / paste.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('show');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('show');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('show');
  app.sfx.unlock();
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items ?? [])].map((i) => i.getAsFile()).filter((f): f is File => !!f);
  addFiles(files);
});

// Block pinch-zoom / double-tap zoom gestures on iOS Safari.
document.addEventListener('gesturestart', (e) => e.preventDefault());

void boot();
