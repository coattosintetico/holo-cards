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

/** A queued photo not yet turned into a card; survives reloads so the queue can resume. */
export interface PendingRecord {
  id: string;
  file: Blob;
  /** Queue order (FIFO). */
  created: number;
}

const DB = 'holo-cards';
const CARDS = 'cards';
const PENDING = 'pending';
type Store = typeof CARDS | typeof PENDING;

let conn: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  conn ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const names = r.result.objectStoreNames;
      if (!names.contains(CARDS)) r.result.createObjectStore(CARDS, { keyPath: 'id' });
      if (!names.contains(PENDING)) r.result.createObjectStore(PENDING, { keyPath: 'id' });
    };
    r.onsuccess = () => {
      // Let a newer tab upgrade the schema instead of blocking it.
      r.result.onversionchange = () => {
        r.result.close();
        conn = null;
      };
      res(r.result);
    };
    r.onerror = () => {
      conn = null;
      rej(r.error);
    };
  });
  return conn;
}

async function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  all: async () => ((await tx(CARDS, 'readonly', (s) => s.getAll())) ?? []) as CardRecord[],
  put: (r: CardRecord) => tx(CARDS, 'readwrite', (s) => void s.put(r)),
  putMany: (rs: CardRecord[]) => tx(CARDS, 'readwrite', (s) => void rs.forEach((r) => s.put(r))),
  remove: (id: string) => tx(CARDS, 'readwrite', (s) => void s.delete(id)),
  clear: () => tx(CARDS, 'readwrite', (s) => void s.clear()),

  pending: {
    all: async () => (((await tx(PENDING, 'readonly', (s) => s.getAll())) ?? []) as PendingRecord[]).sort((a, b) => a.created - b.created),
    put: (r: PendingRecord) => tx(PENDING, 'readwrite', (s) => void s.put(r)),
    remove: (id: string) => tx(PENDING, 'readwrite', (s) => void s.delete(id)),
    clear: () => tx(PENDING, 'readwrite', (s) => void s.clear()),
  },
};
