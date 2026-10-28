// オフラインでも起動できるようにするサービスワーカー
// 方針：ネットにつながる時は常に最新を取得（ネットワーク優先）し、取得したものをキャッシュ。オフライン時はキャッシュを使う。
const CACHE = 'lyrics-subtitle-editor-v1';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/cues.js', 'js/db.js', 'js/demux.js', 'js/exporter.js', 'js/fonts.js', 'js/subtitle.js', 'js/timeline.js', 'js/util.js',
  'vendor/mp4box.all.min.js', 'vendor/mp4-muxer.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range') || url.pathname.includes('/tools/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
