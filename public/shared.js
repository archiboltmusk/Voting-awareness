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

/* ── 7. Active nav link + hamburger menu ────────────────────────────────── */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var path = location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.site-nav-link').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (href === path || (path !== '/' && href !== '/' && path.startsWith(href))) {
        a.classList.add('active');
      }
    });

    // Inject hamburger button
    var inner = document.querySelector('.site-nav-inner');
    var links = document.querySelector('.site-nav-links');
    if (!inner || !links) return;
    links.id = 'site-nav-links';

    var btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.setAttribute('aria-label', 'Toggle navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'site-nav-links');
    btn.innerHTML = '<span class="nav-hamburger-bar"></span>' +
                    '<span class="nav-hamburger-bar"></span>' +
                    '<span class="nav-hamburger-bar"></span>';
    inner.appendChild(btn);

    btn.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.addEventListener('click', function (e) {
      if (!inner.contains(e.target)) {
        links.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    links.addEventListener('click', function (e) {
      if (e.target.closest('.site-nav-link')) {
        links.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
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

/* ── 11. Source citation tooltips ────────────────────────────────────────── */
/* Activates on any element with data-cite="Source name, year"
   Optionally pair with data-cite-url="https://..." for a clickable link.
   CSS lives in shared.css under "SOURCE CITATION TOOLTIPS". */
(function () {
  var tip = null;
  var hideTimer = null;

  function getTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'bengal-cite-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
      tip.addEventListener('mouseenter', function () {
        clearTimeout(hideTimer);
      });
      tip.addEventListener('mouseleave', function () {
        scheduleHide();
      });
    }
    return tip;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      var t = getTip();
      t.classList.remove('visible');
    }, 120);
  }

  function show(el, e) {
    clearTimeout(hideTimer);
    var label = el.getAttribute('data-cite') || '';
    var url = el.getAttribute('data-cite-url') || '';
    var t = getTip();
    t.innerHTML = label + (url
      ? '<a href="' + url + '" target="_blank" rel="noopener">' + url.replace(/^https?:\/\//, '').split('/')[0] + ' ↗</a>'
      : '');
    t.classList.add('visible');
    position(e);
  }

  function position(e) {
    if (!tip) return;
    var x = e.clientX + 12;
    var y = e.clientY - 36;
    var tw = tip.offsetWidth || 200;
    var th = tip.offsetHeight || 50;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 8;
    if (y < 8) y = e.clientY + 16;
    if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  document.addEventListener('mouseover', function (e) {
    var el = e.target && e.target.closest('[data-cite]');
    if (el) show(el, e);
  });

  document.addEventListener('mousemove', function (e) {
    if (tip && tip.classList.contains('visible')) position(e);
  });

  document.addEventListener('mouseout', function (e) {
    var el = e.target && e.target.closest('[data-cite]');
    if (el) scheduleHide();
  });

  document.addEventListener('focusin', function (e) {
    var el = e.target && e.target.closest('[data-cite]');
    if (el) {
      var rect = el.getBoundingClientRect();
      show(el, { clientX: rect.left, clientY: rect.top });
    }
  });

  document.addEventListener('focusout', function (e) {
    var el = e.target && e.target.closest('[data-cite]');
    if (el) scheduleHide();
  });
})();

/* ── 12. Speculation Rules (instant page loads) ──────────────────────────── */
/* Injects a <script type="speculationrules"> block so Chrome prerenders
   internal links on hover (moderate eagerness = prerender on mousedown). */
(function () {
  if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
  var rules = {
    prerender: [{ where: { and: [{ href_matches: '/*' }, { not: { href_matches: '/api/*' } }] }, eagerness: 'moderate' }],
  };
  var s = document.createElement('script');
  s.type = 'speculationrules';
  s.textContent = JSON.stringify(rules);
  document.head.appendChild(s);
})();

/* ── 13. View Transitions (smooth cross-page navigation) ─────────────────── */
/* Uses the native View Transitions API (Chrome 111+) to animate page changes.
   Falls back gracefully — non-supporting browsers navigate normally. */
(function () {
  if (!document.startViewTransition) return;

  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest('a[href]');
    if (!link) return;
    var href = link.href;
    if (!href) return;
    try {
      var u = new URL(href);
      if (u.origin !== location.origin) return; // external link — skip
      if (u.pathname === location.pathname && u.search === location.search) return; // same page
    } catch (_) { return; }
    if (link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
    e.preventDefault();
    document.startViewTransition(function () {
      location.href = href;
    });
  });
})();

/* ── 14. PWA manifest injection + install prompt ─────────────────────────── */
/* Dynamically injects <link rel="manifest"> and <meta name="theme-color">
   so we don't have to edit every HTML page. Also wires up the browser's
   beforeinstallprompt event to show a subtle install button. */
(function () {
  // Inject manifest link
  if (!document.querySelector('link[rel="manifest"]')) {
    var lnk = document.createElement('link');
    lnk.rel = 'manifest';
    lnk.href = '/manifest.json';
    document.head.appendChild(lnk);
  }
  // Inject theme-color meta
  if (!document.querySelector('meta[name="theme-color"]')) {
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#050403';
    document.head.appendChild(meta);
  }

  // Install prompt
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  function showInstallBanner() {
    if (document.getElementById('bengal-install-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'bengal-install-banner';
    banner.setAttribute('role', 'complementary');
    banner.setAttribute('aria-label', 'Install app');
    banner.innerHTML = '<span>Install The Bengal Reader for offline access</span>' +
      '<button id="bengal-install-btn">Install App</button>' +
      '<button id="bengal-install-dismiss" aria-label="Dismiss">✕</button>';
    document.body.appendChild(banner);

    document.getElementById('bengal-install-btn').addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        banner.remove();
      });
    });
    document.getElementById('bengal-install-dismiss').addEventListener('click', function () {
      banner.remove();
      try { sessionStorage.setItem('install-dismissed', '1'); } catch (_) {}
    });
  }
})();

/* ── 15. OneSignal push notifications ────────────────────────────────────── */
/* Loads the OneSignal Web SDK and initialises it with the App ID fetched
   from /api/config. Skips silently if ONESIGNAL_APP_ID is not configured. */
(function () {
  fetch('/api/config', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (!cfg.onesignalAppId) return;
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      var s = document.createElement('script');
      s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      s.defer = true;
      document.head.appendChild(s);
      OneSignalDeferred.push(function (OneSignal) {
        OneSignal.init({
          appId: cfg.onesignalAppId,
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          notifyButton: { enable: false },
          allowLocalhostAsSecureOrigin: true,
        });
      });
    })
    .catch(function () {});
})();
