// scripts/analytics.mjs
// Privacy-respecting analytics using Plausible (self-hosted or cloud)
// No cookies, no personal data, GDPR-compliant
// Include this script in all HTML pages: <script defer src="/analytics.js"></script>

(function() {
  'use strict';

  // Domain is derived from the actual page hostname at runtime — no hardcoding needed.
  const DOMAIN = location.hostname || 'voting-awareness.vercel.app';
  const PLAUSIBLE_SCRIPT = 'https://plausible.io/js/script.js';

  // Simple page view tracking without cookies
  function trackPageView() {
    if (typeof fetch !== 'function') return;
    try {
      fetch('https://plausible.io/api/event', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': DOMAIN
        },
        body: JSON.stringify({
          n: 'pageview',
          u: location.href,
          d: DOMAIN,
          r: document.referrer || null,
          w: window.innerWidth
        })
      }).catch(() => {});
    } catch(e) {}
  }

  // Track custom events (e.g., filter usage, pledge views)
  window.trackEvent = function(name, props = {}) {
    if (typeof fetch !== 'function') return;
    try {
      fetch('https://plausible.io/api/event', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Host': DOMAIN
        },
        body: JSON.stringify({
          n: name,
          u: location.href,
          d: DOMAIN,
          r: document.referrer || null,
          w: window.innerWidth,
          p: props
        })
      }).catch(() => {});
    } catch(e) {}
  };

  // Track page views on load and on SPA navigation (if using Next.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageView);
  } else {
    trackPageView();
  }

  // Track outbound link clicks
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (!a || !a.href) return;
    if (a.hostname !== location.hostname) {
      window.trackEvent('Outbound Link', { url: a.href });
    }
  });
})();
