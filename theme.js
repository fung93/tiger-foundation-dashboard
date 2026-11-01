/* Shared theme preference. Run in the head so every page paints the saved theme first. */
(function () {
  'use strict';
  var KEY = 'tf_theme2', root = document.documentElement;

  function savedTheme() {
    try { return localStorage.getItem(KEY) === 'tiger' ? 'tiger' : 'classy'; }
    catch (e) { return root.classList.contains('tiger') ? 'tiger' : 'classy'; }
  }

  function syncButton() {
    var button = document.getElementById('themeBtn');
    if (!button) return;
    var tiger = root.classList.contains('tiger');
    var label = tiger ? 'Switch to the classy theme' : 'Switch to the cute tiger theme';
    button.setAttribute('aria-pressed', tiger ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function apply(theme, remember) {
    var changed = root.dataset.theme !== theme, tiger = theme === 'tiger';
    root.classList.toggle('classy', !tiger);
    root.classList.toggle('tiger', tiger);
    root.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', tiger ? '#0f1623' : '#050505');
    if (remember) try { localStorage.setItem(KEY, theme); } catch (e) {}
    syncButton();
    if (changed) window.dispatchEvent(new CustomEvent('tf-theme-change', { detail: { theme: theme } }));
  }

  apply(savedTheme(), false);
  document.addEventListener('DOMContentLoaded', function () {
    syncButton();
    var button = document.getElementById('themeBtn');
    if (button) button.addEventListener('click', function () {
      apply(root.classList.contains('tiger') ? 'classy' : 'tiger', true);
    });
  });
  window.addEventListener('storage', function (event) {
    if (event.key === KEY || event.key === null) apply(savedTheme(), false);
  });
  // A restored tab may have missed a preference change made on another page.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) apply(savedTheme(), false);
  });

  /* A release's service worker takes over while a page is open: reload once, so the page runs
     the new release's scripts rather than the cached ones it opened with. Without this a
     page could pair an old script with the new API (1 Nov 2026: the vKAT page's old script
     looked for APY after the API had moved to APR, and every rate showed a dash). Only when
     a worker already controlled the page, so a first visit does not reload. */
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
})();
