// ===== 初期データ(分類の色と名前)。サンプルデータは入れず、空の状態から始める =====

// ポップで見分けやすい色(分類の色に使う)
export const PALETTE = ['#4D96FF', '#FFB703', '#FF6B8B', '#2EC4B6', '#9B5DE5', '#FF8A3D', '#8D99AE', '#6BCB3A'];

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
    // isSample は昔のサンプルデータを自動で消すための印(いまは使わない)
    settings: { hidden: false, pinHash: null, pinSalt: null, bioId: null, lastBackup: null, isSample: false },
  };
}
