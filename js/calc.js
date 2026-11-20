// ===== 計算(合計・割合・前月比など)。画面とは無関係の純粋な計算だけ =====

// 記録がある月を古い順に並べて返す
export function monthsOf(state) {
  return Object.keys(state.records).sort();
}

// 最新の月(なければ null)
export function latestMonth(state) {
  const ms = monthsOf(state);
  return ms.length ? ms[ms.length - 1] : null;
}

// ある月のある資産の金額(記録がなければ 0)
export function valueOf(state, month, assetId) {
  const rec = state.records[month];
  // 自分自身のキーで、数値のものだけを採用する(壊れたデータで表示が崩れないように)
  if (!rec || !Object.hasOwn(rec, assetId) || typeof rec[assetId] !== 'number') return 0;
  return rec[assetId];
}

// ある月の総資産
export function totalOf(state, month) {
  // 存在する資産だけを足す
  return state.assets.reduce((sum, a) => sum + valueOf(state, month, a.id), 0);
}

// ある月の「分類ごとの金額」。金額が0の分類も含めて返す
export function byCategory(state, month) {
  return state.categories.map((c) => {
    const assets = state.assets.filter((a) => a.categoryId === c.id);
    const amount = assets.reduce((s, a) => s + valueOf(state, month, a.id), 0);
    return { category: c, amount, assets };
  });
}

// 割合(%)を小数1桁で出す。「最大剰余法」を使い、合計がぴったり100.0%になるようにする。
// 例: 3等分 → 33.4 / 33.3 / 33.3(合計100.0)
export function percents(amounts) {
  const total = amounts.reduce((s, a) => s + a, 0);
  if (total <= 0) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a / total) * 1000); // 0.1%単位で考える
  const base = raw.map(Math.floor);
  let rest = 1000 - base.reduce((s, a) => s + a, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rest; k++) base[order[k].i] += 1;
  return base.map((v) => v / 10);
}

// ひとつ前の月(記録がある月のうち)
export function previousMonth(state, month) {
  const ms = monthsOf(state).filter((m) => m < month);
  return ms.length ? ms[ms.length - 1] : null;
}

// 前月に比べた増減。前月がなければ null
export function diffFromPrev(state, month) {
  const prev = previousMonth(state, month);
  if (!prev) return null;
  const now = totalOf(state, month);
  const before = totalOf(state, prev);
  return { prev, amount: now - before, rate: before > 0 ? ((now - before) / before) * 100 : null };
}

// 入力ミス(桁違い)の疑いがあるか。前月の5倍以上、5分の1以下、または0円
export function looksWrong(prev, now) {
  if (!prev) return false;
  if (!now) return true; // 0円になる場合も確認する
  const r = now / prev;
  return r >= 5 || r <= 0.2;
}
