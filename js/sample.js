// ===== 初期データ(分類)とサンプルデータ =====
import { nowMonth, addMonths } from './util.js';

// 色は少なめ・落ち着いたものにする
export const PALETTE = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#65a30d', '#64748b', '#0891b2'];

// 最初から用意する分類
export function defaultCategories() {
  const names = ['預金', '現金', '株式', '投資信託', '暗号資産', 'ポイント', 'その他'];
  return names.map((name, i) => ({ id: 'c' + (i + 1), name, color: PALETTE[i] }));
}

// 空のデータ(分類だけ入っている)
export function emptyState() {
  return {
    version: 1,
    categories: defaultCategories(),
    assets: [],
    records: {},
    settings: { hidden: false, pinHash: null, pinSalt: null, bioId: null, lastBackup: null, isSample: false },
  };
}

// サンプルデータ(すぐ画面を確認できるように、直近12か月ぶん)
export function sampleState() {
  const s = emptyState();
  s.settings.isSample = true;
  // [id, 名前, 分類id, 今月の金額, 毎月の増え方(%), ゆれ幅(%)]
  const list = [
    ['a1', 'サンプル銀行 普通預金', 'c1', 1850000, 1.2, 1.5],
    ['a2', 'サンプル銀行 定期預金', 'c1', 1000000, 0, 0],
    ['a3', '財布・手元の現金', 'c2', 45000, 0, 20],
    ['a4', '国内株(サンプル)', 'c3', 980000, 1.5, 6],
    ['a5', '米国株(サンプル)', 'c3', 1420000, 2.5, 7],
    ['a6', '全世界株式ファンド', 'c4', 2100000, 2.2, 4],
    ['a7', '積立NISA(サンプル)', 'c4', 1350000, 3.0, 3],
    ['a8', 'ビットコイン(サンプル)', 'c5', 320000, 2, 14],
    ['a9', 'ポイント(サンプル)', 'c6', 28000, 1, 8],
    ['a10', '保険の解約返戻金(サンプル)', 'c7', 600000, 0.3, 0],
  ];
  const now = nowMonth();
  for (let i = 0; i < 12; i++) {
    const month = addMonths(now, i - 11);
    const rec = {};
    list.forEach(([id, , , current, growth, wave], idx) => {
      // 現在から過去へさかのぼって金額を作る(毎回同じ結果になる決まった式)
      const back = 11 - i;
      const trend = current / Math.pow(1 + growth / 100, back);
      const noise = 1 + (Math.sin((i + 1) * (idx + 2) * 1.7) * wave) / 100;
      rec[id] = back === 0 ? current : Math.round((trend * noise) / 100) * 100;
    });
    s.records[month] = rec;
  }
  s.assets = list.map(([id, name, categoryId]) => ({ id, name, categoryId, memo: '' }));
  return s;
}
