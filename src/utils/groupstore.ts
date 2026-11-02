// groupStore.ts - tiny IndexedDB wrapper. Everything survives closing the browser.
// Stores: kv (device identity, lastSeen), groups, messages, outbox (unsent wires).

const DB_NAME = 'speed-share-groups';
let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('groups', { keyPath: 'gid' });
      d.createObjectStore('messages', { keyPath: 'id' }).createIndex('gid_ts', ['gid', 'ts']);
      d.createObjectStore('outbox', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

async function run<T = any>(
  name: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  const d = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = d.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve((req ? req.result : undefined) as T);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: <T>(k: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(k)),
  set: (k: string, v: unknown) => run('kv', 'readwrite', (s) => s.put(v, k))
};

export const store = {
  all: <T>(name: 'groups' | 'messages' | 'outbox') => run<T[]>(name, 'readonly', (s) => s.getAll()),
  get: <T>(name: 'groups' | 'messages' | 'outbox', key: string) =>
    run<T | undefined>(name, 'readonly', (s) => s.get(key)),
  put: (name: 'groups' | 'messages' | 'outbox', value: unknown) =>
    run(name, 'readwrite', (s) => s.put(value)),
  del: (name: 'groups' | 'messages' | 'outbox', key: string) =>
    run(name, 'readwrite', (s) => s.delete(key))
};

/** Newest `limit` messages of a group, oldest first. */
export async function messagesFor<T>(gid: string, limit = 300): Promise<T[]> {
  const d = await openDb();
  return new Promise<T[]>((resolve, reject) => {
    const out: T[] = [];
    const idx = d.transaction('messages').objectStore('messages').index('gid_ts');
    const req = idx.openCursor(IDBKeyRange.bound([gid, 0], [gid, Number.MAX_SAFE_INTEGER]), 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (c && out.length < limit) {
        out.push(c.value as T);
        c.continue();
      } else resolve(out.reverse());
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMessagesFor(gid: string): Promise<void> {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction('messages', 'readwrite');
    const req = t
      .objectStore('messages')
      .index('gid_ts')
      .openCursor(IDBKeyRange.bound([gid, 0], [gid, Number.MAX_SAFE_INTEGER]));
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function deleteOutboxFor(gid: string): Promise<void> {
  const items = await store.all<{ id: string; gid: string }>('outbox');
  await Promise.all(items.filter((i) => i.gid === gid).map((i) => store.del('outbox', i.id)));
}
