/**
 * shared.js — The Bengal Reader
 * Shared behaviour loaded on every page:
 *   1. Scroll progress bar
 *   2. Dark/light theme toggle + localStorage persistence
 *   3. Language toggle (en/bn) + localStorage persistence
 *   4. Dynamic day badge (BJP days in office)
 *   5. Live meta timestamp sync
 *   6. Share utilities (WhatsApp, Twitter, copy link)
 *   7. Active nav link highlighting
 *   8. Live data polling (30 s)
 *   9. Service worker registration
 */

/* ── 9. Service worker registration ─────────────────────────────────────── */
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
window.toggleTheme = function () {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  var next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  var btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = isDark ? '\u25d0 Dark' : '\u25d1 Light';
  try { localStorage.setItem('theme', next); } catch (e) {}
  if (window.trackEvent) window.trackEvent('Theme Toggle', { theme: next });
};

/* Restore saved theme immediately (avoids flash) */
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
      document.addEventListener('DOMContentLoaded', function () {
        var btn = document.querySelector('.theme-toggle');
        if (btn && t === 'dark') btn.textContent = '\u25d1 Light';
      });
    }
  } catch (e) {}
})();

/* ── 3. Language toggle (en / bn) ───────────────────────────────────────── */
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
  if (window.trackEvent) window.trackEvent('Language Toggle', { lang: lang });
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

/* ── 4. Dynamic day badge ───────────────────────────────────────────────── */
/* Updates any element with id="dayBadge" or class="day-badge"
   to show "BJP Day N" since swearing-in on 2026-05-09 */
(function () {
  var SWEARING_IN = new Date('2026-05-09T00:00:00+05:30');
  function updateDayBadge() {
    var dayN = Math.floor((Date.now() - SWEARING_IN.getTime()) / 86400000) + 1;
    var text = 'BJP Day\u00a0' + dayN;
    var els = document.querySelectorAll('#dayBadge, .day-badge');
    els.forEach(function (el) { el.textContent = text; });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateDayBadge);
  } else {
    updateDayBadge();
  }
})();

/* ── 5. Live meta timestamp sync ────────────────────────────────────────── */
/* Fetches /data/meta.json and updates any element with class="last-updated"
   or id="autoChecked" to show the real last-update time. */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var targets = document.querySelectorAll('.last-updated, #autoChecked, .auto-checked');
    if (targets.length === 0) return;
    fetch('/data/meta.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        if (!meta.autoChecked) return;
        var d = new Date(meta.autoChecked);
        var fmt = d.toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }) + ' IST';
        targets.forEach(function (el) { el.textContent = fmt; });
      })
      .catch(function () {});
  });
})();

/* ── 6. Share utilities ─────────────────────────────────────────────────── */
window.shareWhatsApp = function (text, url) {
  var msg = (text || document.title) + '\n' + (url || location.href);
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank', 'noopener');
  if (window.trackEvent) window.trackEvent('Share', { method: 'whatsapp', page: location.pathname });
};

window.shareTwitter = function (text, url) {
  var t = encodeURIComponent(text || document.title);
  var u = encodeURIComponent(url || location.href);
  window.open('https://twitter.com/intent/tweet?text=' + t + '&url=' + u, '_blank', 'noopener');
  if (window.trackEvent) window.trackEvent('Share', { method: 'twitter', page: location.pathname });
};

window.copyLink = function (url, btn) {
  var link = url || location.href;
  navigator.clipboard.writeText(link).then(function () {
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = orig; }, 2000);
    }
    if (window.trackEvent) window.trackEvent('Share', { method: 'copy', page: location.pathname });
  }).catch(function () {
    prompt('Copy this link:', link);
  });
};

/* Share a specific fact/data point (used on MLA, corruption, asset pages) */
window.shareDataPoint = function (label, value, url) {
  var text = '\u2060' + label + ': ' + value + ' — The Bengal Reader';
  window.shareWhatsApp(text, url || location.href);
};

/* ── 7. Active nav link highlighting ────────────────────────────────────── */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var path = location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('.site-nav-link').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (href === path || (path === '/' && href === '/') ||
          (path !== '/' && href !== '/' && path.startsWith(href))) {
        a.classList.add('active');
      }
    });
  });
})();

/* ── 8. Live data polling (30 s) ─────────────────────────────────────────── */
/* Polls /data/meta.json every 30 s. When autoChecked changes (i.e. a new
   data pipeline run landed), fires window event 'bengal:dataupdate' and
   shows a dismissible toast inviting the user to reload. */
(function () {
  var POLL_MS = 30000;
  var lastChecked = null;

  function poll() {
    fetch('/data/meta.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        if (lastChecked === null) { lastChecked = meta.autoChecked; return; }
        if (meta.autoChecked !== lastChecked) {
          lastChecked = meta.autoChecked;
          window.dispatchEvent(new CustomEvent('bengal:dataupdate', { detail: meta }));
          showToast();
        }
      })
      .catch(function () {});
  }

  function showToast() {
    var existing = document.getElementById('bengal-live-toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.id = 'bengal-live-toast';
    t.setAttribute('role', 'status');
    t.textContent = '↻ Data updated — click to reload';
    t.style.cssText = [
      'position:fixed', 'bottom:1.5rem', 'right:1.5rem',
      'background:#1f6b3a', 'color:#fff',
      'padding:8px 18px', 'border-radius:3px',
      'font-family:JetBrains Mono,monospace', 'font-size:11px', 'letter-spacing:.05em',
      'z-index:99999', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
      'transition:opacity .4s',
    ].join(';');
    t.onclick = function () { location.reload(); };
    document.body.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.remove(); }, 400);
    }, 5000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    poll();
    setInterval(poll, POLL_MS);
  });
})();

/* ── 10. Lazy table renderer ─────────────────────────────────────────────── */
/* Usage: window.lazyTable(tbodyId, rows, buildRowHTML, chunkSize)
   Renders the first 50 rows immediately, then streams the rest as the user
   scrolls near the bottom (IntersectionObserver sentinel at 400 px). */
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
    if (!chunk.length) { if (sentinel.parentNode) sentinel.remove(); return; }
    var tmp = document.createElement('tbody');
    tmp.innerHTML = chunk.map(function (row, i) { return buildRowHTML(row, offset + i); }).join('');
    while (tmp.firstChild) tbody.insertBefore(tmp.firstChild, sentinel);
    offset += chunk.length;
    if (offset >= rows.length && sentinel.parentNode) sentinel.remove();
  }

  renderChunk();

  if (offset < rows.length) {
    var obs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) renderChunk();
    }, { rootMargin: '400px' });
    obs.observe(sentinel);
  }
};
