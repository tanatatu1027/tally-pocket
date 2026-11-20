// ===== バックアップ(JSONファイルの書き出し・読み込み)と、読み込み時のチェック =====
// ※ PINの情報はバックアップに含めない(ファイルが漏れても関係ないようにする)

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// IDに使える文字(__proto__ などの特殊な名前を防ぐため、英数字と - _ だけ)
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

// 現在のデータをバックアップ用の形にする
export function toBackup(state) {
  return {
    app: 'shisan-app',
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: state.categories,
    assets: state.assets,
    records: state.records,
  };
}

// ---------- 暗号化(パスコードでバックアップを守る) ----------
// ブラウザ標準の Web Crypto API だけを使う(自作の暗号は使わない)。
//   鍵づくり: PBKDF2(パスコードを何十万回も混ぜて鍵にする。総当たりを遅くする)
//   暗号化  : AES-GCM(中身を隠し、改ざんも検知する)
// salt と iv は毎回ランダムに作り、ファイルに一緒に書く(秘密ではないが、使い回さないことが大事)
const KDF_ROUNDS = 600000;
const b64 = (bytes) => { let t = ''; for (const b of bytes) t += String.fromCharCode(b); return btoa(t); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt, rounds) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const canEncrypt = () => !!(window.crypto && crypto.subtle);

// 暗号化されたバックアップかどうか(中身は読まず、見出しだけで判定)
export function isEncryptedBackup(text) {
  try { const o = JSON.parse(text); return !!o && o.app === 'shisan-app' && o.encrypted === true; } catch { return false; }
}

// 文字を暗号化して、ファイルに書ける形(JSON文字列)にする
export async function encryptText(plain, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, KDF_ROUNDS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return JSON.stringify({ app: 'shisan-app', encrypted: true, version: 1, kdf: 'PBKDF2-SHA256', iterations: KDF_ROUNDS, salt: b64(salt), iv: b64(iv), data: b64(data) });
}

// 暗号化されたファイルを元に戻す。パスコードが違う・改ざんされているときは Error
export async function decryptText(text, pass) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('ファイルを読めません'); }
  const rounds = Number(o.iterations);
  // 異常に大きい回数を指定されて固まらないよう、範囲を決めておく
  if (!Number.isInteger(rounds) || rounds < 100000 || rounds > 2000000) throw new Error('暗号化の設定が正しくありません');
  try {
    const key = await deriveKey(pass, unb64(o.salt), rounds);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('パスコードが違うか、ファイルが壊れています');
  }
}

// ファイルとしてダウンロードする。ファイル名は目立たない名前にする。
// passphrase を渡すと暗号化して書き出す
export async function downloadBackup(state, passphrase) {
  let text = JSON.stringify(toBackup(state), null, 2);
  if (passphrase) text = await encryptText(text, passphrase);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup-${passphrase ? 'enc-' : ''}${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 読み込んだファイルが正しい形かを細かくチェックし、安全な形に作り直して返す。
// 問題があれば Error を投げる。
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('JSONとして読めません'); }
  if (!raw || raw.app !== 'shisan-app') throw new Error('このアプリのバックアップではありません');
  if (raw.version !== 1) throw new Error('対応していないバージョンです');
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.assets) || typeof raw.records !== 'object' || !raw.records || Array.isArray(raw.records)) {
    throw new Error('データの形が正しくありません');
  }
  if (raw.categories.length < 1) throw new Error('分類が1つもありません');
  if (![...raw.categories, ...raw.assets].every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    throw new Error('データの形が正しくありません');
  }
  if (raw.categories.length > 100 || raw.assets.length > 2000) throw new Error('データが多すぎます');

  const str = (v, max) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error('文字の項目が正しくありません');
    return v;
  };
  const idStr = (v) => {
    if (typeof v !== 'string' || !ID_RE.test(v) || BAD_IDS.has(v)) throw new Error('IDの形式が正しくありません');
    return v;
  };

  const catIds = new Set();
  const categories = raw.categories.map((c) => {
    const id = idStr(c.id);
    if (catIds.has(id)) throw new Error('分類IDが重複しています');
    catIds.add(id);
    const color = COLOR_RE.test(c.color) ? c.color : '#64748b';
    return { id, name: str(c.name, 30), color };
  });

  const assetIds = new Set();
  const assets = raw.assets.map((a) => {
    const id = idStr(a.id);
    if (assetIds.has(id)) throw new Error('資産IDが重複しています');
    assetIds.add(id);
    const categoryId = idStr(a.categoryId);
    if (!catIds.has(categoryId)) throw new Error('存在しない分類を指している資産があります');
    return { id, name: str(a.name, 60), categoryId, memo: typeof a.memo === 'string' ? a.memo.slice(0, 200) : '' };
  });

  const records = {};
  for (const [month, vals] of Object.entries(raw.records)) {
    if (!MONTH_RE.test(month)) throw new Error('月の形式が正しくありません');
    if (!vals || typeof vals !== 'object') throw new Error('月のデータが正しくありません');
    records[month] = {};
    for (const [aid, v] of Object.entries(vals)) {
      if (!assetIds.has(aid)) continue; // 存在しない資産の金額は無視
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 9999999999999) throw new Error('金額が正しくありません');
      records[month][aid] = Math.round(v);
    }
  }
  return { categories, assets, records, exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 25) : '' };
}
