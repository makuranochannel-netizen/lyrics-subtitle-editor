// IndexedDB 永続化レイヤー
// stores: lyrics（歌詞ライブラリ）, projects（編集プロジェクト）, videos（任意保存の動画Blob）,
//         handles（FileSystemFileHandle）, fonts（ユーザー追加フォント）, meta（アプリ状態）

const DB_NAME = 'lyrics-subtitle-editor';
const DB_VERSION = 1;
const STORES = ['lyrics', 'projects', 'videos', 'handles', 'fonts', 'meta'];

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // ブラウザにストレージの永続化を依頼（容量逼迫時の自動削除を防ぐ）
  navigator.storage?.persist?.().catch(() => {});
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  getAll: (store) => tx(store, 'readonly', s => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', s => s.put(value)),
  delete: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  async getMeta(key, def = null) { const r = await this.get('meta', key); return r ? r.value : def; },
  setMeta: (key, value) => tx('meta', 'readwrite', s => s.put({ key, value })),
};
