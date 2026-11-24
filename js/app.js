// ===== アプリの本体(画面の切り替え・操作の処理) =====
import { h, fmt, fmtSigned, addMonths, parseAmount, nowMonth, monthLabel, uid, randomHex, toast, setMask, isMasked } from './util.js';
import { initStorage, loadState, saveState, requestPersist } from './storage.js';
import {
  monthsOf, latestMonth, valueOf, totalOf, byCategory, percents, previousMonth, diffFromPrev, looksWrong,
} from './calc.js';
import { drawDonut, drawLine, destroyCharts } from './charts.js';
import { downloadBackup, parseBackup, isEncryptedBackup, decryptText, canEncrypt } from './backup.js';
import { emptyState, PALETTE } from './defaults.js';
import { syncConfigured, syncSupported, payloadOf, status as syncStatus, connect as syncConnect, markAdopted, syncNow, forcePush, disconnect as syncDisconnect } from './sync.js';

// ---------- 他のサイトの中に埋め込まれていたら動かさない(クリックを盗む攻撃の対策) ----------
const EMBEDDED = window.top !== window.self;
if (EMBEDDED) {
  document.body.replaceChildren('このアプリは、ほかのページの中では使えません。');
  throw new Error('embedded'); // 以降のコードを実行しない
}

// ---------- 状態(アプリが覚えていること) ----------
let state;                                   // 保存されるデータ本体
const ui = { tab: 'home', period: 12, stacked: false, open: new Set(), excluded: new Set() }; // excluded: 見ないことにした資産のid(基本は空=全部見る) // 画面の状態(保存しない)
const runtime = { autoMasked: false, locked: false, picking: 0, bioPrompt: null }; // picking: ファイル選択中の印(この時刻まで有効)                    // 一時的な状態

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const tabbar = document.getElementById('tabbar');
const eyeBtn = document.getElementById('eye');

const TABS = [
  { id: 'home', label: 'ホーム', icon: '🏠' },
  { id: 'trend', label: '推移', icon: '📊' },
  { id: 'assets', label: '資産一覧', icon: '👛' },
  { id: 'settings', label: '設定', icon: '⚙️' },
];

// 分類の名前から、かわいい絵文字を選ぶ(見た目だけ。データには保存しない)
const EMOJI = { 預金: '🏦', 現金: '💴', 株式: '📈', 投資信託: '🌱', 暗号資産: '🪙', ポイント: '🎁', その他: '✨' };
const bubble = (cat, small = false) =>
  h('span', { class: 'bubble' + (small ? ' sm' : ''), css: { background: cat.color }, 'aria-hidden': 'true' }, EMOJI[cat.name] || '🐷');
const pigImg = (cls) => h('img', { src: 'icons/pig.png', class: cls, alt: '' });

// データを保存して、画面を描き直す
async function commit() {
  try {
    await saveState(state);
  } catch {
    toast('⚠ 保存できませんでした。端末の空き容量を確認して、バックアップを書き出してください', 9000);
  }
  render();
  scheduleSync();
}

// 金額を隠すかどうかを反映する
function applyMask() {
  setMask(!!state.settings.hidden || runtime.autoMasked);
  document.body.classList.toggle('masked', isMasked()); // 隠しているときはグラフもぼかす
  eyeBtn.textContent = isMasked() ? '🙈' : '👁';
  eyeBtn.setAttribute('aria-label', isMasked() ? '金額を表示する' : '金額を隠す');
}

// 今月の記録がなければ、前の月の金額をコピーして作る(前月コピー)
function ensureMonth(month) {
  if (state.records[month]) return;
  const prev = monthsOf(state).filter((m) => m < month).pop();
  state.records[month] = prev ? { ...state.records[prev] } : {};
}

// ---------- 部品: ボトムシート(下から出る入力画面)と確認ダイアログ ----------
function openSheet(title, body) {
  const overlay = h('div', { class: 'overlay' });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('noscroll'); };
  document.addEventListener('keydown', onKey);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '閉じる', onclick: close }, '×')),
    h('div', { class: 'sheet-body' }, body));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.append(sheet);
  document.body.append(overlay);
  document.body.classList.add('noscroll');
  return close;
}

// 「本当にいいですか?」の確認。OKなら true を返す
function confirmBox(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay center' });
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.append(h('div', { class: 'dialog', role: 'alertdialog' },
      h('p', {}, message),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'やめる'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => done(true) }, okLabel))));
    document.body.append(overlay);
  });
}

// パスコードなどを1行入力してもらう。キャンセルなら null を返す
function askSecret(message, { confirmAgain = false, minLength = 1, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay center' });
    const done = (v) => { overlay.remove(); resolve(v); };
    const a = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'パスコード' });
    const b = confirmAgain ? h('input', { type: 'password', autocomplete: 'off', placeholder: 'もう一度', 'aria-label': 'パスコード(確認)' }) : null;
    const err = h('p', { class: 'error', role: 'alert' });
    const ok = () => {
      if (a.value.length < minLength) { err.textContent = `${minLength}文字以上にしてください`; return; }
      if (b && a.value !== b.value) { err.textContent = '2回の入力が違います'; return; }
      done(a.value);
    };
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !b) ok(); });
    overlay.append(h('div', { class: 'dialog', role: 'dialog', 'aria-label': message },
      h('p', {}, message), a, b, err,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'やめる'),
        h('button', { class: 'btn primary grow', type: 'button', onclick: ok }, okLabel))));
    document.body.append(overlay);
    a.focus();
  });
}

// 選択肢が2つ以上あるダイアログ。選んだ値を返す
function choiceBox(message, choices) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay center' });
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.append(h('div', { class: 'dialog', role: 'alertdialog' },
      h('p', {}, message),
      h('div', { class: 'col-btns' }, choices.map((c) =>
        h('button', { class: 'btn ' + (c.kind || ''), type: 'button', onclick: () => done(c.value) }, c.label)))));
    document.body.append(overlay);
  });
}

// ---------- 端末どうしの共有(くわしい仕組みは sync.js) ----------
let syncBusy = false;
let syncTimer = null;
let syncInfoEl = null; // 設定画面の「最後の同期」表示欄
const syncReady = () => syncConfigured() && syncSupported() && !!state;
function scheduleSync() { // 変更の2.5秒後にまとめて送る
  if (!syncReady()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; runSync(); }, 2500);
}
const syncBlocked = () => runtime.locked || !!document.querySelector('.overlay'); // ロック中・入力中は、画面の中身を入れ替えない

// クラウドの内容をこの端末に反映する(設定=PINなどは触らない)
async function applyRemote(r) {
  state.categories = r.data.categories; state.assets = r.data.assets; state.records = r.data.records;
  state.settings.isSample = false;
  ui.excluded = new Set([...ui.excluded].filter((id) => state.assets.some((a) => a.id === id)));
  try { await saveState(state); } catch { toast('⚠ 取り込んだデータを保存できませんでした。空き容量を確認してください', 8000); return false; }
  await markAdopted(r.rev, payloadOf(state));
  render();
  return true;
}

function setSyncInfo(text) { if (syncInfoEl?.isConnected) syncInfoEl.textContent = text; }
const whenText = (t) => (t ? new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ');

async function runSync(manual = false) {
  if (!syncReady() || syncBusy) return;
  syncBusy = true;
  try {
    const r = await syncNow(payloadOf(state));
    if (r.status === 'off') return;
    if (r.status === 'pull' || r.status === 'conflict') {
      if (syncBlocked()) { if (manual) toast('入力中のため、あとで同期します'); return; }
      if (r.status === 'pull') { if (await applyRemote(r)) toast('他の端末の変更を取り込みました', 3500); }
      else await resolveConflict(r);
    } else if (r.status === 'offline') {
      setSyncInfo('オフラインです。つながったら自動で同期します'); if (manual) toast('ネットにつながっていません');
      return;
    } else if (r.status === 'error') {
      setSyncInfo('同期できませんでした: ' + r.message); if (manual) toast('同期できませんでした: ' + r.message, 6000);
      return;
    } else if (manual) toast('同期しました');
    setSyncInfo('最後の同期: ' + whenText(Date.now()));
  } finally { syncBusy = false; }
}

// この端末とクラウドの両方に未共有の変更があるとき、どちらを残すか選んでもらう
async function resolveConflict(r) {
  const pick = await choiceBox(
    'この端末と、ほかの端末(クラウド)の両方に、まだ共有されていない変更があります。どちらの内容を残しますか?(選ばなかったほうの変更は消えます)',
    [{ value: 'cloud', label: 'クラウドの内容にする', kind: 'primary' }, { value: 'local', label: 'この端末の内容にする' }, { value: 'later', label: 'あとで決める' }]);
  if (pick === 'cloud') { safetyExport(); if (await applyRemote(r)) toast('クラウドの内容に置き換えました'); }
  else if (pick === 'local') {
    const res = await forcePush(payloadOf(state));
    toast(res.status === 'pushed' ? 'この端末の内容をクラウドに送りました' : '送れませんでした: ' + (res.message || ''), 5000);
  }
}

// 共有を始める(合言葉を入れる)
async function startSync() {
  if (!syncSupported()) { toast('共有は安全な接続(HTTPS)でのみ使えます', 6000); return; }
  const pass = await askSecret('合言葉を決めてください(8文字以上)。この合言葉でデータを暗号化します。2台目以降の端末でも、同じ合言葉を入れます。忘れると復元できません。家族とは別の合言葉にしてください。', { minLength: 8, okLabel: '次へ' });
  if (pass === null) return;
  toast('準備しています…(数秒かかります)', 4000);
  let res;
  try { res = await syncConnect(pass); } catch (e) { toast('接続できませんでした: ' + e.message, 7000); return; }
  if (res.exists) {
    const n = res.data.assets.length, m = Object.keys(res.data.records).length;
    const take = await confirmBox(`この合言葉の共有データが見つかりました(資産${n}件、${m}か月分)。この端末のデータを、その内容に置き換えます。`, '取り込む');
    if (take) {
      safetyExport();
      if (await applyRemote(res)) toast('取り込みました。この端末も共有中です', 5000);
    } else if (state.assets.length > 0 && await confirmBox('代わりに、この端末のデータでクラウドの内容を上書きしますか?(クラウド側の元のデータは消えます)', '上書きする', true)) {
      const r2 = await forcePush(payloadOf(state));
      toast(r2.status === 'pushed' ? '共有を始めました' : '送れませんでした: ' + (r2.message || ''), 5000);
    } else { await syncDisconnect(false); toast('共有は始めませんでした'); }
  } else {
    // 新しく作る。打ち間違いで別の金庫ができないよう、もう一度入力して確かめる
    const again = await askSecret('確認のため、同じ合言葉をもう一度入れてください。(2台目以降の端末のつもりなら、最初の合言葉が違っています。やめてやり直してください)', { okLabel: '共有を始める' });
    if (again !== pass) { await syncDisconnect(false); toast(again === null ? '共有は始めませんでした' : '合言葉が一致しませんでした。やり直してください', 5000); render(); return; }
    await runSync(true);
  }
  render();
}

// 共有カード(設定画面)
function syncCard() {
  const card = h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '端末どうしで共有'));
  if (!syncConfigured()) { card.append(h('p', { class: 'muted small' }, '準備中です(共有先がまだ設定されていません)。')); return card; }
  if (!syncSupported()) { card.append(h('p', { class: 'muted small' }, '共有は安全な接続(HTTPS)でのみ使えます。')); return card; }
  const body = h('div');
  card.append(body);
  syncStatus().then((st) => {
    if (!st.on) {
      body.append(
        h('p', { class: 'small' }, 'スマホとiPadなど、自分の複数の端末で同じデータを使えます。'),
        h('p', { class: 'muted small' }, '合言葉でデータを暗号化してからクラウドに預けるので、サーバーにも、同じ仕組みを使う家族にも、中身は読めません。家族それぞれが別の合言葉を決めれば、データは混ざりません。共有するのは金額・資産・分類だけで、PINなどの設定は端末ごとのままです。'),
        h('button', { class: 'btn primary', type: 'button', onclick: startSync }, '共有を始める'));
      return;
    }
    syncInfoEl = h('p', { class: 'small' }, '最後の同期: ' + whenText(st.lastSyncAt));
    body.append(
      h('p', { class: 'small' }, '✅ 共有中です。変更すると自動で他の端末にも届きます。'),
      syncInfoEl,
      h('p', { class: 'muted small' }, '新しい端末では、同じ合言葉を入れると取り込めます。合言葉は端末に保存されないので、メモしておいてください。'),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => runSync(true) }, '今すぐ同期'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const pick = await choiceBox('共有をやめます。この端末のデータはそのまま残ります。', [
            { value: 'keep', label: '共有だけやめる(クラウドのデータは残す)', kind: 'primary' },
            { value: 'del', label: 'クラウドのデータも消す', kind: 'danger' },
            { value: 'no', label: 'やめない' }]);
          if (pick === 'no') return;
          try { await syncDisconnect(pick === 'del'); toast(pick === 'del' ? '共有をやめて、クラウドのデータを消しました' : '共有をやめました', 5000); }
          catch (e) { toast('できませんでした: ' + e.message, 6000); return; }
          render();
        } }, '共有をやめる')));
  }).catch(() => body.append(h('p', { class: 'muted small' }, '共有の状態を読み込めませんでした。')));
  return card;
}

// ラベル付きの入力欄
const field = (label, input, help) =>
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, help ? h('span', { class: 'help' }, help) : null);

// ---------- 表示する資産の絞り込み(基本は全部選択。外したものだけ集計から除く) ----------
// 集計・グラフ用に「外した資産を除いたデータ」を返す(保存データは変えない)
const shown = () => ({ ...state, assets: state.assets.filter((a) => !ui.excluded.has(a.id)) });
const isFiltered = () => state.assets.some((a) => ui.excluded.has(a.id));

// 画面上部の「いま何を見ているか」ボタン
function filterBar() {
  if (state.assets.length === 0) return null;
  const on = state.assets.filter((a) => !ui.excluded.has(a.id)).length;
  const filtered = isFiltered();
  return h('div', { class: 'filter-bar' },
    h('button', { class: 'chip' + (filtered ? ' on' : ''), type: 'button', onclick: filterSheet },
      '🔍 ' + (filtered ? `選んだ資産だけ(${on}/${state.assets.length})` : '全ての資産を表示中') + ' ▾'),
    filtered ? h('button', { class: 'link', type: 'button', onclick: () => { ui.excluded.clear(); render(); } }, '全て選び直す') : null);
}

// 絞り込みの選択画面。チェックを触るたびに、後ろの画面がすぐ変わる
function filterSheet() {
  const box = h('div', { class: 'filter-sheet' });
  const draw = () => {
    box.replaceChildren(
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn grow', type: 'button', onclick: () => { ui.excluded.clear(); render(); draw(); } }, '全て選ぶ'),
        h('button', { class: 'btn grow', type: 'button', onclick: () => { state.assets.forEach((a) => ui.excluded.add(a.id)); render(); draw(); } }, '全て外す')),
      ...state.categories.map((c) => {
        const list = state.assets.filter((a) => a.categoryId === c.id);
        if (list.length === 0) return null;
        const allOn = list.every((a) => !ui.excluded.has(a.id));
        const someOn = list.some((a) => !ui.excluded.has(a.id));
        const catBox = h('input', { type: 'checkbox', checked: allOn, 'aria-label': `${c.name}をまとめて切り替え` });
        catBox.indeterminate = someOn && !allOn;
        catBox.addEventListener('change', () => {
          list.forEach((a) => (catBox.checked ? ui.excluded.delete(a.id) : ui.excluded.add(a.id)));
          render(); draw();
        });
        return h('section', { class: 'filter-cat' },
          h('label', { class: 'filter-row head' }, catBox, bubble(c, true), h('span', {}, c.name)),
          ...list.map((a) => {
            const cb = h('input', { type: 'checkbox', checked: !ui.excluded.has(a.id) });
            cb.addEventListener('change', () => { cb.checked ? ui.excluded.delete(a.id) : ui.excluded.add(a.id); render(); draw(); });
            return h('label', { class: 'filter-row' }, cb, h('span', {}, a.name));
          }));
      }).filter(Boolean));
  };
  draw();
  openSheet('見る資産を選ぶ', box);
}

// ---------- 画面: ホーム ----------
function renderHome() {
  const month = latestMonth(state);
  if (!month || state.assets.length === 0) {
    view.append(emptyBox());
    return;
  }
  const fs = shown();
  const total = totalOf(fs, month);
  const diff = diffFromPrev(fs, month);

  view.append(filterBar());

  // 総資産(一番上に大きく)
  const totalCard = h('section', { class: 'card total-card' },
    h('div', { class: 'muted small' }, `${isFiltered() ? '選んだ資産の合計' : '総資産'}(${monthLabel(month)})`),
    h('div', { class: 'total-amount' }, fmt(total)));
  if (diff) {
    const up = diff.amount >= 0;
    totalCard.append(h('div', { class: 'delta ' + (up ? 'up' : 'down') },
      `${diff.prev === addMonths(month, -1) ? '前月' : monthLabel(diff.prev)}比 ${fmtSigned(diff.amount)}`,
      diff.rate != null && !isMasked() ? `(${up ? '+' : '−'}${Math.abs(diff.rate).toFixed(1)}%)` : ''));
  }
  totalCard.append(pigImg('pig-peek'));
  view.append(totalCard);

  // お知らせ(月末の更新のすすめ)
  const due = monthEndDue();
  if (due) {
    view.append(h('div', { class: 'notice warn' }, `${monthLabel(due)}の月末の記録がまだです。`,
      h('button', { class: 'link', type: 'button', onclick: () => updateSheet(due) }, '今すぐ更新する')));
  }

  // お知らせ(バックアップのすすめ)
  if (backupAdvice()) {
    view.append(h('div', { class: 'notice warn' }, backupAdvice(),
      h('button', { class: 'link', type: 'button', onclick: () => { ui.tab = 'settings'; render(); } }, 'バックアップする')));
  }

  // ドーナツ円グラフ + 凡例
  const rows = byCategory(fs, month).filter((r) => r.amount > 0);
  const pcts = percents(rows.map((r) => r.amount));
  const canvas = h('canvas', { 'aria-label': '資産の内訳ドーナツグラフ', role: 'img' });
  const legend = h('ul', { class: 'legend' });
  rows.forEach((r, i) => {
    const opened = ui.open.has(r.category.id);
    legend.append(h('li', {},
      h('button', {
        class: 'legend-row', type: 'button', 'aria-expanded': String(opened),
        onclick: () => { opened ? ui.open.delete(r.category.id) : ui.open.add(r.category.id); render(); },
      },
      bubble(r.category),
      h('span', { class: 'legend-name' }, r.category.name),
      h('span', { class: 'legend-pct' }, isMasked() ? '••%' : pcts[i] === 0 ? '<0.1%' : pcts[i].toFixed(1) + '%'),
      h('span', { class: 'legend-amt' }, fmt(r.amount))),
      opened ? h('ul', { class: 'sub-list' },
        r.assets.filter((a) => valueOf(fs, month, a.id) > 0).map((a) =>
          h('li', {}, h('span', {}, a.name), h('span', {}, fmt(valueOf(fs, month, a.id))))))
        : null));
  });
  view.append(h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '資産の内訳'),
    h('div', { class: 'donut-wrap' }, canvas), legend));
  drawDonut(canvas, fs, month);
}

// データがまだ無いときの表示
function emptyBox() {
  return h('div', { class: 'empty' },
    pigImg('empty-pig'),
    h('p', {}, 'まだ資産がありません'),
    h('p', { class: 'muted small' }, '預金・現金・株式など、持っているものを1つずつ入れていきましょう。入れた金額は、このスマホの中だけに保存されます。'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => assetSheet(null) }, '＋ 最初の資産を入れる'));
}

// 月末の更新のすすめ。月末3日前〜翌月5日の間で、その月の記録がまだなければ、その月("YYYY-MM")を返す
function monthEndDue() {
  const d = new Date();
  const day = d.getDate();
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  let target = null;
  if (day >= lastDay - 2) target = nowMonth();
  else if (day <= 5) target = addMonths(nowMonth(), -1);
  return target && !state.records[target] ? target : null;
}

// バックアップのすすめ(なければ空文字)
function backupAdvice() {
  const last = state.settings.lastBackup;
  if (!last) return 'まだバックアップがありません。ブラウザのデータは消えることがあります。';
  const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  return days >= 30 ? `最後のバックアップから ${days} 日たっています。` : '';
}

// ---------- 画面: 推移 ----------
function renderTrend() {
  const months = monthsOf(state);
  if (months.length === 0) { view.append(emptyBox()); return; }

  const periods = [[6, '6か月'], [12, '1年'], ['all', '全期間']];
  const bar = h('div', { class: 'seg' }, periods.map(([v, label]) =>
    h('button', { type: 'button', class: ui.period === v ? 'on' : '', 'aria-pressed': String(ui.period === v), onclick: () => { ui.period = v; render(); } }, label)));
  const mode = h('div', { class: 'seg small-seg' },
    h('button', { type: 'button', class: !ui.stacked ? 'on' : '', 'aria-pressed': String(!ui.stacked), onclick: () => { ui.stacked = false; render(); } }, '合計'),
    h('button', { type: 'button', class: ui.stacked ? 'on' : '', 'aria-pressed': String(ui.stacked), onclick: () => { ui.stacked = true; render(); } }, '内訳'));

  const fs = shown();
  view.append(filterBar());
  const canvas = h('canvas', { 'aria-label': '資産推移の折れ線グラフ', role: 'img' });
  view.append(h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, bar, mode),
    h('div', { class: 'line-wrap' }, canvas),
    h('p', { class: 'muted small' }, 'グラフを触ると、その月の金額が出ます。')));
  drawLine(canvas, fs, ui.period, ui.stacked);

  // 月ごとの一覧(新しい順)
  const list = h('ul', { class: 'month-list' });
  [...months].reverse().slice(0, 24).forEach((m) => {
    const d = diffFromPrev(fs, m);
    list.append(h('li', {},
      h('span', {}, monthLabel(m)),
      h('span', { class: 'month-amt' }, fmt(totalOf(fs, m))),
      h('span', { class: 'month-diff ' + (d ? (d.amount >= 0 ? 'up' : 'down') : '') }, d ? fmtSigned(d.amount) : '—')));
  });
  view.append(h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '月ごとの総資産'), list));
}

// ---------- 画面: 資産一覧 ----------
function renderAssets() {
  const month = latestMonth(state);
  view.append(h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary grow', type: 'button', onclick: updateSheet }, '📝 今月の更新(前月の値を引き継ぐ)')));

  if (state.assets.length === 0) view.append(emptyBox());
  else if (month) view.append(h('p', { class: 'muted small month-note' }, `${monthLabel(month)}の金額を表示しています`));

  view.append(filterBar());
  byCategory(state, month || nowMonth()).forEach((r) => {
    if (r.assets.length === 0) return;
    const sum = r.assets.filter((a) => !ui.excluded.has(a.id)).reduce((t, a) => t + valueOf(state, month, a.id), 0);
    const ul = h('ul', { class: 'asset-list' }, r.assets.map((a) =>
      h('li', { class: ui.excluded.has(a.id) ? 'off' : '' }, h('button', { class: 'asset-row', type: 'button', onclick: () => assetSheet(a) },
        h('span', { class: 'asset-name' }, a.name),
        h('span', { class: 'asset-amt' }, fmt(valueOf(state, month, a.id)))))));
    view.append(h('section', { class: 'card' },
      h('div', { class: 'cat-head' },
        bubble(r.category),
        h('h2', {}, r.category.name),
        h('span', { class: 'cat-sum' }, fmt(sum))),
      ul));
  });

  view.append(h('button', { class: 'fab', type: 'button', 'aria-label': '資産を追加', onclick: () => assetSheet(null) }, '+'));
}

// 桁違いの警告文を作る(金額を隠しているときは、倍率も伏せる)
function wrongText(prev, v) {
  if (!prev || !looksWrong(prev, v)) return '';
  if (isMasked()) return '⚠ 前月と大きく違います。桁は合っていますか?';
  if (v === 0) return '⚠ 0円になります。よろしいですか?';
  const ratio = v / prev;
  return ratio >= 1
    ? `⚠ 前月の約${ratio.toFixed(ratio >= 10 ? 0 : 1)}倍です。桁は合っていますか?`
    : `⚠ 前月の約${Math.round(1 / ratio)}分の1です。桁は合っていますか?`;
}

// 資産の追加・編集(asset が null なら追加)
function assetSheet(asset) {
  const target = nowMonth();
  const name = h('input', { type: 'text', maxlength: '60', value: asset?.name || '', placeholder: '例: ○○銀行 普通預金', autocomplete: 'off', 'aria-label': '名前' });
  const cat = h('select', { 'aria-label': '分類' }, state.categories.map((c) =>
    h('option', { value: c.id, selected: (asset?.categoryId || state.categories[0].id) === c.id }, c.name)));
  // 編集のときは、いま表示している(最新の)月の金額を初期値にする
  const current = asset ? valueOf(state, state.records[target] ? target : latestMonth(state), asset.id) : null;
  const amount = h('input', { type: 'text', inputmode: 'numeric', value: current === null ? '' : String(current), placeholder: '例: 1,000,000(ない場合は 0)', autocomplete: 'off', 'aria-label': '金額' });
  const err = h('p', { class: 'error', role: 'alert' });
  const warn = h('div', { class: 'warn-text' });
  amount.addEventListener('input', () => {
    const v = parseAmount(amount.value);
    warn.textContent = current && v !== null && !Number.isNaN(v) ? wrongText(current, v) : '';
  });

  const save = async () => {
    const v = parseAmount(amount.value);
    if (!name.value.trim()) { err.textContent = '名前を入れてください'; return; }
    if (v === null) { err.textContent = '金額を入れてください(ない場合は 0)'; return; }
    if (Number.isNaN(v)) { err.textContent = '金額は0以上の数字で入れてください'; return; }
    let a = asset;
    if (!a) { a = { id: uid(), name: '', categoryId: '', memo: '' }; state.assets.push(a); }
    a.name = name.value.trim();
    a.categoryId = cat.value;
    // 金額を変えていない編集(名前や分類だけ)では、今月の記録を新しく作らない
    if (!(asset && v === current && !state.records[target])) {
      ensureMonth(target);
      state.records[target][a.id] = v;
    }
    close();
    await commit();
    toast('保存しました');
  };

  const remove = async () => {
    if (!(await confirmBox(`「${asset.name}」を削除します。過去の記録も消えます。よろしいですか?`, '削除する', true))) return;
    state.assets = state.assets.filter((x) => x.id !== asset.id);
    for (const m of Object.keys(state.records)) delete state.records[m][asset.id];
    close();
    await commit();
    toast('削除しました');
  };

  const body = h('div', { class: 'form' },
    field('名前', name),
    field('分類', cat),
    field(`金額(${monthLabel(target)})`, amount, '「円」や「,」は付けても付けなくてもOK'),
    warn, err,
    h('div', { class: 'row-btns' },
      asset ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, '削除') : null,
      h('button', { class: 'btn primary grow', type: 'button', onclick: save }, '保存')));
  const close = openSheet(asset ? '資産を編集' : '資産を追加', body);
  setTimeout(() => (asset ? amount : name).focus(), 50);
}

// 「今月の更新」: 全部の資産の金額を1画面でまとめて入れる
function updateSheet(initialMonth) {
  if (state.assets.length === 0) { assetSheet(null); return; }
  // 未来の月は選べない(入力ミスで「最新月」がずれるのを防ぐ)
  const monthInput = h('input', { type: 'month', value: typeof initialMonth === 'string' ? initialMonth : nowMonth(), max: nowMonth(), min: '2000-01', 'aria-label': '対象の月' });
  const rowsBox = h('div', { class: 'update-rows' });
  const err = h('p', { class: 'error', role: 'alert' });
  let inputs = []; // [{asset, el}]

  // 選んだ月に合わせて、入力欄を作り直す
  const build = () => {
    const month = monthInput.value || nowMonth();
    const prevM = previousMonth(state, month);
    const prevRec = prevM ? state.records[prevM] : {};
    const baseRec = state.records[month] || prevRec || {}; // その月の記録があればそれ、なければ前月の値
    rowsBox.replaceChildren();
    inputs = [];
    byCategory(state, month).forEach((r) => {
      if (r.assets.length === 0) return;
      rowsBox.append(h('div', { class: 'upd-cat' }, bubble(r.category, true), r.category.name));
      r.assets.forEach((a) => {
        const prev = prevM ? valueOf(state, prevM, a.id) : 0;
        const el = h('input', { type: 'text', inputmode: 'numeric', value: String(Object.hasOwn(baseRec, a.id) ? baseRec[a.id] : 0), autocomplete: 'off', 'aria-label': a.name + 'の金額' });
        const warn = h('div', { class: 'warn-text' });
        el.addEventListener('input', () => {
          const v = parseAmount(el.value);
          warn.textContent = v !== null && !Number.isNaN(v) ? wrongText(prev, v) : '';
        });
        el.addEventListener('focus', () => el.select());
        rowsBox.append(h('div', { class: 'upd-row' },
          h('div', { class: 'upd-name' }, a.name, h('span', { class: 'muted small' }, prevM ? `前月 ${fmt(prev)}` : '')),
          el, warn));
        inputs.push({ asset: a, el });
      });
    });
  };
  monthInput.addEventListener('change', build);
  build();

  const save = async () => {
    const month = monthInput.value;
    if (!/^\d{4}-\d{2}$/.test(month)) { err.textContent = '月を選んでください'; return; }
    if (month > nowMonth()) { err.textContent = '未来の月は記録できません'; return; }
    const rec = {};
    for (const { asset, el } of inputs) {
      const v = parseAmount(el.value);
      if (v === null) { err.textContent = `「${asset.name}」の金額が空です(ない場合は 0 を入れてください)`; el.focus(); return; }
      if (Number.isNaN(v)) { err.textContent = `「${asset.name}」の金額は0以上の数字で入れてください`; el.focus(); return; }
      rec[asset.id] = v;
    }
    state.records[month] = rec;
    close();
    await commit();
    toast(`${monthLabel(month)}の記録を保存しました`);
  };

  const body = h('div', { class: 'form' },
    field('対象の月', monthInput, '前月の金額が入っています。変わったものだけ直してください'),
    rowsBox, err,
    h('button', { class: 'btn primary', type: 'button', onclick: save }, 'この内容で保存'));
  const close = openSheet('今月の更新', body);
}

// ---------- 画面: 設定 ----------
function renderSettings() {
  // 「PINを求めるまでの時間」の欄(PINを設定しているときだけ出る)
  const DELAY_PRESETS = [[0, 'すぐ(アプリを離れるたび)'], [1, '1分'], [5, '5分'], [15, '15分'], [30, '30分'], [60, '1時間'], [180, '3時間'], [720, '12時間'], [1440, '24時間']];
  const fmtMinutes = (m) => (m < 60 ? `${m}分` : m % 1440 === 0 ? `${m / 1440}日` : m % 60 === 0 ? `${m / 60}時間` : `${Math.floor(m / 60)}時間${m % 60}分`);
  function lockDelayBox() {
    const cur = state.settings.lockDelay || 0;
    const isPreset = DELAY_PRESETS.some(([m]) => m === cur);
    const sel = h('select', { 'aria-label': 'PINを求めるまでの時間' },
      DELAY_PRESETS.map(([m, label]) => h('option', { value: String(m), selected: isPreset && m === cur }, label)),
      h('option', { value: 'custom', selected: !isPreset }, '自分で指定…'));
    const num = h('input', { type: 'text', inputmode: 'numeric', maxlength: '5', value: String(cur || 10), 'aria-label': '分数', autocomplete: 'off' });
    const customRow = h('div', { class: 'custom-delay' }, num, h('span', {}, '分'));
    customRow.hidden = isPreset;
    const msg = h('p', { class: 'error', role: 'alert' });
    const warn = h('p', { class: 'warn-text', role: 'status' });
    // 長い時間にするほど、ロックの意味が薄くなることを伝える
    const updateWarn = (m) => {
      warn.textContent = m >= 60
        ? `⚠ ${fmtMinutes(m)}のあいだは、アプリを閉じて開き直しても、PINなしで金額が見えます。長いほどロックの意味が薄くなります。`
        : '';
    };
    updateWarn(cur);

    // 設定を保存する(画面の描き直しはしない)。保存に失敗したら、元の値に戻す
    const save = async (m) => {
      const prev = state.settings.lockDelay || 0;
      if (m === prev) return; // 変わっていなければ何もしない(Enterと入力完了の二重保存を防ぐ)
      state.settings.lockDelay = m;
      try { await saveState(state); } catch {
        state.settings.lockDelay = prev;
        toast('保存できませんでした。元の設定に戻しました', 6000);
        return;
      }
      updateWarn(m);
      markActive(true);
      resetIdle();
      toast(m === 0 ? '離れるたびにPINを求めます' : `最後に使ってから${fmtMinutes(m)}を超えたらPINを求めます`, 3500);
    };
    sel.addEventListener('change', () => {
      if (sel.value === 'custom') { customRow.hidden = false; num.focus(); num.select(); }
      else { customRow.hidden = true; msg.textContent = ''; save(Number(sel.value)); }
    });
    const commitNum = () => {
      const text = num.value.normalize('NFKC').trim();
      const m = Number(text);
      if (!/^\d+$/.test(text) || m < 1 || m > 10080) { msg.textContent = '1〜10080(7日)の整数で入れてください'; return; }
      msg.textContent = '';
      save(m);
    };
    num.addEventListener('change', commitNum);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNum(); } });
    return h('div', { class: 'delay-box' },
      field('PINを求めるまでの時間', sel, '最後に使ってからこの時間を超えると、PINが必要になります。この時間内は、アプリを開き直してもPINは求めません。短いほど安全です。'),
      customRow, msg, warn);
  }

  // 顔・指紋認証の欄(この端末で使えるか調べてから、中身を入れる)
  const bioBox = h('div', { class: 'bio-box' });
  async function fillBioBox(box) {
    if (!state.settings.pinHash) {
      box.append(h('p', { class: 'muted small' }, '顔・指紋認証を使うには、先にPINを設定してください(認証できないときの予備になります)。'));
    } else if (state.settings.bioId) {
      box.append(h('button', { class: 'btn', type: 'button', onclick: async () => {
        state.settings.bioId = null; await commit(); toast('顔・指紋認証をやめました');
      } }, '顔・指紋認証をやめる'));
    } else if (await bioAvailable()) {
      box.append(h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await registerBio(); await commit(); toast('顔・指紋認証を設定しました'); }
        catch { toast('設定できませんでした(キャンセル、または端末に顔・指紋が登録されていません)', 6000); }
      } }, '顔・指紋認証を使う'));
    } else {
      box.append(h('p', { class: 'muted small' }, 'この端末・この接続では顔・指紋認証を使えません(HTTPSで開くことと、端末に顔や指紋が登録されていることが必要です)。'));
    }
  }

  // 金額を隠す
  const hideBox = h('input', { type: 'checkbox', checked: !!state.settings.hidden });
  hideBox.addEventListener('change', async () => { state.settings.hidden = hideBox.checked; runtime.autoMasked = false; applyMask(); await commit(); });
  view.append(h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, 'プライバシー'),
    h('label', { class: 'switch-row' }, h('span', {}, '金額を隠す(電車の中などで)'), hideBox),
    h('p', { class: 'muted small' }, state.settings.pinHash
      ? '金額は、下で決めた時間を超えて離れる(または放置する)と自動で隠れます。'
      : '2分間さわらないと、自動で金額を隠します。アプリを切り替えたときも画面を隠します。'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn', type: 'button', onclick: pinSheet }, state.settings.pinHash ? 'PINを変更・解除' : 'PIN(4〜8桁)を設定')),
    state.settings.pinHash ? lockDelayBox() : null,
    bioBox,
    h('p', { class: 'muted small' }, 'PINや顔・指紋は「のぞき見・いたずら防止」です。強い暗号の保護ではありません。スマホ本体の画面ロックも必ず使ってください。')));
  fillBioBox(bioBox);

  view.append(syncCard());

  // バックアップ
  const last = state.settings.lastBackup;
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input' });
  fileInput.addEventListener('change', () => importBackup(fileInput));
  fileInput.addEventListener('click', () => { runtime.picking = Date.now() + 60000; }); // ファイル選択中は、画面を隠さない・ロックしない
  fileInput.addEventListener('cancel', () => { runtime.picking = 0; });
  view.append(h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, 'バックアップ'),
    h('p', { class: 'small' }, last ? `最後のバックアップ: ${new Date(last).toLocaleDateString('ja-JP')}` : 'まだバックアップしていません'),
    h('p', { class: 'muted small' }, 'データはこの端末の中だけに保存されています。ブラウザの掃除や故障で消えることがあるので、月に1回ほど書き出して、メールやLINEではなく「ファイル」アプリやクラウドの自分だけの場所に置いてください。'),
    h('p', { class: 'muted small' }, '「暗号化して書き出す」は、パスコードを知らない人には読めないファイルを作ります。クラウドに置くときはこちらがおすすめです。パスコードを忘れると、誰にも復元できません。'),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        await downloadBackup(state); state.settings.lastBackup = new Date().toISOString(); await commit(); toast('書き出しました。「ダウンロード」や「ファイル」アプリに保存されたか確認してください', 6000);
      } }, '書き出す'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!canEncrypt()) { toast('暗号化は安全な接続(HTTPS)でのみ使えます', 6000); return; }
        const pass = await askSecret('バックアップのパスコードを決めてください(8文字以上)。忘れると復元できません。', { confirmAgain: true, minLength: 8, okLabel: '暗号化して書き出す' });
        if (pass === null) return;
        try {
          await downloadBackup(state, pass); state.settings.lastBackup = new Date().toISOString(); await commit(); toast('暗号化して書き出しました', 6000);
        } catch { toast('暗号化に失敗しました', 6000); }
      } }, '暗号化して書き出す'),
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, '読み込む'),
      fileInput)));

  // 分類の管理
  const catList = h('ul', { class: 'asset-list' }, state.categories.map((c) =>
    h('li', {}, h('button', { class: 'asset-row', type: 'button', onclick: () => categorySheet(c) },
      h('span', { class: 'asset-name' }, bubble(c, true), c.name),
      h('span', { class: 'muted small' }, state.assets.filter((a) => a.categoryId === c.id).length + '件')))));
  view.append(h('section', { class: 'card' },
    h('h2', { class: 'card-title' }, '分類の管理'), catList,
    h('button', { class: 'btn', type: 'button', onclick: () => categorySheet(null) }, '+ 分類を追加')));

  // データの扱い
  const dataCard = h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'データ'));
  dataCard.append(
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      const lastTxt = state.settings.lastBackup ? new Date(state.settings.lastBackup).toLocaleDateString('ja-JP') : 'なし';
      if (!(await confirmBox(`すべての資産データを削除します。元に戻せません。(最後のバックアップ: ${lastTxt})削除する前に、いまのデータを自動でファイルに書き出します(暗号化されません。不要になったら削除してください)。`, '書き出して削除する', true))) return;
      safetyExport();
      const s = emptyState(); s.settings = { ...state.settings, isSample: false, lastBackup: state.settings.lastBackup }; state = s; await commit(); toast('削除しました');
    } }, 'すべてのデータを削除'),
    h('p', { class: 'muted small' }, 'このアプリは外部のサーバーにデータを送りません。入力した金額は、この端末のブラウザの中にだけ保存されます。'));
  view.append(dataCard);
}

// 上書きや削除の直前に、いまのデータを念のためファイルに書き出す(空のときは不要)
function safetyExport() {
  if (state.assets.length > 0) downloadBackup(state);
}

// バックアップの読み込み
async function importBackup(input) {
  const file = input.files[0];
  input.value = '';
  runtime.picking = 0;
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('ファイルが大きすぎます'); return; }
  try {
    let text = await file.text();
    if (isEncryptedBackup(text)) { // 暗号化されたファイルは、パスコードで開く
      if (!canEncrypt()) throw new Error('暗号化ファイルはHTTPSでのみ開けます');
      const pass = await askSecret('このバックアップのパスコードを入れてください。', { okLabel: '開く' });
      if (pass === null) return;
      text = await decryptText(text, pass);
    }
    const data = parseBackup(text);
    const when = data.exportedAt ? `(書き出した日時: ${new Date(data.exportedAt).toLocaleString('ja-JP')})` : '';
    const ok = await confirmBox(`バックアップを読み込みます。資産${data.assets.length}件、${Object.keys(data.records).length}か月分${when}。いまのデータは置き換わるため、念のため自動でファイルに書き出してから読み込みます(この控えは暗号化されません。不要になったら削除してください)。`, '読み込む');
    if (!ok) return;
    safetyExport();
    state.categories = data.categories; state.assets = data.assets; state.records = data.records;
    state.settings.isSample = false;
    await commit();
    toast('読み込みました');
  } catch (e) {
    toast('読み込めませんでした: ' + e.message, 6000);
  }
}

// 分類の追加・編集
function categorySheet(cat) {
  const name = h('input', { type: 'text', maxlength: '30', value: cat?.name || '', placeholder: '例: 債券', autocomplete: 'off' });
  let color = cat?.color || PALETTE[state.categories.length % PALETTE.length];
  const swatches = h('div', { class: 'swatches' });
  const drawSw = () => {
    swatches.replaceChildren(...PALETTE.map((c) => h('button', {
      type: 'button', class: 'swatch' + (c === color ? ' on' : ''), 'aria-label': COLOR_NAMES[PALETTE.indexOf(c)] || '色', 'aria-pressed': String(c === color), css: { background: c },
      onclick: () => { color = c; drawSw(); },
    })));
  };
  drawSw();
  const err = h('p', { class: 'error', role: 'alert' });
  const save = async () => {
    if (!name.value.trim()) { err.textContent = '名前を入れてください'; return; }
    if (cat) { cat.name = name.value.trim(); cat.color = color; }
    else state.categories.push({ id: uid(), name: name.value.trim(), color });
    close(); await commit();
  };
  const remove = async () => {
    if (state.assets.some((a) => a.categoryId === cat.id)) { err.textContent = 'この分類に資産が残っています。先に資産を移すか削除してください'; return; }
    if (state.categories.length <= 1) { err.textContent = '分類は最低1つ必要です'; return; }
    if (!(await confirmBox(`分類「${cat.name}」を削除します。`, '削除する', true))) return;
    state.categories = state.categories.filter((c) => c.id !== cat.id);
    close(); await commit();
  };
  const close = openSheet(cat ? '分類を編集' : '分類を追加', h('div', { class: 'form' },
    field('名前', name), field('色', swatches), err,
    h('div', { class: 'row-btns' },
      cat ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, '削除') : null,
      h('button', { class: 'btn primary grow', type: 'button', onclick: save }, '保存'))));
}

// ---------- 顔・指紋認証(端末に入っている標準の仕組み WebAuthn を使う) ----------
// 顔や指紋のデータそのものは、アプリにも外部にも渡らない(端末の中で照合され、「本人でした」という結果だけが返る)。
// ※PINと同じ「のぞき見・いたずら防止」の位置づけ。認証できないときの予備として、PINの設定を必須にしている。
const bioSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.crypto?.subtle && window.isSecureContext);
const toB64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// この端末で顔・指紋(など端末の本人確認)が使えるか
async function bioAvailable() {
  try { return bioSupported() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}

// 顔・指紋を登録する(端末の本人確認の画面が出る)。成功すると true
async function registerBio() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: '資産管理' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'shisan-user', displayName: '利用者' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    attestation: 'none',
    timeout: 60000,
  } });
  state.settings.bioId = toB64u(new Uint8Array(cred.rawId));
  return true;
}

// 顔・指紋で本人確認する。成功すると true、失敗やキャンセルは例外
async function verifyBio(signal) {
  await navigator.credentials.get({ signal, publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: fromB64u(state.settings.bioId), transports: ['internal'] }],
    userVerification: 'required',
    timeout: 60000,
  } });
  return true;
}

// ---------- PIN(暗証番号) ----------
// PINは「ソルト(ランダムな文字列)+PBKDF2(わざと時間のかかる変換)」でハッシュにして保存する。
// ※のぞき見・いたずら防止用。端末内のデータ自体は暗号化していない。
const PBKDF2_ROUNDS = 200000;
async function hashPin(salt, pin) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ROUNDS }, key, 256);
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const pinOk = () => !!(window.crypto && crypto.subtle); // HTTPS(またはlocalhost)でだけ使える
const checkPin = async (pin) => (await hashPin(state.settings.pinSalt, pin)) === state.settings.pinHash;

function pinSheet() {
  if (!pinOk()) { toast('PINは安全な接続(HTTPS)でのみ使えます'); return; }
  const has = !!state.settings.pinHash;
  const mk = (ph) => h('input', { type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', placeholder: ph });
  const cur = mk('いまのPIN');
  const p1 = mk('4〜8桁の数字');
  const p2 = mk('もう一度');
  const err = h('p', { class: 'error', role: 'alert' });
  // 変更・解除には、いまのPINが必要(他の人に勝手に変えられないように)
  const verifyCurrent = async () => {
    if (!has) return true;
    if (await checkPin(cur.value)) return true;
    err.textContent = 'いまのPINが違います';
    return false;
  };
  const close = openSheet('PINの設定', h('div', { class: 'form' },
    has ? field('いまのPIN', cur) : null, field('新しいPIN', p1), field('確認', p2), err,
    h('div', { class: 'row-btns' },
      has ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await verifyCurrent())) return;
        state.settings.pinHash = null; state.settings.pinSalt = null; state.settings.bioId = null; close(); await commit(); toast('PINを解除しました');
      } }, 'PINを解除') : null,
      h('button', { class: 'btn primary grow', type: 'button', onclick: async () => {
        if (!(await verifyCurrent())) return;
        if (!/^\d{4,8}$/.test(p1.value)) { err.textContent = '4〜8桁の数字にしてください'; return; }
        if (p1.value !== p2.value) { err.textContent = '2回の入力が違います'; return; }
        const salt = randomHex(16);
        state.settings.pinSalt = salt; state.settings.pinHash = await hashPin(salt, p1.value);
        markActive(true);
        close(); await commit(); toast('PINを設定しました');
      } }, '設定する'))));
}

// ロック中は、画面本体・メニュー・上のバーを操作できなくする
function setInert(on) {
  view.inert = on; tabbar.inert = on;
  document.querySelector('.app-header').inert = on;
}

// PINの失敗回数と「次に試せる時刻」を覚えておく(ページを再読み込みしても回数が戻らないように)
const GUARD_KEY = 'shisan-pin-guard';
const readGuard = () => { try { return JSON.parse(localStorage.getItem(GUARD_KEY)) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } };
const writeGuard = (g) => { try { localStorage.setItem(GUARD_KEY, JSON.stringify(g)); } catch { /* 何もしない */ } };

// 画面ロック(PINがあるとき)。ロック中は後ろの画面を操作できないようにする(inert)
function lock() {
  if (!state?.settings.pinHash || runtime.locked) return;
  if (!pinOk()) { toast('このURL(HTTP)ではPINロックが使えません。HTTPSで開いてください', 6000); return; }
  runtime.locked = true;
  try { localStorage.setItem(LOCKED_KEY, '1'); } catch { /* 何もしない */ } // アプリが終了しても、ロックを覚えておく
  document.querySelectorAll('.overlay').forEach((o) => o.remove()); // 金額入りの入力画面が残らないように
  document.body.classList.remove('noscroll');
  setInert(true);
  const input = h('input', { type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'PIN' });
  const err = h('p', { class: 'error', role: 'alert' });
  const openBtn = h('button', { class: 'btn primary', type: 'button', onclick: tryUnlock }, '開く');
  const bioBtn = state.settings.bioId && bioSupported()
    ? h('button', { class: 'btn', type: 'button', onclick: () => tryBio(true) }, '顔・指紋で開く') : null;
  const overlay = h('div', { class: 'lock' }, h('div', { class: 'lock-box' },
    pigImg('lock-pig'), h('p', {}, bioBtn ? '顔・指紋、またはPINで開きます' : 'PINを入れてください'), input, err, openBtn, bioBtn));

  // ロックを解除する(PINでも顔・指紋でも共通)
  function finish() {
    writeGuard({ n: 0, until: 0 });
    try { localStorage.removeItem(LOCKED_KEY); } catch { /* 何もしない */ }
    markActive(true);
    runtime.locked = false; runtime.bioPrompt = null; setInert(false); overlay.remove(); clearInterval(timer);
    setTimeout(() => runSync(), 500); // ロック中に保留した共有を進める
  }
  // 顔・指紋で開く。manual=true は、ボタンを押したとき(失敗したら理由を表示する)
  // 確認中にボタンを押したときは、前の確認を中断して、新しくやり直す
  let bioCtl = null;
  async function tryBio(manual) {
    if (!bioBtn) return;
    if (bioCtl) { if (!manual) return; bioCtl.abort(); }
    const ctl = new AbortController();
    bioCtl = ctl;
    try { await verifyBio(ctl.signal); finish(); }
    catch { if (manual && bioCtl === ctl) err.textContent = '顔・指紋で認証できませんでした。PINでも開けます'; }
    finally { if (bioCtl === ctl) bioCtl = null; }
  }
  runtime.bioPrompt = () => tryBio(false); // 画面に戻ってきたときに、もう一度自動で出す

  // 待ち時間中は「開く」を押せなくして、残り秒数を表示する
  let timer;
  function startWait() {
    clearInterval(timer);
    const tick = () => {
      const left = Math.ceil((readGuard().until - Date.now()) / 1000);
      if (left > 0) { openBtn.disabled = true; err.textContent = `PINが違います。${left}秒待ってください`; }
      else { clearInterval(timer); openBtn.disabled = false; if (err.textContent.includes('待って')) err.textContent = ''; }
    };
    tick();
    if (openBtn.disabled) timer = setInterval(tick, 500);
  }

  let busy = false; // 確認中は、次の入力を受け付けない(連打で同時に試されないように)
  async function tryUnlock() {
    if (openBtn.disabled || busy) return;
    busy = true;
    try { await attempt(); } finally { busy = false; }
  }
  async function attempt() {
    if (await checkPin(input.value)) {
      finish();
      return;
    }
    const g = readGuard();
    g.n += 1;
    input.value = '';
    err.textContent = 'PINが違います';
    if (g.n >= 3) g.until = Date.now() + Math.min(60, 2 ** (g.n - 2)) * 1000; // 3回目以降は待ち時間(最大60秒)
    writeGuard(g);
    startWait();
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.body.append(overlay);
  startWait();
  if (bioBtn && !document.hidden) setTimeout(() => tryBio(false), 300); // 開いた直後に、自動で顔・指紋を試す
  else input.focus();
}

// ---------- スクロールでふわっと浮き上がる動き(Fade-in Up) ----------
// 画面に入った部品に、順番に .in を付ける(CSS側で下から浮き上がる動きになる)。
// ・タブを切り替えたときだけ動かす(金額を直したあとの描き直しでは、動かさない)
// ・端末が「動きを減らす」設定のときや、機能が無い古いブラウザでは、動かさず最初から表示する
let revealObserver = null;
function setupReveal(animate) {
  revealObserver?.disconnect();
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!animate || reduce || !('IntersectionObserver' in window)) return;
  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
  [...view.children].filter((el) => !el.classList.contains('fab')).forEach((el, i) => {
    el.classList.add('reveal');
    el.style.setProperty('--d', Math.min(i, 4) * 80 + 'ms'); // 上から順に、少しずつ遅らせる
    revealObserver.observe(el);
  });
  // 念のための保険: 何かの理由で検知されなかった要素が、透明のまま残らないようにする
  setTimeout(() => view.querySelectorAll('.reveal:not(.in)').forEach((el) => el.classList.add('in')), 3000);
}

// ---------- 画面全体の描き直し ----------
function render(animate = false) {
  destroyCharts();
  applyMask();
  view.replaceChildren();
  titleEl.textContent = TABS.find((t) => t.id === ui.tab).label;
  tabbar.replaceChildren(...TABS.map((t) => h('button', {
    type: 'button', class: 'tab' + (ui.tab === t.id ? ' on' : ''), 'aria-current': ui.tab === t.id ? 'page' : null,
    onclick: () => { ui.tab = t.id; render(true); window.scrollTo(0, 0); },
  }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon), h('span', {}, t.label))));
  ({ home: renderHome, trend: renderTrend, assets: renderAssets, settings: renderSettings })[ui.tab]();
  setupReveal(animate);
}

// ---------- 自動で隠す・ロックする ----------
// 「PINを求めるまでの時間」(設定 lockDelay、単位は分)の考え方:
//   ・0(すぐ)      : アプリを離れた瞬間に隠してロックする。放置は2分で隠してロックする
//   ・1以上(分)    : 「最後に使ってから」の時間が、その分数を超えたときだけ隠してロックする
//   ・PINが無い    : 時間設定は使わない(離れたら隠す・2分放置で隠す)
// 「最後に使った時刻」を端末に覚えておくので、iPhoneがアプリを一度閉じても、時間内ならPINなしで開ける。
// ★安全のため: ・ロック中は時刻を更新しない(離れても猶予は延びない)
//             ・ロックした事実も端末に残す(アプリが終了しても、開き直したときにロックされる)
//             ・時計を戻された・記録が無い/壊れているときは、ロックする
const ACTIVE_KEY = 'shisan-last-active';
const LOCKED_KEY = 'shisan-locked';
const lockMs = () => (state?.settings.lockDelay || 0) * 60000; // 0 なら「すぐ」
const readActive = () => { try { return Number(localStorage.getItem(ACTIVE_KEY)) || 0; } catch { return 0; } };
const wasLocked = () => { try { return localStorage.getItem(LOCKED_KEY) === '1'; } catch { return true; } };
let lastActiveAt = 0; // メモリ上の「最後に使った時刻」
let lastWrite = 0;
function markActive(force = false) { // 「いま使っている」と記録する(端末への書き込みは5秒に1回まで)
  const now = Date.now();
  lastActiveAt = now;
  if (!force && now - lastWrite < 5000) return;
  lastWrite = now;
  try { localStorage.setItem(ACTIVE_KEY, String(now)); } catch { /* 記録できなければ、次回は必ずロックする */ }
}
// 最後に使ってから、設定した時間を超えたか。記録が無い・時計が戻っているときも「超えた」(安全側)
const awayTooLong = (since) => {
  if (lockMs() === 0 || !since) return true;
  const d = Date.now() - since;
  return d < -5000 || d >= lockMs();
};
const usesDelay = () => !!state?.settings.pinHash && lockMs() > 0;

function maskNow() { // 金額を隠す(👁を押すまで隠れたまま)
  if (state && !state.settings.hidden && !runtime.autoMasked) { runtime.autoMasked = true; render(); }
}

const cover = document.getElementById('cover');
document.addEventListener('visibilitychange', () => {
  if (EMBEDDED) return;
  if (document.hidden) {
    if (runtime.picking > Date.now()) return; // ファイルを選んでいる間(最大60秒)は、離れた瞬間の処理だけ見送る
    cover.hidden = false; // アプリ切り替え画面に金額が写らないよう、幕で隠す
    if (!usesDelay()) { maskNow(); lock(); } // 時間設定が無いときは、離れた瞬間に隠す・ロックする
  } else {
    cover.hidden = true;
    if (usesDelay() && !runtime.locked) {
      // 戻ってきたとき: 最後に使ってから設定の時間を超えていればロック。超えていなければ、そのまま続ける
      if (awayTooLong(lastActiveAt)) { maskNow(); lock(); } else markActive(true);
    }
    if (runtime.locked) runtime.bioPrompt?.(); // ロック中に画面へ戻ったら、顔・指紋をもう一度出す
  }
});

// 放置したとき: PINと時間設定があればその時間、なければ2分で隠す(ロックはPINがあるときだけ)
let idleTimer;
const idleLimit = () => (usesDelay() ? lockMs() : 120000);
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    maskNow();
    // 開いている入力画面(金額が見えている)も閉じる
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    document.body.classList.remove('noscroll');
    lock();
  }, idleLimit());
}
function onActivity() { resetIdle(); if (!runtime.locked) markActive(); }
['pointerdown', 'keydown', 'scroll'].forEach((ev) => addEventListener(ev, onActivity, { passive: true }));

eyeBtn.addEventListener('click', async () => {
  if (isMasked()) { state.settings.hidden = false; runtime.autoMasked = false; }
  else state.settings.hidden = true;
  await commit();
});

// ---------- 起動 ----------
// 読み込んだデータの形をチェックして、足りない設定は補う。おかしければ Error
function validateLoaded(s) {
  if (!s || s.version !== 1 || typeof s !== 'object') throw new Error('保存データの版が違うか、壊れています');
  const base = emptyState().settings;
  const checked = parseBackup(JSON.stringify({ app: 'shisan-app', version: 1, categories: s.categories, assets: s.assets, records: s.records }));
  const raw = s.settings && typeof s.settings === 'object' ? s.settings : {};
  const hex = (v, min, max) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${min},${max}}$`).test(v);
  const pinValid = hex(raw.pinHash, 64, 64) && hex(raw.pinSalt, 16, 80); // PINは「ハッシュとソルトが両方正しい」ときだけ有効
  const settings = {
    ...base,
    hidden: raw.hidden === true,
    isSample: raw.isSample === true,
    lastBackup: typeof raw.lastBackup === 'string' && !Number.isNaN(Date.parse(raw.lastBackup)) ? raw.lastBackup : null,
    lockDelay: Number.isInteger(raw.lockDelay) && raw.lockDelay >= 0 && raw.lockDelay <= 10080 ? raw.lockDelay : 0,
    pinHash: pinValid ? raw.pinHash : null,
    pinSalt: pinValid ? raw.pinSalt : null,
    bioId: pinValid && typeof raw.bioId === 'string' && /^[A-Za-z0-9_-]{16,1024}$/.test(raw.bioId) ? raw.bioId : null,
  };
  return { version: 1, categories: checked.categories, assets: checked.assets, records: checked.records, settings };
}

const COLOR_NAMES = ['青', '黄色', 'ピンク', 'ミント', '紫', 'オレンジ', 'グレー', '緑']; // PALETTE と同じ順番

// 昔のデフォルト色のままの分類だけ、新しいポップな色に切り替える(自分で色を変えた分類は触らない)
// ※ OLD_COLORS[0..6] は、分類 c1〜c7 の昔の色。新しい色は PALETTE[0..6](js/defaults.js)が同じ順番で対応する
const OLD_COLORS = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#65a30d', '#64748b'];
function migrateColors(s) {
  let changed = false;
  for (const c of s.categories) {
    const m = /^c([1-7])$/.exec(c.id);
    if (m && c.color === OLD_COLORS[Number(m[1]) - 1]) { c.color = PALETTE[Number(m[1]) - 1]; changed = true; }
  }
  return changed;
}

// 昔入れていたテスト用サンプルだけを消す(あなたが入れた資産は残す)。
// サンプルの資産は ID が a1〜a10 で、いまの入力で作る ID(長い英数字)とは区別できる
const OLD_SAMPLE_NAMES = {
  a1: 'サンプル銀行 普通預金', a2: 'サンプル銀行 定期預金', a3: '財布・手元の現金', a4: '国内株(サンプル)', a5: '米国株(サンプル)',
  a6: '全世界株式ファンド', a7: '積立NISA(サンプル)', a8: 'ビットコイン(サンプル)', a9: 'ポイント(サンプル)', a10: '保険の解約返戻金(サンプル)',
};
function removeSampleData(s) {
  // IDも名前も旧サンプルのままの資産だけを消す。名前を書き換えて使っている資産は、実データとして残す
  const isSample = (a) => Object.hasOwn(OLD_SAMPLE_NAMES, a.id) && OLD_SAMPLE_NAMES[a.id] === a.name;
  const gone = new Set(s.assets.filter(isSample).map((a) => a.id));
  s.assets = s.assets.filter((a) => !gone.has(a.id));
  for (const m of Object.keys(s.records)) {
    const hadValues = Object.keys(s.records[m]).length > 0;
    for (const id of gone) delete s.records[m][id];
    if (hadValues && Object.keys(s.records[m]).length === 0) delete s.records[m]; // 消した結果、空になった月だけ消す
  }
  s.settings.isSample = false;
}

// 起動に失敗したときの画面(データには触らない)
function showFatal(message) {
  view.replaceChildren(h('div', { class: 'card' },
    h('h2', { class: 'card-title' }, '⚠ 保存データを読み込めませんでした'),
    h('p', {}, message),
    h('p', { class: 'muted small' }, '保存されているデータは消していません。ページを再読み込みしてもだめな場合は、バックアップファイルがあれば、別のブラウザで開いて「読み込む」をお試しください。'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, '再読み込み')));
}

async function boot() {
  if (EMBEDDED) return;
  let migrateFailed = false;
  try {
    await initStorage();
    const saved = await loadState();
    if (saved === null) { state = emptyState(); await saveState(state); } // 初回は空の状態から始める
    else {
      state = validateLoaded(saved);
      let changed = false;
      if (state.settings.isSample) { removeSampleData(state); changed = true; } // 昔のテスト用データを自動で消す
      if (migrateColors(state)) changed = true;
      if (changed) { try { await saveState(state); } catch { migrateFailed = true; } } // 失敗しても、メモリ上のデータで使い続ける
    }
  } catch (e) {
    showFatal('原因: ' + (e?.message || e));
    return; // ★ここで止まる。何も保存・上書きしない
  }
  lastActiveAt = readActive();
  // ロックが残っている、または最後に使ってから設定の時間を超えているときだけロックする(先にロックしてから描画する)
  if (wasLocked() || awayTooLong(lastActiveAt)) lock();
  else markActive(true);
  render(true);
  if (migrateFailed) toast('データの整理を保存できませんでした。端末の空き容量を確認してください', 6000);
  resetIdle();
  requestPersist();
  runSync();
  document.addEventListener('visibilitychange', () => {
    if (!syncReady()) return;
    if (!document.hidden) runSync();
    else if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; runSync(); } // 離れる前に送りきる
  });
  addEventListener('online', () => runSync());
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('service-worker.js').catch(() => { /* 失敗しても通常どおり動く */ });
  }
}
boot();
