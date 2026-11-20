// ===== 便利道具(画面部品づくり・金額の表示・入力の読み取りなど) =====

// 金額を「隠す」状態かどうか(プライバシーモード)
let masked = false;
export const setMask = (v) => { masked = v; };
export const isMasked = () => masked;

// 数字を「¥1,234,567」の形にする
export function yen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

// 画面に出す金額。隠しているときは「¥ ••••••」にする
export function fmt(n) {
  return masked ? '¥ ••••••' : yen(n);
}

// 増減の表示(+¥1,000 / −¥1,000)
export function fmtSigned(n) {
  if (masked) return '••••';
  return (n >= 0 ? '+' : '−') + yen(Math.abs(n));
}

// 入力欄の文字を数字に変える。全角・カンマ・円記号OK。空欄は null、不正は NaN
export function parseAmount(text) {
  const t = String(text).normalize('NFKC').replace(/[,\s¥￥円]/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const v = Math.round(Number(t));
  return v > 9999999999999 ? NaN : v; // 約10兆円まで
}

// 今月を「2026-11」の形で返す(端末の日付を使う)
export function nowMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// 「2026-11」→「2026年11月」/ 短い形「26/11」
export const monthLabel = (m) => m.slice(0, 4) + '年' + Number(m.slice(5)) + '月';
export const monthShort = (m) => m.slice(2, 4) + '/' + m.slice(5);

// 月を前後にずらす(例: addMonths('2026-01', -1) → '2025-12')
export function addMonths(m, diff) {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5)) - 1 + diff;
  const ny = y + Math.floor(mo / 12);
  const nm = ((mo % 12) + 12) % 12;
  return ny + '-' + String(nm + 1).padStart(2, '0');
}

// ほかと重ならない ID を作る(HTTP環境でも動く方法)
export function uid() {
  return Date.now().toString(36) + randomHex(4);
}

// ランダムな文字列(できる範囲で、予測されにくい乱数を使う)
export function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  if (window.crypto?.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 画面の部品(HTMLの要素)を安全に作る道具。
// innerHTML を使わず、文字は必ず「ただの文字」として入れる(XSS対策)
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'css') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// 画面の下に一瞬メッセージを出す
export function toast(message, ms = 2400) {
  const t = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
