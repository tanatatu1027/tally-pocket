// ===== Service Worker(オフラインでも動かすための裏方) =====
// 基本の動き: まずネットから最新を取りにいき、取れなければ保存しておいた古いコピーを使う。
// こうすると、ファイルを直しても古い画面が出続ける事故が起きにくい。
// (VERSION を上げ忘れても動くが、ファイルを増減したときは上げておくと古いコピーが片づく)
const VERSION = 'v10';
const CACHE = 'shisan-' + VERSION;
const FILES = [
  './', 'index.html', 'manifest.json', 'css/style.css',
  'js/app.js', 'js/util.js', 'js/storage.js', 'js/calc.js', 'js/charts.js', 'js/backup.js', 'js/defaults.js',
  'lib/chart.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/pig.png',
];

// インストール時に必要なファイルを保存しておく
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

// 古い版の保存コピーを消す
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 通信の仲介(自分のサイトのファイルだけ扱う)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: ブラウザの一時保存を使わず、必ず最新かどうかサーバーに確認する
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { // 成功したものだけ保存する(404などは保存しない)
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        // ページ本体(画面の移動)のときだけ index.html を返す
        return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error();
      }),
  );
});
