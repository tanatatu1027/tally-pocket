// ===== 保存・読み込み(データの出し入れはこのファイルだけで行う) =====
// ブラウザの中の保存場所(IndexedDB)に、データ全体を1つのかたまりとして保存する。
// IndexedDB がそもそも開けない環境だけ localStorage を使う(どちらを使うかは起動時に1回だけ決める)。
// ★読み込みに失敗したときは「データなし」とは区別して、エラーとして知らせる
//   (実データをサンプルで上書きしてしまう事故を防ぐため)。

const DB_NAME = 'shisan-app';
const STORE = 'kv';
const KEY = 'state';
const LS_KEY = 'shisan-app-state';

let dbPromise = null;
let useLocalStorage = false;

// IndexedDB を開く(開いた接続は使い回す)
function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB なし'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('他のタブが使用中です'));
  });
  return dbPromise;
}

// 起動時に1回だけ呼ぶ。IndexedDB が使えなければ localStorage に切り替える
export async function initStorage() {
  // IndexedDB という機能そのものが無い環境だけ localStorage を使う。
  // 「ある のに開けない」ときは、データが2か所に分かれないよう、エラーとして止める
  if (!('indexedDB' in window)) { useLocalStorage = true; return; }
  await getDb();
}

// 保存されているデータを読む。まだ無ければ null。読み込みエラーは例外を投げる
export async function loadState() {
  if (useLocalStorage) {
    const text = localStorage.getItem(LS_KEY);
    return text ? JSON.parse(text) : null;
  }
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(KEY);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

// データを保存する。失敗したら例外を投げる(呼び出し側で利用者に知らせる)
export async function saveState(state) {
  const copy = JSON.parse(JSON.stringify(state));
  if (useLocalStorage) {
    localStorage.setItem(LS_KEY, JSON.stringify(copy));
    return;
  }
  const db = await getDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(copy, KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

// 「ブラウザに消さないで」とお願いする(許可されるかはブラウザしだい)
export async function requestPersist() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* 何もしない */ }
  return false;
}

// ---------- 共有機能の接続情報(暗号鍵など)。バックアップには入らない・localStorageには置かない ----------
const SYNC_KEY_NAME = 'sync-config';
export async function loadSyncConfig() {
  if (useLocalStorage) return null;
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(SYNC_KEY_NAME);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}
export async function saveSyncConfig(cfg) {
  if (useLocalStorage) throw new Error('この環境では共有機能を使えません');
  const db = await getDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(cfg, SYNC_KEY_NAME); // 暗号鍵(取り出し不可)をそのまま保存できる
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}
export async function clearSyncConfig() {
  if (useLocalStorage) return;
  const db = await getDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(SYNC_KEY_NAME);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
