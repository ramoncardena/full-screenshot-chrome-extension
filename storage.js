// Hands screenshots from the background worker to the editor page via IndexedDB
// (images are too big for URLs or chrome.storage). Shared by both contexts.
const SHOTS_DB = 'full-page-shot';
const SHOTS_STORE = 'shots';
// Old screenshots are dropped on the next save; this window keeps reloads of the editor working.
const SHOT_TTL_MS = 24 * 60 * 60 * 1000;

function openShotsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHOTS_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHOTS_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withShotsStore(mode, action) {
  const db = await openShotsDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SHOTS_STORE, mode);
      const result = action(tx.objectStore(SHOTS_STORE));
      tx.oncomplete = () => resolve(result.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function saveShot({ blob, filename }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await withShotsStore('readwrite', (store) => {
    store.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (now - cursor.value.createdAt > SHOT_TTL_MS) cursor.delete();
      cursor.continue();
    };
    return store.put({ blob, filename, createdAt: now }, id);
  });
  return id;
}

function loadShot(id) {
  return withShotsStore('readonly', (store) => store.get(id));
}
