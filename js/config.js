// ===== 端末どうしで共有する機能の接続先(Supabase) =====
// URL と「公開用キー(publishable / anon)」を入れる。これらは公開されても安全な値(秘密のキーは絶対に入れない)。
// 空のままなら、共有機能は「準備中」と表示されて使えない。
// ★ここの URL を変えたら、index.html の CSP(connect-src)も同じ URL にそろえること。
export const SYNC_URL = 'https://igmwdbeyboolxfzlqczq.supabase.co';
export const SYNC_KEY = 'sb_publishable_CAGDMrzQNJbw_dDk2TqjmA_rYBaM9hf';
