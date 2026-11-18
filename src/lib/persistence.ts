/**
 * Tiny promise wrapper over IndexedDB (one object store, key → value).
 * Holds the Parquet snapshot of `pitches_raw` so datasets survive reloads.
 * Every call fails soft: private windows or blocked storage just mean no persistence.
 */
const DB_NAME = "abwizard";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[persistence]", err);
    return undefined;
  }
}

export const idbGet = <T>(key: string) => tx<T>("readonly", (s) => s.get(key));
export const idbPut = (key: string, value: unknown) => tx("readwrite", (s) => s.put(value, key)).then(() => undefined);
export const idbDelete = (key: string) => tx("readwrite", (s) => s.delete(key)).then(() => undefined);
