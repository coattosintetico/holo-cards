import { App } from './app';
import { processImage } from './pipeline/process';
import { db, type CardRecord } from './store/db';
import './style.css';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $<HTMLCanvasElement>('#scene');
const input = $<HTMLInputElement>('#file');
const toast = $<HTMLDivElement>('#toast');
const dropzone = $<HTMLDivElement>('#dropzone');
const empty = $<HTMLDivElement>('#empty');
const muteBtn = $<HTMLButtonElement>('#mute');

const app = new App(canvas);
(window as unknown as { app: App }).app = app;

let toastTimer = 0;
function say(msg: string, sticky = false): void {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1800);
}

function refreshEmpty(): void {
  empty.classList.toggle('show', app.count === 0);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

let queue = Promise.resolve();
function addFiles(files: Iterable<Blob>): void {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  queue = queue.then(async () => {
    let added = 0;
    const warnings = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const prefix = list.length > 1 ? `${i + 1}/${list.length} · ` : '';
      try {
        const art = await processImage(
          list[i],
          (m, f) => say(prefix + m + (f !== undefined ? ` ${Math.round(f * 100)}%` : ''), true),
          (w) => warnings.add(w),
        );
        const rec: CardRecord = { id: uid(), art, zone: 'hand', x: 0, y: 0, rot: 0, order: app.count, created: Date.now() };
        await app.addCard(rec, { deal: 0 });
        await db.put(rec);
        app.sfx.chime();
        refreshEmpty();
        added++;
      } catch (err) {
        console.error(err);
        warnings.add(`Could not process an image: ${(err as Error).message}`);
      }
    }
    const summary = added === 1 ? '1 card added' : `${added} cards added`;
    say([summary, ...warnings].join(' · '));
  });
}

async function loadDemo(): Promise<void> {
  const names = ['ember', 'sprout', 'droplet', 'pebble', 'moth'];
  const blobs = await Promise.all(
    names.map((n) => fetch(`${import.meta.env.BASE_URL}demo/${n}.png`).then((r) => (r.ok ? r.blob() : null))),
  );
  const recs: CardRecord[] = [];
  for (const b of blobs) {
    if (!b) continue;
    const art = await processImage(b);
    recs.push({ id: uid(), art, zone: 'hand', x: 0, y: 0, rot: 0, order: recs.length, created: Date.now() });
  }
  for (let i = 0; i < recs.length; i++) await app.addCard(recs[i], { deal: 0.15 + i * 0.12 });
  await db.putMany(recs);
}

async function boot(): Promise<void> {
  const saved = (await db.all()).sort((a, b) => a.order - b.order);
  if (saved.length) {
    for (let i = 0; i < saved.length; i++) await app.addCard(saved[i], saved[i].zone === 'hand' ? { deal: 0.1 + i * 0.08 } : {});
  } else {
    await loadDemo().catch((e) => console.warn('demo load failed', e));
  }
  refreshEmpty();
}

// ------------------------------------------------------------------ UI

$('#add').addEventListener('click', () => {
  app.sfx.unlock();
  input.click();
});
input.addEventListener('change', () => {
  if (input.files) addFiles(input.files);
  input.value = '';
});
// Two-step confirm in the page itself (native confirm() is unavailable in sandboxed frames).
const clearBtn = $<HTMLButtonElement>('#clear');
let clearArmed = 0;
clearBtn.addEventListener('click', async () => {
  app.sfx.unlock();
  if (!app.count) return;
  if (!clearArmed) {
    clearBtn.textContent = 'Remove all?';
    clearBtn.classList.add('armed');
    clearArmed = window.setTimeout(() => {
      clearArmed = 0;
      clearBtn.textContent = 'Clear';
      clearBtn.classList.remove('armed');
    }, 2500);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  clearBtn.textContent = 'Clear';
  clearBtn.classList.remove('armed');
  await app.clearAll();
  refreshEmpty();
});
muteBtn.addEventListener('click', () => {
  app.sfx.unlock();
  app.sfx.muted = !app.sfx.muted;
  if (app.sfx.muted) app.sfx.setSlide(0);
  muteBtn.textContent = app.sfx.muted ? 'Sound off' : 'Sound on';
});

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

void boot();
