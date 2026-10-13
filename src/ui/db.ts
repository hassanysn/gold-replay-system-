// Small promise wrapper around IndexedDB: settings (kv), drawings, journal, screenshots.

const DB_NAME = 'gold-replay';
const DB_VERSION = 1;

export type StoreName = 'kv' | 'drawings' | 'journal' | 'shots';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('drawings')) db.createObjectStore('drawings', { keyPath: 'id' }).createIndex('day', 'day');
        if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('shots')) db.createObjectStore('shots');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return wrap((await store(name, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(name: StoreName): Promise<T[]> {
  return wrap((await store(name, 'readonly')).getAll()) as Promise<T[]>;
}

export async function put(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await wrap((await store(name, 'readwrite')).put(value, key));
}

export async function del(name: StoreName, key: IDBValidKey): Promise<void> {
  await wrap((await store(name, 'readwrite')).delete(key));
}

/** Drawings whose day is within [from, to] (YYYY-MM-DD, inclusive). */
export async function drawingsBetween<T>(from: string, to: string): Promise<T[]> {
  const idx = (await store('drawings', 'readonly')).index('day');
  return wrap(idx.getAll(IDBKeyRange.bound(from, to))) as Promise<T[]>;
}
