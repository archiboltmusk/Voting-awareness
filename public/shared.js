/**
 * shared.js — The Bengal Reader
 *   1. Scroll progress bar
 *   2. Dark/light theme toggle + localStorage persistence
 *   3. Language toggle (en/bn) + localStorage persistence
 *   4. Dynamic day badge (BJP days in office)
 *   5. Live meta timestamp sync
 *   6. Share utilities (WhatsApp, Twitter, copy link)
 *   7. Active nav link highlighting
 *   8. Service worker registration
 *   9. Lazy table renderer
 */

/* ── 8. Service worker ───────────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}

/* ── 1. Scroll progress bar ─────────────────────────────────────────────── */
(function () {
  var p = document.createElement('div');
  p.id = 'scroll-prog';
  document.body.prepend(p);
  window.addEventListener('scroll', function () {
    var d = document.documentElement;
    p.style.width = Math.min((d.scrollTop / (d.scrollHeight - d.clientHeight)) * 100, 100) + '%';
  }, { passive: true });
})();

/* ── 2. Theme toggle ────────────────────────────────────────────────────── */
window.toggleTheme = function () {
  var html = document.documentElement;
  var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  var btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = next === 'dark' ? '◑ Light' : '◐ Dark';
  localStorage.setItem('theme', next);
  window.trackEvent('Theme Toggle', { theme: next });
};

(function () {
  var t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') {
    document.documentElement.setAttribute('data-theme', t);
    document.addEventListener('DOMContentLoaded', function () {
      var btn = document.querySelector('.theme-toggle');
      if (btn && t === 'dark') btn.textContent = '◑ Light';
    });
  }
})();

/* ── 3. Language toggle ─────────────────────────────────────────────────── */
window.setLang = function (lang) {
  document.documentElement.setAttribute('lang', lang === 'bn' ? 'bn' : 'en');
  document.querySelectorAll('.en-only').forEach(function (el) { el.style.display = lang === 'en' ? '' : 'none'; });
  document.querySelectorAll('.bn-only').forEach(function (el) { el.style.display = lang === 'bn' ? '' : 'none'; });
  document.querySelectorAll('.lang-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.lang === lang); });
  localStorage.setItem('lang', lang);
  window.trackEvent('Language Toggle', { lang: lang });
};

(function () {
  var l = localStorage.getItem('lang');
  if (l === 'en' || l === 'bn') {
    document.addEventListener('DOMContentLoaded', function () { window.setLang(l); });
  }
})();

/* ── 4. Dynamic day badge ───────────────────────────────────────────────── */
(function () {
  var SWEARING_IN = new Date('2026-05-09T00:00:00+05:30');
  function update() {
    var n = Math.floor((Date.now() - SWEARING_IN.getTime()) / 86400000) + 1;
    document.querySelectorAll('#dayBadge, .day-badge').forEach(function (el) { el.textContent = 'BJP Day ' + n; });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', update) : update();
})();

/* ── 5. Live meta timestamp ─────────────────────────────────────────────── */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var targets = document.querySelectorAll('.last-updated, #autoChecked, .auto-checked');
    if (!targets.length) return;
    fetch('/data/meta.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        if (!meta.autoChecked) return;
        var fmt = new Date(meta.autoChecked).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }) + ' IST';
        targets.forEach(function (el) { el.textContent = fmt; });
      })
      .catch(function () {});
  });
})();

/* ── 6. Share utilities ─────────────────────────────────────────────────── */
window.shareWhatsApp = function (text, url) {
  window.open('https://wa.me/?text=' + encodeURIComponent((text || document.title) + '\n' + (url || location.href)), '_blank', 'noopener');
  window.trackEvent('Share', { method: 'whatsapp', page: location.pathname });
};

window.shareTwitter = function (text, url) {
  window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text || document.title) + '&url=' + encodeURIComponent(url || location.href), '_blank', 'noopener');
  window.trackEvent('Share', { method: 'twitter', page: location.pathname });
};

window.copyLink = function (url, btn) {
  navigator.clipboard.writeText(url || location.href).then(function () {
    if (btn) { var o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = o; }, 2000); }
    window.trackEvent('Share', { method: 'copy', page: location.pathname });
  }).catch(function () { prompt('Copy this link:', url || location.href); });
};

window.shareDataPoint = function (label, value, url) {
  window.shareWhatsApp('⁠' + label + ': ' + value + ' — The Bengal Reader', url || location.href);
};

/* ── 7. Active nav link ─────────────────────────────────────────────────── */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var path = location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.site-nav-link').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (href === path || (path !== '/' && href !== '/' && path.startsWith(href))) {
        a.classList.add('active');
      }
    });
  });
})();

/* ── 9. Mobile bottom nav ───────────────────────────────────────────────── */
(function () {
  var ITEMS = [
    { href: '/', icon: '⌂', label: 'Home' },
    { href: '/accountability', icon: '☑', label: 'Pledges' },
    { href: '/corruption', icon: '⚖', label: 'Cases' },
    { href: '/mlas', icon: '◉', label: 'MLAs' },
    { href: '/bonds', icon: '₹', label: 'Bonds' },
  ];
  var nav = document.createElement('nav');
  nav.className = 'mobile-btm-nav';
  nav.setAttribute('aria-label', 'Quick navigation');
  var path = location.pathname.replace(/\/$/, '') || '/';
  nav.innerHTML = ITEMS.map(function (item) {
    var active =
      item.href === path || (path !== '/' && item.href !== '/' && path.startsWith(item.href))
        ? ' active'
        : '';
    return (
      '<a href="' + item.href + '" class="mobile-btm-item' + active + '">' +
      '<span class="mobile-btm-icon" aria-hidden="true">' + item.icon + '</span>' +
      '<span>' + item.label + '</span></a>'
    );
  }).join('');
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(nav); });
})();

/* ── 10. Lazy table renderer ─────────────────────────────────────────────── */
window.lazyTable = function (tbodyId, rows, buildRowHTML, chunkSize) {
  var CHUNK = chunkSize || 50;
  var tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  var offset = 0;
  var sentinel = document.createElement('tr');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'height:1px;padding:0;visibility:hidden;pointer-events:none;';
  tbody.appendChild(sentinel);
  function renderChunk() {
    var chunk = rows.slice(offset, offset + CHUNK);
    if (!chunk.length) { sentinel.remove(); return; }
    var tmp = document.createElement('tbody');
    tmp.innerHTML = chunk.map(function (row, i) { return buildRowHTML(row, offset + i); }).join('');
    while (tmp.firstChild) tbody.insertBefore(tmp.firstChild, sentinel);
    offset += chunk.length;
    if (offset >= rows.length) sentinel.remove();
  }
  renderChunk();
  if (offset < rows.length) {
    new IntersectionObserver(function (entries, obs) {
      if (entries[0].isIntersecting) { renderChunk(); if (offset >= rows.length) obs.disconnect(); }
    }, { rootMargin: '400px' }).observe(sentinel);
  }
};
