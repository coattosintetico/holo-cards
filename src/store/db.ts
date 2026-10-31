export type Zone = 'hand' | 'table';

export interface CardRecord {
  id: string;
  art: Blob;
  zone: Zone;
  x: number;
  y: number;
  rot: number;
  order: number;
  created: number;
  /** Sample card shipped with the app. */
  demo?: boolean;
}

const DB = 'holo-cards';
const STORE = 'cards';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

export const db = {
  all: async () => ((await tx('readonly', (s) => s.getAll())) ?? []) as CardRecord[],
  put: (r: CardRecord) => tx('readwrite', (s) => void s.put(r)),
  putMany: (rs: CardRecord[]) => tx('readwrite', (s) => void rs.forEach((r) => s.put(r))),
  remove: (id: string) => tx('readwrite', (s) => void s.delete(id)),
  clear: () => tx('readwrite', (s) => void s.clear()),
};
