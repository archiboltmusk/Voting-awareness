/**
 * shared.js — The Bengal Reader
 * Shared behaviour loaded on every page:
 *   1. Scroll progress bar
 *   2. Dark/light theme toggle + localStorage persistence
 *   3. Language toggle (en/bn) + localStorage persistence
 */

/* ── 1. Scroll progress bar ─────────────────────────────────────────────── */
(function () {
  var p = document.createElement('div');
  p.id = 'scroll-prog';
  document.body.prepend(p);
  window.addEventListener(
    'scroll',
    function () {
      var d = document.documentElement;
      p.style.width =
        Math.min((d.scrollTop / (d.scrollHeight - d.clientHeight)) * 100, 100) + '%';
    },
    { passive: true }
  );
})();

/* ── 2. Theme toggle ────────────────────────────────────────────────────── */
/**
 * Call toggleTheme() from any button's onclick.
 * Persists preference in localStorage as 'theme' = 'light' | 'dark'.
 */
window.toggleTheme = function () {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  var next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  var btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = isDark ? '\u25d0 Dark' : '\u25d1 Light';
  try { localStorage.setItem('theme', next); } catch (e) {}
};

/* Restore saved theme immediately (avoids flash) */
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
      /* Update button label once DOM is ready */
      document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.theme-toggle');
        if (btn && t === 'dark') btn.textContent = '\u25d1 Light';
      });
    }
  } catch (e) {}
})();

/* ── 3. Language toggle (en / bn) ───────────────────────────────────────── */
/**
 * Call setLang('en') or setLang('bn') from buttons.
 * Toggles .en-only / .bn-only visibility and marks lang-btn active.
 * Persists preference in localStorage as 'lang'.
 */
window.setLang = function (lang) {
  document.documentElement.setAttribute('lang', lang === 'bn' ? 'bn' : 'en');
  document.querySelectorAll('.en-only').forEach(function (el) {
    el.style.display = lang === 'en' ? '' : 'none';
  });
  document.querySelectorAll('.bn-only').forEach(function (el) {
    el.style.display = lang === 'bn' ? '' : 'none';
  });
  document.querySelectorAll('.lang-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  try { localStorage.setItem('lang', lang); } catch (e) {}
};

/* Restore saved language */
(function () {
  try {
    var l = localStorage.getItem('lang');
    if (l === 'en' || l === 'bn') {
      document.addEventListener('DOMContentLoaded', function () {
        window.setLang(l);
      });
    }
  } catch (e) {}
})();
