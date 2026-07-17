// IndexedDB session store.
// One object store, keyed by session id. Each record is self-contained
// (holds the original .xlsx bytes) so a session can resume with no re-upload.
//
// Record shape:
//   { id, fileName, createdAt, updatedAt, fileHash, xlsxBytes (ArrayBuffer),
//     sheetName, prompt,
//     columns { inputs:[letter...], outFull:{index,letter,name}, outShort:{...} },
//     results { [rowIndex]: { full, short, status } },
//     progress { done, total } }

const DB_NAME = 'ai-names-gen';
const DB_VERSION = 2;
const STORE = 'sessions';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' });
      // Look up re-uploads by file hash without deserializing every session's bytes.
      if (!store.indexNames.contains('fileHash')) {
        store.createIndex('fileHash', 'fileHash', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const request = fn(store);
    t.oncomplete = () => resolve(request && request.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putSession(session) {
  session.updatedAt = Date.now();
  const db = await open();
  try {
    return await tx(db, 'readwrite', (store) => store.put(session));
  } finally {
    db.close();
  }
}

export async function getSession(id) {
  const db = await open();
  try {
    return await tx(db, 'readonly', (store) => store.get(id));
  } finally {
    db.close();
  }
}

export async function listSessions() {
  const db = await open();
  try {
    const all = await tx(db, 'readonly', (store) => store.getAll());
    // Strip the heavy xlsxBytes for listing — the landing screen needs only metadata.
    return (all || [])
      .map(({ id, fileName, createdAt, updatedAt, sheetName, progress }) => ({
        id, fileName, createdAt, updatedAt, sheetName, progress,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } finally {
    db.close();
  }
}

export async function deleteSession(id) {
  const db = await open();
  try {
    return await tx(db, 'readwrite', (store) => store.delete(id));
  } finally {
    db.close();
  }
}

export async function findByHash(fileHash) {
  const db = await open();
  try {
    // Index fetch pulls at most one matching record instead of loading (and
    // deserializing the xlsxBytes of) every session on each file drop.
    const hit = await tx(db, 'readonly', (store) => store.index('fileHash').get(fileHash));
    return hit || null;
  } finally {
    db.close();
  }
}
