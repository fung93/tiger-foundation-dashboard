/* Tiger Foundation Dashboard — service worker
   Strategy:
   - App shell (index.html, icons, manifest, Chart.js CDN): cache-first, precached on install
   - Data (/data.json, /history.json): network-first, fall back to cache when offline
   - Other GET requests (price/reward APIs): network-first with cache fallback
   - POST (RPC calls): passed through untouched
   Bump CACHE_VERSION whenever the shell changes. */
/* Bumped for: Robinhood Chain tracking, its LP valuation and P&L ledger, the dated cold
   vault, and the in-range fix. Six shell releases went out on v17 without a bump, so
   returning visitors kept being served the shell from before any of it — which looks
   exactly like the feature never shipped. Bump this on EVERY shell change. */
/* v19: Arc chain (wallet, Uniswap V3 + V4 positions, ledger, Merkl), every chain in the
   history series, a badge colour per chain. */
/* v20: LP fee claims in the claim record, on every chain; Katana LP results count only
   what was paid to this wallet. */
/* v21: the claim record lists LP fees only, split by chain. */
/* v22: Robinhood and Arc positions opened since the last snapshot appear in the record. */
/* v23: Arc requests queued and paced, live fee claims start at load and cover new positions. */
/* v24: Robinhood open positions carry what they have paid out, as Arc's do. */
/* v25: a Robinhood or Arc position emptied since the last snapshot is concluded on the page. */
/* v26: a closed row shows how much of its close value was fees. */
/* v27: liquidity added to an open position is marked as capital topped up. */
/* v28: the position record shows one P&L figure, not a Katana-framed breakdown. */
/* v29: Katana and Robinhood positions count fees earned since their last touch, as Arc does. */
/* v30: the power-of-compounding card — measured daily rate, days to double, doubling bars. */
/* v31: the Arc V4 catch-up scan walks the whole gap in one pass, not one window per refresh. */
/* v32: the browser remembers the Arc V4 positions it has found, so a reload shows them at once. */
var CACHE_VERSION = 'tiger-v101';  /* Preserve complete Katana LP values and report refresh failures */
var SHELL_CACHE = CACHE_VERSION + '-shell';
var DATA_CACHE = CACHE_VERSION + '-data';

var SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  /* the LP range widget, installable in its own right — precached so the icon opens to
     the card and its last reading rather than to a browser error when offline */
  '/widget.html',
  '/widget.webmanifest',
  '/lp.html',
  /* the live position card, shared by the LP Book and the widget */
  '/lpcards.css',
  '/lpcards.js',
  /* the LP Book's two pages and what they share */
  '/lp-all.html',
  '/lpbook.css',
  '/lpbook.js',
  /* Katana Morpho positions, personal limits and historical charts */
  '/lending.html',
  '/lending.css',
  '/lending.js',
  '/morpho-core.mjs',
  '/icons/lp-192.png',
  '/icons/lp-512.png',
  '/icons/lp-maskable-512.png',
  '/icons/icon-192.png',
  '/icons/favicon-32.png',
  '/icons/tiger.svg',
  '/icons/apple-touch-icon.png',
  '/img/bg.jpg',
  '/img/bg-mobile.jpg',
  '/img/hero-art.jpg',
  '/img/hero-art-mobile.jpg',
  '/img/rocket.png',
  '/img/katana.png',
  '/img/space.jpg',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(CACHE_VERSION) !== 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; /* RPC POSTs go straight to network */

  var url = new URL(req.url);

  /* Navigations → serve cached shell, refresh in background.
     Only the dashboard belongs under /index.html. This used to copy whatever document was
     navigated to over the cached shell, so one visit to /widget.html left an offline
     visitor looking at the widget where the dashboard should be. */
  if (req.mode === 'navigate') {
    var isShell = url.origin === self.location.origin &&
      (url.pathname === '/' || url.pathname === '/index.html');
    e.respondWith(
      fetch(req).then(function (res) {
        if (isShell && res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put('/index.html', copy); });
        }
        return res;
      }).catch(function () {
        /* ignoreSearch, because the installed widget launches at /widget.html?all=1 while
           the precached copy is /widget.html. A cache lookup matches the query string by
           default, so without this the LP icon opened the dashboard when offline — the one
           moment the cache is there for. */
        return caches.match(isShell ? '/index.html' : req, { ignoreSearch: true })
          .then(function (hit) { return hit || caches.match('/index.html'); });
      })
    );
    return;
  }

  /* Data + third-party APIs → network-first, cache fallback.
     Strip the cache-buster ?t= so offline lookups hit. */
  var isData = url.pathname === '/data.json' || url.pathname === '/history.json' ||
               url.pathname === '/claims.json' || url.pathname === '/positions.json' ||
               url.pathname === '/morpho-history.json';
  var isCrossOrigin = url.origin !== self.location.origin;
  /* /api/* reads the chain on every request — the widget's whole point is that the price is
     current, so it must never be answered from the cache first. Without this it fell through
     to the cache-first branch below and would have been frozen at its first response. */
  var isApi = !isCrossOrigin && url.pathname.indexOf('/api/') === 0;
  if (isData || isApi || (isCrossOrigin && url.href.indexOf('cdn.jsdelivr.net') === -1)) {
    var cacheKey = req.url;
    if (isData) cacheKey = url.origin + url.pathname;
    else if (isApi) { var k = new URL(req.url); k.searchParams.delete('t'); cacheKey = k.href; }
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(DATA_CACHE).then(function (c) { c.put(cacheKey, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(cacheKey).then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  /* Shell assets (incl. Chart.js CDN) → cache-first */
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
