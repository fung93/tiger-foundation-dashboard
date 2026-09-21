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
var CACHE_VERSION = 'tiger-v29';
var SHELL_CACHE = CACHE_VERSION + '-shell';
var DATA_CACHE = CACHE_VERSION + '-data';

var SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
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

  /* Navigations → serve cached shell, refresh in background */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put('/index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('/index.html');
      })
    );
    return;
  }

  /* Data + third-party APIs → network-first, cache fallback.
     Strip the cache-buster ?t= so offline lookups hit. */
  var isData = url.pathname === '/data.json' || url.pathname === '/history.json' ||
               url.pathname === '/claims.json' || url.pathname === '/positions.json';
  var isCrossOrigin = url.origin !== self.location.origin;
  if (isData || (isCrossOrigin && url.href.indexOf('cdn.jsdelivr.net') === -1)) {
    var cacheKey = isData ? url.origin + url.pathname : req.url;
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
