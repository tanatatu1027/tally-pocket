// ===== 端末どうしの共有(暗号化してクラウドに預け、同じ合言葉の端末で受け取る) =====
// ・合言葉 →(PBKDF2)→ 「暗号鍵」と「金庫の番号」を作る。合言葉そのものは保存しない・送らない。
// ・クラウドに送るのは AES-GCM で暗号化したデータと金庫の番号だけ。金額や名前は読めない。
// ・金庫の番号は、合言葉を知らないと分からない(64文字の推測できない番号)。
// ・暗号鍵は「取り出せない形」でこの端末の中に保存する(次回から合言葉の入力は不要)。
// ・共有するのは 分類・資産・金額 だけ。PINなどの設定は端末ごとのまま。
import { SYNC_URL, SYNC_KEY } from './config.js';
import { loadSyncConfig, saveSyncConfig, clearSyncConfig } from './storage.js';
import { parseBackup } from './backup.js';

const ROUNDS = 600000;
const SALT = new TextEncoder().encode('shisan-app/sync/v1');
const MAX_BYTES = 1500000; // 暗号化後の大きさの上限(サーバー側の上限より小さく)

export const syncConfigured = () => !!(SYNC_URL && SYNC_KEY);
export const syncSupported = () => !!(globalThis.crypto && crypto.subtle);

// 試験用に、保存先と通信を差し替えられるようにしておく
const io = { load: loadSyncConfig, save: saveSyncConfig, clear: clearSyncConfig, fetch: (...a) => globalThis.fetch(...a), url: SYNC_URL, key: SYNC_KEY };
export const _inject = (o) => Object.assign(io, o);

const b64 = (bytes) => { let t = ''; for (const b of bytes) t += String.fromCharCode(b); return btoa(t); };
const unb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// 順番をそろえた文字列にする(同じ内容なら必ず同じ文字になる)
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
// 共有する部分だけを取り出す
export const payloadOf = (state) => ({ categories: state.categories, assets: state.assets, records: state.records });
export async function hashOf(payload) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(payload)));
  return hex(new Uint8Array(d));
}

// 合言葉から 暗号鍵 と 金庫の番号 を作る
async function derive(pass) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ROUNDS }, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); // 取り出し不可
  return { id: hex(bits.slice(32, 64)), key };
}

async function encrypt(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = JSON.stringify({ app: 'shisan-app', version: 1, ...payload });
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(body)));
  const out = JSON.stringify({ v: 1, iv: b64(iv), data: b64(ct) });
  if (out.length > MAX_BYTES) throw new Error('データが大きすぎて共有できません');
  return out;
}
// 復号して、バックアップと同じ厳しさでチェックする(クラウドの中身も信用しない)
async function decrypt(key, text) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('クラウドのデータを読めません'); }
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.data)); }
  catch { throw new Error('合言葉が違うか、データが壊れています'); }
  const d = parseBackup(new TextDecoder().decode(plain));
  return { categories: d.categories, assets: d.assets, records: d.records };
}

// ---------- 通信(Supabase の3つの関数だけを呼ぶ) ----------
async function rpc(name, args) {
  let res;
  try {
    res = await io.fetch(`${io.url}/rest/v1/rpc/${name}`, {
      method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', apikey: io.key },
      body: JSON.stringify(args),
    });
  } catch { const e = new Error('ネットにつながっていません'); e.offline = true; throw e; }
  if (!res.ok) throw new Error('クラウドとの通信に失敗しました(' + res.status + ')');
  const text = await res.text(); // 削除などは中身が空(204)で返ってくる
  return text ? JSON.parse(text) : null;
}
async function remoteGet(id) {
  const rows = await rpc('shisan_get', { p_id: id });
  return Array.isArray(rows) && rows[0] ? { rev: Number(rows[0].rev), data: String(rows[0].data) } : null;
}
const remotePut = async (id, base, data) => Number(await rpc('shisan_put', { p_id: id, p_base: base, p_data: data }));

// ---------- 使い方 ----------
export async function status() { const c = await io.load(); return c ? { on: true, lastSyncAt: c.lastSyncAt || 0 } : { on: false }; }

// 合言葉で接続する。金庫がすでにあれば {exists:true, data, rev}。なければ {exists:false}
export async function connect(pass) {
  const { id, key } = await derive(pass);
  const remote = await remoteGet(id);
  const cfg = { id, key, baseRev: 0, lastHash: '', lastSyncAt: 0 };
  if (!remote) { await io.save(cfg); return { exists: false }; }
  const data = await decrypt(key, remote.data); // 合言葉が違えばここで失敗する
  await io.save(cfg);
  return { exists: true, data, rev: remote.rev };
}
// クラウドの内容をこの端末の基準にした、と記録する(取り込んだ直後に呼ぶ)
export async function markAdopted(rev, payload) {
  const c = await io.load(); if (!c) return;
  await io.save({ ...c, baseRev: rev, lastHash: await hashOf(payload), lastSyncAt: Date.now() });
}

// 同期する。結果:
//  {status:'off'|'idle'|'pushed'}                … 何もしなくてよい
//  {status:'pull', data, rev}                    … クラウドのほうが新しい(この端末は未変更)→ 取り込んでよい
//  {status:'conflict', data, rev}                … 両方変わった → 利用者に選んでもらう
//  {status:'offline'|'error', message}
export async function syncNow(payload) {
  const c = await io.load();
  if (!c) return { status: 'off' };
  try {
    for (let tries = 0; tries < 3; tries++) {
      const localHash = await hashOf(payload);
      const dirty = localHash !== c.lastHash;
      const remote = await remoteGet(c.id);
      const rrev = remote ? remote.rev : 0;
      if (rrev === c.baseRev && !dirty) { c.lastSyncAt = Date.now(); await io.save(c); return { status: 'idle' }; }
      if (rrev === c.baseRev || !remote) { // 手元だけが進んでいる(またはクラウドが空になっていた)→ 送る
        const newRev = await remotePut(c.id, rrev, await encrypt(c.key, payload));
        if (newRev < 0) continue; // 直前にほかの端末が書いた → もう一度見直す
        Object.assign(c, { baseRev: newRev, lastHash: localHash, lastSyncAt: Date.now() });
        await io.save(c);
        return { status: 'pushed' };
      }
      // クラウドのほうが進んでいる
      const data = await decrypt(c.key, remote.data);
      if ((await hashOf(data)) === localHash) { // 中身は同じ
        Object.assign(c, { baseRev: rrev, lastHash: localHash, lastSyncAt: Date.now() }); await io.save(c);
        return { status: 'idle' };
      }
      return { status: dirty ? 'conflict' : 'pull', data, rev: rrev };
    }
    return { status: 'error', message: '同時に更新されて送れませんでした。もう一度お試しください' };
  } catch (e) {
    return e.offline ? { status: 'offline', message: e.message } : { status: 'error', message: e.message };
  }
}

// 衝突したとき「この端末の内容で上書き」を選んだ場合
export async function forcePush(payload) {
  const c = await io.load(); if (!c) return { status: 'off' };
  try {
    const remote = await remoteGet(c.id);
    const newRev = await remotePut(c.id, remote ? remote.rev : 0, await encrypt(c.key, payload));
    if (newRev < 0) return { status: 'error', message: '同時に更新されました。もう一度お試しください' };
    Object.assign(c, { baseRev: newRev, lastHash: await hashOf(payload), lastSyncAt: Date.now() });
    await io.save(c);
    return { status: 'pushed' };
  } catch (e) { return { status: 'error', message: e.message }; }
}

// 共有をやめる。deleteCloud が true ならクラウドのデータも消す
export async function disconnect(deleteCloud) {
  const c = await io.load();
  if (c && deleteCloud) await rpc('shisan_delete', { p_id: c.id });
  await io.clear();
}
