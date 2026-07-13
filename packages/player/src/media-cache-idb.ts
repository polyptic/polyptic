/**
 * IndexedDB backend for the POL-32 media cache — the only persistence available to the wall.
 *
 * The player is served over PLAIN HTTP (netboot boxes reach the control plane without TLS by
 * design), which is not a secure context, so service workers and the Cache API are off the table.
 * IndexedDB predates the secure-context policy and works on insecure origins in every engine we
 * target (WebKitGTK included), so blobs live here.
 *
 * Two object stores keyed by URL: `meta` (small records — pruning iterates these without ever
 * materializing a blob) and `blobs` (the bytes). If IndexedDB is unavailable or broken (private
 * browsing, quota, corrupted db) `openIdbMediaStore` resolves to null and the player simply runs
 * uncached — exactly the pre-POL-32 behaviour, never an error on the glass.
 */
import type { MediaCacheStore, MediaMeta } from "./media-cache";

const DB_NAME = "polyptic-media-cache";
const DB_VERSION = 1;
const META_STORE = "meta";
const BLOB_STORE = "blobs";

/** Promisify one IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    r.onsuccess = () => resolvePromise(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

/** Wait for a transaction to fully commit (writes are only durable at `complete`). */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    tx.oncomplete = () => resolvePromise();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

class IdbMediaStore implements MediaCacheStore {
  constructor(private readonly db: IDBDatabase) {}

  async getMeta(url: string): Promise<MediaMeta | undefined> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const result = await req(tx.objectStore(META_STORE).get(url));
    return (result as MediaMeta | undefined) ?? undefined;
  }

  async getBlob(url: string): Promise<Blob | undefined> {
    const tx = this.db.transaction(BLOB_STORE, "readonly");
    const result = await req(tx.objectStore(BLOB_STORE).get(url));
    return result instanceof Blob ? result : undefined;
  }

  async put(meta: MediaMeta, blob: Blob): Promise<void> {
    const tx = this.db.transaction([META_STORE, BLOB_STORE], "readwrite");
    tx.objectStore(META_STORE).put(meta);
    tx.objectStore(BLOB_STORE).put(blob, meta.url);
    await done(tx);
  }

  async putMeta(meta: MediaMeta): Promise<void> {
    const tx = this.db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(meta);
    await done(tx);
  }

  async delete(url: string): Promise<void> {
    const tx = this.db.transaction([META_STORE, BLOB_STORE], "readwrite");
    tx.objectStore(META_STORE).delete(url);
    tx.objectStore(BLOB_STORE).delete(url);
    await done(tx);
  }

  async allMeta(): Promise<MediaMeta[]> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const result = await req(tx.objectStore(META_STORE).getAll());
    return (result as MediaMeta[]) ?? [];
  }
}

/**
 * Open (or create) the media-cache database. Resolves to null when IndexedDB is unavailable or the
 * open fails — the caller runs uncached rather than failing. Also asks the browser (best-effort)
 * to mark storage persistent so a storage-pressure sweep doesn't silently empty the wall's cache.
 */
export function openIdbMediaStore(): Promise<MediaCacheStore | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // navigator.storage missing on older engines — purely best-effort.
  }
  return new Promise((resolvePromise) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolvePromise(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
    };
    request.onsuccess = () => resolvePromise(new IdbMediaStore(request.result));
    request.onerror = () => resolvePromise(null);
    request.onblocked = () => resolvePromise(null);
  });
}
