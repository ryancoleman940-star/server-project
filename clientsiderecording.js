/**
 * RevMED Session Replay — Recording Snippet v4
 * Uses rrweb v1.1.3 stable
 * FIX: Removed keepalive:true from fetch (64KB browser limit was killing the ~400KB full snapshot)
 */
(function() {
  'use strict';

  var ENDPOINT = (document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src).origin + '/api/record'
    : 'https://replay.revmedsups.com/api/record';

  var FLUSH_INTERVAL = 5000;
  var MAX_BATCH_SIZE = 500;
  var SESSION_TIMEOUT = 30 * 60 * 1000;

  function getParam(name) {
    try {
      var url = new URL(window.location.href);
      return url.searchParams.get(name) || sessionStorage.getItem('_rr_' + name) || '';
    } catch(e) { return ''; }
  }

  // Store UTM params and landing page on first visit so they persist across pages
  if (!sessionStorage.getItem('_rr_landing')) {
    sessionStorage.setItem('_rr_landing', window.location.pathname + window.location.search);
    var params = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'];
    params.forEach(function(p) {
      var v = new URL(window.location.href).searchParams.get(p);
      if (v) sessionStorage.setItem('_rr_' + p, v);
    });
  }

  function generateId() {
    return 'ses_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  function getSessionId() {
    var stored = sessionStorage.getItem('_rr_sid');
    var lastActive = parseInt(sessionStorage.getItem('_rr_last') || '0');
    if (stored && (Date.now() - lastActive) < SESSION_TIMEOUT) return stored;
    var newId = generateId();
    sessionStorage.setItem('_rr_sid', newId);
    sessionStorage.setItem('_rr_start', Date.now().toString());
    sessionStorage.setItem('_rr_clicks', '0');
    return newId;
  }

  var sessionId = getSessionId();
  var eventBuffer = [];
  var activityBuffer = [];
  var clickCount = parseInt(sessionStorage.getItem('_rr_clicks') || '0');
  var maxScrollDepth = 0;
  var isActive = true;
  var hasFullSnapshot = false;

  function logActivity(action, detail) {
    activityBuffer.push({
      action: action,
      detail: detail || '',
      url: window.location.pathname,
      timestamp: Date.now()
    });
  }

  // ── Pixel Event Interception ──
  // Hooks into tracking pixels to log their events in our activity timeline
  var pixelLabels = {
    PageView: 'Page View', ViewContent: 'View Content', AddToCart: 'Add to Cart',
    InitiateCheckout: 'Initiate Checkout', AddPaymentInfo: 'Add Payment Info',
    Purchase: 'Purchase', Lead: 'Lead', CompleteRegistration: 'Registration',
    Search: 'Search', AddToWishlist: 'Add to Wishlist', Subscribe: 'Subscribe',
    Contact: 'Contact', StartTrial: 'Start Trial', SubmitApplication: 'Submit App'
  };

  // 1. Meta Pixel (fbq) — non-invasive hook via callMethod patching
  function hookFbq() {
    if (typeof window.fbq !== 'function') return;
    if (window._rrFbqHooked) return;
    window._rrFbqHooked = true;

    // Patch callMethod instead of replacing fbq — preserves the pixel's internal state
    if (window.fbq.callMethod) {
      var origCall = window.fbq.callMethod;
      window.fbq.callMethod = function() {
        var args = Array.prototype.slice.call(arguments);
        try {
          if (args[0] === 'track' || args[0] === 'trackCustom') {
            var evName = args[1] || 'Unknown';
            var params = args[2] || {};
            var label = pixelLabels[evName] || evName;
            var detail = '';
            if (params.content_name) detail = params.content_name;
            else if (params.value) detail = '$' + params.value + (params.currency ? ' ' + params.currency : '');
            else if (params.content_ids) detail = params.content_ids.join(', ');
            logActivity('meta_pixel', label + (detail ? ': ' + detail : ''));
          }
        } catch(e) {}
        return origCall.apply(window.fbq, args);
      };
    } else {
      // Fallback: fbq queues calls before SDK loads — watch the queue
      var origPush = window.fbq.queue && window.fbq.queue.push;
      if (origPush) {
        window.fbq.queue.push = function() {
          var args = Array.prototype.slice.call(arguments);
          try {
            if (args[0] && args[0][0] === 'track') {
              var evName = args[0][1] || 'Unknown';
              logActivity('meta_pixel', pixelLabels[evName] || evName);
            }
          } catch(e) {}
          return origPush.apply(window.fbq.queue, arguments);
        };
      }
    }
  }

  // 2. Google Analytics / Google Ads (gtag)
  function hookGtag() {
    if (typeof window.gtag !== 'function') return;
    if (window._rrGtagHooked) return;
    window._rrGtagHooked = true;
    var orig = window.gtag;
    window.gtag = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args[0] === 'event') {
        var evName = args[1] || '';
        var params = args[2] || {};
        var gaLabels = {
          page_view: 'Page View', add_to_cart: 'Add to Cart', begin_checkout: 'Begin Checkout',
          purchase: 'Purchase', view_item: 'View Item', add_payment_info: 'Add Payment Info',
          sign_up: 'Sign Up', login: 'Login', search: 'Search', select_content: 'Select Content',
          view_item_list: 'View Item List', add_to_wishlist: 'Add to Wishlist',
          generate_lead: 'Lead', conversion: 'Conversion'
        };
        var label = gaLabels[evName] || evName;
        var detail = '';
        if (params.items && params.items[0]) detail = params.items[0].item_name || params.items[0].id || '';
        else if (params.value) detail = '$' + params.value;
        else if (params.send_to) detail = params.send_to;
        logActivity('google_pixel', label + (detail ? ': ' + detail : ''));
      }
      return orig.apply(this, args);
    };
  }

  // 3. TikTok Pixel (ttq)
  function hookTtq() {
    if (typeof window.ttq === 'undefined' || !window.ttq) return;
    if (window._rrTtqHooked) return;
    window._rrTtqHooked = true;
    var origTrack = window.ttq.track;
    if (typeof origTrack === 'function') {
      window.ttq.track = function(evName, params) {
        var label = pixelLabels[evName] || evName;
        var detail = '';
        if (params && params.content_name) detail = params.content_name;
        else if (params && params.value) detail = '$' + params.value;
        logActivity('tiktok_pixel', label + (detail ? ': ' + detail : ''));
        return origTrack.apply(this, arguments);
      };
    }
  }

  // 4. Snapchat Pixel (snaptr)
  function hookSnaptr() {
    if (typeof window.snaptr !== 'function') return;
    if (window._rrSnapHooked) return;
    window._rrSnapHooked = true;
    var orig = window.snaptr;
    window.snaptr = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args[0] === 'track') {
        logActivity('snap_pixel', (pixelLabels[args[1]] || args[1] || 'Event'));
      }
      return orig.apply(this, args);
    };
  }

  // 5. Pinterest Pixel (pintrk)
  function hookPintrk() {
    if (typeof window.pintrk !== 'function') return;
    if (window._rrPinHooked) return;
    window._rrPinHooked = true;
    var orig = window.pintrk;
    window.pintrk = function() {
      var args = Array.prototype.slice.call(arguments);
      if (args[0] === 'track') {
        logActivity('pinterest_pixel', (args[1] || 'Event'));
      }
      return orig.apply(this, args);
    };
  }

  // Try hooking immediately and also after a delay (pixels may load after us)
  function hookAllPixels() {
    hookFbq(); hookGtag(); hookTtq(); hookSnaptr(); hookPintrk();
  }
  hookAllPixels();
  setTimeout(hookAllPixels, 2000);
  setTimeout(hookAllPixels, 5000);

  // Log initial page view
  var pagePath = window.location.pathname;
  if (pagePath.indexOf('/product/') !== -1) {
    var prodName = document.querySelector('h1.product_title, h1') ;
    logActivity('product_view', prodName ? prodName.textContent.trim() : pagePath);
  } else if (pagePath.indexOf('/checkout') !== -1 || pagePath.indexOf('/custom-checkout') !== -1) {
    logActivity('checkout_start', '');
  } else if (pagePath.indexOf('/cart') !== -1) {
    logActivity('cart_view', '');
  } else if (pagePath.indexOf('/my-account') !== -1) {
    logActivity('account_view', '');
  } else {
    logActivity('page_view', document.title || pagePath);
  }

  window.addEventListener('scroll', function() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    var depth = Math.min(100, Math.round((scrollTop + window.innerHeight) / docHeight * 100));
    if (depth > maxScrollDepth) maxScrollDepth = depth;
  }, { passive: true });

  // Track clicks with activity detection
  document.addEventListener('click', function(e) {
    clickCount++;
    sessionStorage.setItem('_rr_clicks', clickCount.toString());

    var target = e.target.closest('button, a, input[type="submit"], .single_add_to_cart_button, .add_to_cart_button');
    if (!target) return;

    var text = (target.textContent || '').trim().toLowerCase();
    var cls = (target.className || '').toLowerCase();

    // Add to Cart
    if (text.indexOf('add to cart') !== -1 || cls.indexOf('add_to_cart') !== -1 || cls.indexOf('add-to-cart') !== -1) {
      var product = document.querySelector('h1.product_title, h1');
      logActivity('add_to_cart', product ? product.textContent.trim() : '');
    }
    // Place Order / Pay
    else if (text.indexOf('place order') !== -1 || text.indexOf('pay now') !== -1 || text.indexOf('complete order') !== -1 || cls.indexOf('co-pay-btn') !== -1) {
      logActivity('place_order', '');
    }
    // Add to Order (upsell)
    else if (text.indexOf('add to order') !== -1) {
      logActivity('upsell_accept', text);
    }
    // Subscribe
    else if (text.indexOf('subscribe') !== -1) {
      logActivity('subscribe_click', text);
    }
    // Navigation link clicks
    else if (target.tagName === 'A' && target.href) {
      var href = target.getAttribute('href') || '';
      if (href.indexOf('/product/') !== -1) {
        logActivity('product_click', target.textContent.trim());
      } else if (href.indexOf('/shop') !== -1 || href.indexOf('/category') !== -1) {
        logActivity('shop_click', target.textContent.trim());
      }
    }
  }, true);

  document.addEventListener('visibilitychange', function() {
    isActive = !document.hidden;
    if (document.hidden) flush(true);
  });

  // Load rrweb v1 stable
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/rrweb@1.1.3/dist/rrweb.min.js';
  script.onload = function() {
    if (typeof rrweb === 'undefined' || !rrweb.record) {
      console.warn('[Replay] rrweb not available');
      return;
    }

    console.log('[Replay v4] Starting recording, session:', sessionId);

    rrweb.record({
      emit: function(event) {
        eventBuffer.push(event);

        if (event.type === 2) {
          hasFullSnapshot = true;
          console.log('[Replay v4] FullSnapshot captured! Size:', JSON.stringify(event).length, 'bytes');
          // Flush immediately after full snapshot — critical for replay to work
          setTimeout(function() { flush(false); }, 500);
        }

        if (eventBuffer.length >= MAX_BATCH_SIZE) flush(false);
      },
      maskAllInputs: true,
      blockClass: 'no-record',
      inlineStylesheet: true,
      recordCanvas: false,
      sampling: {
        mousemove: 50,
        mouseInteraction: true,
        scroll: 150,
        input: 'last',
      },
      maskTextClass: 'sensitive',
    });

    // Regular flush timer
    setInterval(function() { flush(false); }, FLUSH_INTERVAL);
    window.addEventListener('beforeunload', function() { flush(true); });
  };
  script.onerror = function() { console.warn('[Replay] Failed to load rrweb'); };
  document.head.appendChild(script);

  function flush(isBeacon) {
    if (eventBuffer.length === 0) return;
    var events = eventBuffer.splice(0, MAX_BATCH_SIZE);
    sessionStorage.setItem('_rr_last', Date.now().toString());

    var activities = activityBuffer.splice(0);

    var payload = JSON.stringify({
      sessionId: sessionId,
      events: events,
      activities: activities,
      meta: {
        siteUrl: window.location.origin,
        pageUrl: window.location.pathname + window.location.search,
        startedAt: parseInt(sessionStorage.getItem('_rr_start') || Date.now().toString()),
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        referrer: document.referrer || '',
        pagesVisited: 1,
        clickCount: clickCount,
        scrollDepth: maxScrollDepth,
        isActive: isActive,
        // Traffic source tracking
        utmSource: getParam('utm_source'),
        utmMedium: getParam('utm_medium'),
        utmCampaign: getParam('utm_campaign'),
        utmTerm: getParam('utm_term'),
        utmContent: getParam('utm_content'),
        fbclid: getParam('fbclid'),
        gclid: getParam('gclid'),
        landingPage: sessionStorage.getItem('_rr_landing') || window.location.pathname,
      }
    });

    var payloadSize = payload.length;
    var eventTypes = events.map(function(e) { return e.type; });
    console.log('[Replay v4] Flushing', events.length, 'events, types:', eventTypes.join(','), 'size:', payloadSize);

    // CRITICAL FIX: Do NOT use keepalive:true for large payloads.
    // Browsers enforce a 64KB limit on keepalive requests.
    // Full DOM snapshots are typically 200-500KB, which silently fails with keepalive.
    // Only use sendBeacon for tiny final flush on page unload.
    if (isBeacon && navigator.sendBeacon && payloadSize < 50000) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    } else {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        // NO keepalive here — it was silently killing the full snapshot
      }).then(function(r) {
        if (!r.ok) console.warn('[Replay v4] Server returned', r.status);
        else console.log('[Replay v4] Flush OK, types:', eventTypes.join(','));
      }).catch(function(e) {
        console.warn('[Replay v4] Flush error:', e.message);
      });
    }
  }


  // ── Scroll Depth Tracker ──
  var scrollTracker = {
    maxDepth: 0, checkpoints: {}, startTime: Date.now(), lastSendTime: 0,
    page: window.location.pathname,
    init: function() {
      var self = this;
      var ticking = false;
      window.addEventListener('scroll', function() {
        if (!ticking) { requestAnimationFrame(function() { self.update(); ticking = false; }); ticking = true; }
      });
      window.addEventListener('beforeunload', function() { self.send(true); });
      setInterval(function() { self.send(false); }, 10000);
    },
    update: function() {
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
      if (docHeight <= 0) return;
      var pct = Math.min(Math.round((scrollTop / docHeight) * 100), 100);
      if (pct > this.maxDepth) this.maxDepth = pct;
      var bucket = Math.floor(pct / 5) * 5;
      if (!this.checkpoints[bucket]) this.checkpoints[bucket] = { reached: Date.now() - this.startTime, time: 0 };
      this.checkpoints[bucket].time = Date.now() - this.startTime;
    },
    send: function(isBeacon) {
      if (this.maxDepth <= 0) return;
      var now = Date.now();
      if (!isBeacon && now - this.lastSendTime < 8000) return;
      this.lastSendTime = now;
      var data = JSON.stringify({ sessionId: sessionId, page: this.page, maxDepth: this.maxDepth, timeOnPage: Math.round((now - this.startTime) / 1000), checkpoints: this.checkpoints });
      var ep = ENDPOINT.replace('/record', '/scroll');
      if (isBeacon && navigator.sendBeacon) navigator.sendBeacon(ep, new Blob([data], { type: 'application/json' }));
      else fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data }).catch(function(){});
    }
  };
  scrollTracker.init();

})();
