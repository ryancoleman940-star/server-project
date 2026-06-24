const express = require('express');
const cors = require('cors');
const compression = require('compression');
const UAParser = require('ua-parser-js');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ── IP Geolocation (ip-api.com, free, no key) ──
const geoCache = {};
function geoLookup(ip) {
  return new Promise((resolve) => {
    if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.')) {
      return resolve({ country: 'Local', city: 'Localhost', region: '', isp: '' });
    }
    if (geoCache[ip]) return resolve(geoCache[ip]);
    const url = `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'success') {
            const geo = { country: j.country, city: j.city, region: j.regionName, isp: j.isp };
            geoCache[ip] = geo;
            resolve(geo);
          } else resolve({ country: 'Unknown', city: '', region: '', isp: '' });
        } catch { resolve({ country: 'Unknown', city: '', region: '', isp: '' }); }
      });
    }).on('error', () => resolve({ country: 'Unknown', city: '', region: '', isp: '' }));
  });
}

// ── Traffic source classifier ──
// ── Snooper detection: ad library / spy tool referrers ──
const SNOOPER_REFERRER_PATTERNS = [
  'facebook.com/ads/library',
  'fb.com/ads/library',
  'adlibrary.facebook',
  'bigspy.com',
  'pipiads.com',
  'minea.com',
  'adspy.com',
  'dropispy.com',
  'droppoint.com',
  'foreplay.co',
  'swipefiled.com',
  'spylibrary.com',
];

function isSnooperReferrer(referrer) {
  if (!referrer) return false;
  const ref = referrer.toLowerCase();
  return SNOOPER_REFERRER_PATTERNS.some(p => ref.includes(p));
}

function classifyTraffic(meta) {
  if (meta?.fbclid || (meta?.utmSource && meta.utmSource.toLowerCase().includes('facebook') && meta?.utmMedium === 'paid')) {
    return { channel: 'Paid Social', source: 'Facebook Ads', medium: meta?.utmMedium || 'cpc' };
  }
  if (meta?.gclid || (meta?.utmSource && meta.utmSource.toLowerCase().includes('google') && (meta?.utmMedium === 'cpc' || meta?.utmMedium === 'ppc'))) {
    return { channel: 'Paid Search', source: 'Google Ads', medium: meta?.utmMedium || 'cpc' };
  }
  if (meta?.utmMedium === 'cpc' || meta?.utmMedium === 'paid' || meta?.utmMedium === 'ppc') {
    return { channel: 'Paid', source: meta?.utmSource || 'Unknown', medium: meta?.utmMedium };
  }
  if (meta?.utmSource) {
    return { channel: 'Campaign', source: meta.utmSource, medium: meta?.utmMedium || 'referral' };
  }
  const ref = meta?.referrer || '';
  if (!ref) return { channel: 'Direct', source: 'Direct', medium: '(none)' };
  try {
    const host = new URL(ref).hostname.replace('www.', '');
    if (host.includes('facebook.com') || host.includes('fb.com')) return { channel: 'Social', source: 'Facebook', medium: 'organic' };
    if (host.includes('instagram.com')) return { channel: 'Social', source: 'Instagram', medium: 'organic' };
    if (host.includes('tiktok.com')) return { channel: 'Social', source: 'TikTok', medium: 'organic' };
    if (host.includes('twitter.com') || host.includes('x.com')) return { channel: 'Social', source: 'Twitter/X', medium: 'organic' };
    if (host.includes('google.')) return { channel: 'Organic Search', source: 'Google', medium: 'organic' };
    if (host.includes('bing.com')) return { channel: 'Organic Search', source: 'Bing', medium: 'organic' };
    if (host.includes('yahoo.com')) return { channel: 'Organic Search', source: 'Yahoo', medium: 'organic' };
    return { channel: 'Referral', source: host, medium: 'referral' };
  } catch { return { channel: 'Referral', source: ref.slice(0, 60), medium: 'referral' }; }
}

const app = express();

// ── Scroll Retention Data ──
const SCROLL_DIR = path.join(__dirname, 'data', 'scroll');
if (!fs.existsSync(SCROLL_DIR)) fs.mkdirSync(SCROLL_DIR, { recursive: true });

app.post('/api/scroll', express.json({ limit: '1mb' }), (req, res) => {
  const { sessionId, page, maxDepth, timeOnPage, checkpoints } = req.body;
  if (!page) return res.status(400).json({ error: 'Missing page' });
  const pageKey = page.replace(/[^a-zA-Z0-9-]/g, '_');
  const file = path.join(SCROLL_DIR, pageKey + '.json');
  let data = [];
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const existing = data.findIndex(d => d.sessionId === sessionId);
  const entry = { sessionId, page, maxDepth, timeOnPage, checkpoints, timestamp: Date.now(), ip: req.ip };
  if (existing >= 0) data[existing] = entry; else data.push(entry);
  if (data.length > 500) data = data.slice(-500);
  fs.writeFileSync(file, JSON.stringify(data));
  res.json({ ok: true });
});

app.get('/api/retention', (req, res) => {
  const page = req.query.page || '';
  if (!page) {
    try {
      const files = fs.readdirSync(SCROLL_DIR).filter(f => f.endsWith('.json'));
      const pages = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(SCROLL_DIR, f), 'utf8'));
        return { file: f, page: data[0]?.page || f.replace('.json',''), visitors: data.length };
      });
      return res.json({ pages });
    } catch { return res.json({ pages: [] }); }
  }
  const pageKey = page.replace(/[^a-zA-Z0-9-]/g, '_');
  const file = path.join(SCROLL_DIR, pageKey + '.json');
  let data = [];
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!data.length) return res.json({ totalVisitors: 0, avgMaxDepth: 0, avgTimeOnPage: 0, retention: [], dropoffs: [] });
  const totalVisitors = data.length;
  const avgMaxDepth = Math.round(data.reduce((s, d) => s + d.maxDepth, 0) / totalVisitors);
  const avgTimeOnPage = Math.round(data.reduce((s, d) => s + d.timeOnPage, 0) / totalVisitors);
  const retention = [];
  for (let pct = 0; pct <= 100; pct += 5) {
    const reached = data.filter(d => d.maxDepth >= pct).length;
    const avgTime = data.filter(d => d.checkpoints && d.checkpoints[pct]).reduce((s, d, _, arr) => s + (d.checkpoints[pct].reached / 1000) / arr.length, 0);
    retention.push({ depth: pct, visitors: reached, pct: Math.round((reached / totalVisitors) * 100), avgTimeToReach: Math.round(avgTime) });
  }
  const dropoffs = [];
  for (let i = 1; i < retention.length; i++) {
    const drop = retention[i-1].pct - retention[i].pct;
    if (drop > 5) dropoffs.push({ from: retention[i-1].depth, to: retention[i].depth, drop });
  }
  dropoffs.sort((a, b) => b.drop - a.drop);
  res.json({ totalVisitors, avgMaxDepth, avgTimeOnPage, retention, dropoffs: dropoffs.slice(0, 5) });
});


const PORT = process.env.PORT || 3777;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ── Auth ──
// Dashboard password is read from the environment — never hardcode it.
// Set it before starting the server, e.g. `export DASHBOARD_PASSWORD='your-strong-password'`.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD environment variable is not set. Refusing to start.');
  process.exit(1);
}
// Derive a non-guessable cookie token from the password (+ optional extra secret),
// so the auth cookie can't be forged by simply setting a known literal value.
const AUTH_SECRET = process.env.AUTH_SECRET || '';
const AUTH_TOKEN = crypto
  .createHash('sha256')
  .update(DASHBOARD_PASSWORD + AUTH_SECRET)
  .digest('hex');

// No-cache for snippet.js so browsers always get latest version
app.use('/snippet.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Login endpoint
app.post('/api/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.cookie('replay_auth', AUTH_TOKEN, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

// Auth check endpoint
app.get('/api/auth-check', (req, res) => {
  const cookie = req.headers.cookie || '';
  if (cookie.includes('replay_auth=' + AUTH_TOKEN)) return res.json({ ok: true });
  res.status(401).json({ error: 'Not authenticated' });
});

// Protect dashboard pages (but allow /snippet.js, /api/record, /api/login, /api/settings (GET), and login.html through)
function authGuard(req, res, next) {
  // Public endpoints
  if (req.path === '/snippet.js' || req.path === '/api/record' || req.path === '/api/login' || req.path === '/api/auth-check' || req.path === '/login.html') return next();
  // Allow GET /api/settings publicly (checkout page reads this)
  if (req.path === '/api/settings' && req.method === 'GET') return next();
  // Check cookie
  const cookie = req.headers.cookie || '';
  if (cookie.includes('replay_auth=' + AUTH_TOKEN)) return next();
  // For API calls, return 401
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  // For page requests (including /), serve login page
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
}

app.use(authGuard);
app.use(express.static(path.join(__dirname, 'public')));

// ── JSON File Store ──
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const EVENTS_DIR = path.join(DATA_DIR, 'events');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_DIR)) fs.mkdirSync(EVENTS_DIR, { recursive: true });
const ACTIVITIES_DIR = path.join(DATA_DIR, 'activities');
if (!fs.existsSync(ACTIVITIES_DIR)) fs.mkdirSync(ACTIVITIES_DIR, { recursive: true });

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}
function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 0));
}
function saveEvents(sessionId, events) {
  const file = path.join(EVENTS_DIR, sessionId + '.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  existing.push(...events);
  fs.writeFileSync(file, JSON.stringify(existing));
}
function loadEvents(sessionId) {
  const file = path.join(EVENTS_DIR, sessionId + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function saveActivities(sessionId, activities) {
  if (!activities || !activities.length) return;
  const file = path.join(ACTIVITIES_DIR, sessionId + '.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  existing.push(...activities);
  fs.writeFileSync(file, JSON.stringify(existing));
}
function loadActivities(sessionId) {
  const file = path.join(ACTIVITIES_DIR, sessionId + '.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

// ── API: Record events ──
app.post('/api/record', (req, res) => {
  try {
    const { sessionId, events, activities, meta } = req.body;
    if (!sessionId || !events || !events.length) return res.status(400).json({ error: 'Missing data' });

    const ua = new UAParser(req.headers['user-agent']);
    const browser = ua.getBrowser();
    const os = ua.getOS();
    const device = ua.getDevice();
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();

    const sessions = loadSessions();
    let session = sessions.find(s => s.id === sessionId);

    if (!session) {
      const traffic = classifyTraffic(meta);
      session = {
        id: sessionId,
        site_url: meta?.siteUrl || '',
        page_url: meta?.pageUrl || '',
        started_at: meta?.startedAt || now,
        last_activity: now,
        duration: 0,
        device: device.type || 'desktop',
        browser: `${browser.name || 'Unknown'} ${browser.version || ''}`.trim(),
        os: `${os.name || 'Unknown'} ${os.version || ''}`.trim(),
        screen_width: meta?.screenWidth || 0,
        screen_height: meta?.screenHeight || 0,
        ip,
        referrer: meta?.referrer || '',
        landing_page: meta?.landingPage || meta?.pageUrl || '/',
        // Traffic source
        traffic_channel: traffic.channel,
        traffic_source: traffic.source,
        traffic_medium: traffic.medium,
        utm_campaign: meta?.utmCampaign || '',
        // Geo (filled async)
        country: '', city: '', region: '', isp: '',
        pages_visited: 1, click_count: 0, scroll_depth: 0, is_active: true
      };
      sessions.unshift(session);

      // Async geo lookup
      geoLookup(ip).then(geo => {
        session.country = geo.country;
        session.city = geo.city;
        session.region = geo.region;
        session.isp = geo.isp;
        saveSessions(loadSessions().map(s => s.id === sessionId ? { ...s, ...geo } : s));
      }).catch(() => {});
    }

    session.last_activity = now;
    session.duration = now - session.started_at;
    session.pages_visited = meta?.pagesVisited || session.pages_visited;
    session.click_count = meta?.clickCount || session.click_count;
    session.scroll_depth = meta?.scrollDepth || session.scroll_depth;
    session.is_active = meta?.isActive !== false;
    if (meta?.pageUrl) session.page_url = meta.pageUrl;

    saveSessions(sessions);
    
    // Debug: log event types received
    const typeCounts = {};
    events.forEach(e => typeCounts[e.type] = (typeCounts[e.type] || 0) + 1);
    console.log(`[${sessionId}] Received ${events.length} events, types:`, typeCounts);
    
    saveEvents(sessionId, events);
    saveActivities(sessionId, activities || []);
    res.json({ ok: true });
  } catch (err) {
    console.error('Record error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: List sessions ──
app.get('/api/sessions', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const search = (req.query.search || '').toLowerCase();
  let sessions = loadSessions();

  if (search) {
    sessions = sessions.filter(s =>
      (s.page_url || '').toLowerCase().includes(search) ||
      (s.ip || '').includes(search) ||
      (s.browser || '').toLowerCase().includes(search) ||
      (s.city || '').toLowerCase().includes(search) ||
      (s.country || '').toLowerCase().includes(search) ||
      (s.traffic_source || '').toLowerCase().includes(search) ||
      (s.traffic_channel || '').toLowerCase().includes(search)
    );
  }

  // Filter by status
  const filter = req.query.filter || 'all';
  const now = Date.now();
  if (filter === 'live') {
    sessions = sessions.filter(s => s.is_active && (now - s.last_activity < 30000));
  } else if (filter === 'ended') {
    sessions = sessions.filter(s => !s.is_active || (now - s.last_activity >= 30000));
  }

  // Filter by page URL
  const pageUrl = req.query.pageUrl || '';
  if (pageUrl) {
    sessions = sessions.filter(s => (s.page_url || '').includes(pageUrl));
  }

  // Snooper filter: Direct traffic or Facebook Ad Library referrers with no purchase intent
  if (filter === 'snooper') {
    for (const s of sessions) {
      const acts = loadActivities(s.id);
      s.added_to_cart = false;
      s.placed_order = false;
      s.cart_amount = '';
      for (const a of acts) {
        const al = (a.action || '').toLowerCase();
        if (al.includes('add to cart') || al.includes('addtocart')) s.added_to_cart = true;
        if (al.includes('purchase') || al.includes('order')) s.placed_order = true;
      }
      // Flag as snooper: came from direct/ad library AND never added to cart or purchased
      const isDirect = s.traffic_channel === 'Direct';
      const isAdLibrary = isSnooperReferrer(s.referrer || '');
      s.is_snooper = (isDirect || isAdLibrary) && !s.added_to_cart && !s.placed_order;
      s.snooper_reason = isAdLibrary ? 'Ad Library' : (isDirect ? 'Direct' : '');
    }
    sessions = sessions.filter(s => s.is_snooper);
  }

  // For cart/order filters, we need to enrich before filtering
  if (filter === 'cart' || filter === 'order') {
    for (const s of sessions) {
      const acts = loadActivities(s.id);
      s.added_to_cart = false;
      s.placed_order = false;
      s.cart_amount = '';
      for (const a of acts) {
        const al = (a.action || '').toLowerCase();
        if (al.includes('add to cart') || al.includes('addtocart')) {
          s.added_to_cart = true;
          const m = (a.detail || '').match(/\$[\d,.]+/);
          if (m) s.cart_amount = m[0];
        }
        if (al.includes('purchase') || al.includes('order')) {
          s.placed_order = true;
          const m = (a.detail || '').match(/\$[\d,.]+/);
          if (m) s.cart_amount = m[0];
        }
      }
    }
    if (filter === 'cart') sessions = sessions.filter(s => s.added_to_cart);
    if (filter === 'order') sessions = sessions.filter(s => s.placed_order);
  }

  const total = sessions.length;
  const sliced = sessions.slice((page - 1) * limit, page * limit);

  // Enrich sliced sessions (if not already done above)
  if (filter !== 'cart' && filter !== 'order' && filter !== 'snooper') {
    for (const s of sliced) {
      const acts = loadActivities(s.id);
      s.actions_count = acts.length;
      s.added_to_cart = false;
      s.placed_order = false;
      s.cart_amount = '';
      for (const a of acts) {
        const al = (a.action || '').toLowerCase();
        if (al.includes('add to cart') || al.includes('addtocart')) {
          s.added_to_cart = true;
          const m = (a.detail || '').match(/\$[\d,.]+/);
          if (m) s.cart_amount = m[0];
        }
        if (al.includes('purchase') || al.includes('order')) {
          s.placed_order = true;
          const m = (a.detail || '').match(/\$[\d,.]+/);
          if (m) s.cart_amount = m[0];
        }
      }
      // Tag snoopers
      const isDirect = s.traffic_channel === 'Direct';
      const isAdLibrary = isSnooperReferrer(s.referrer || '');
      s.is_snooper = (isDirect || isAdLibrary) && !s.added_to_cart && !s.placed_order;
      s.snooper_reason = isAdLibrary ? 'Ad Library' : (isDirect ? 'Direct' : '');
    }
  }

  res.json({ sessions: sliced, total, page, limit });
});

// ── API: Get session + events ──
app.get('/api/sessions/:id', (req, res) => {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const events = loadEvents(req.params.id);
  const activities = loadActivities(req.params.id);
  events.sort((a, b) => a.timestamp - b.timestamp);
  activities.sort((a, b) => a.timestamp - b.timestamp);
  res.json({ session, events, activities });
});

// ── API: Delete session ──
app.delete('/api/sessions/:id', (req, res) => {
  let sessions = loadSessions();
  sessions = sessions.filter(s => s.id !== req.params.id);
  saveSessions(sessions);
  const evFile = path.join(EVENTS_DIR, req.params.id + '.json');
  try { fs.unlinkSync(evFile); } catch {}
  const actFile = path.join(ACTIVITIES_DIR, req.params.id + '.json');
  try { fs.unlinkSync(actFile); } catch {}
  res.json({ ok: true });
});

// ── API: Stats ──
app.get('/api/stats', (req, res) => {
  const sessions = loadSessions();
  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0);
  const todayMs = today.getTime();
  const weekMs = todayMs - 7 * 86400000;

  const todayCount = sessions.filter(s => s.started_at >= todayMs).length;
  const weekCount = sessions.filter(s => s.started_at >= weekMs).length;
  const activeNow = sessions.filter(s => s.is_active && (now - s.last_activity < 30000)).length;
  const durations = sessions.filter(s => s.duration > 0).map(s => s.duration);
  const avgDuration = durations.length ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length / 1000) : 0;

  res.json({ total: sessions.length, todayCount, weekCount, avgDuration, activeNow, topPages: [], deviceBreakdown: [] });
});

// ── API: Unique pages list ──
app.get('/api/pages', (req, res) => {
  const sessions = loadSessions();
  const counts = {};
  for (const s of sessions) {
    const url = (s.page_url || '/').replace(/\?.*$/, '').replace(/\/$/, '') || '/';
    counts[url] = (counts[url] || 0) + 1;
  }
  const pages = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  res.json({ pages, counts });
});

// ── API: Globe data (visitor locations with lat/lng) ──
const CITY_COORDS = {"New York":[40.71,-74.01],"Los Angeles":[34.05,-118.24],"Chicago":[41.88,-87.63],"Houston":[29.76,-95.37],"Phoenix":[33.45,-112.07],"Philadelphia":[39.95,-75.17],"San Antonio":[29.42,-98.49],"San Diego":[32.72,-117.16],"Dallas":[32.78,-96.8],"San Jose":[37.34,-121.89],"Austin":[30.27,-97.74],"Jacksonville":[30.33,-81.66],"San Francisco":[37.77,-122.42],"Columbus":[39.96,-82.99],"Indianapolis":[39.77,-86.16],"Charlotte":[35.23,-80.84],"Seattle":[47.61,-122.33],"Denver":[39.74,-104.99],"Washington":[38.91,-77.04],"Nashville":[36.16,-86.78],"Oklahoma City":[35.47,-97.52],"Portland":[45.51,-122.68],"Las Vegas":[36.17,-115.14],"Memphis":[35.15,-90.05],"Louisville":[38.25,-85.76],"Baltimore":[39.29,-76.61],"Milwaukee":[43.04,-87.91],"Albuquerque":[35.08,-106.65],"Tucson":[32.22,-110.97],"Fresno":[36.75,-119.77],"Sacramento":[38.58,-121.49],"Mesa":[33.42,-111.83],"Atlanta":[33.75,-84.39],"Kansas City":[39.1,-94.58],"Omaha":[41.26,-95.94],"Colorado Springs":[38.83,-104.82],"Raleigh":[35.78,-78.64],"Miami":[25.76,-80.19],"Tampa":[27.95,-82.46],"Minneapolis":[44.98,-93.27],"Cleveland":[41.5,-81.69],"Detroit":[42.33,-83.05],"St. Louis":[38.63,-90.2],"Pittsburgh":[40.44,-79.99],"Cincinnati":[39.1,-84.51],"Orlando":[28.54,-81.38],"Boston":[42.36,-71.06],"London":[51.51,-0.13],"Paris":[48.86,2.35],"Berlin":[52.52,13.41],"Madrid":[40.42,-3.7],"Rome":[41.9,12.5],"Amsterdam":[52.37,4.9],"Brussels":[50.85,4.35],"Vienna":[48.21,16.37],"Zurich":[47.38,8.54],"Munich":[48.14,11.58],"Stockholm":[59.33,18.07],"Oslo":[59.91,10.75],"Copenhagen":[55.68,12.57],"Helsinki":[60.17,24.94],"Warsaw":[52.23,21.01],"Prague":[50.08,14.44],"Budapest":[47.5,19.04],"Dublin":[53.35,-6.26],"Lisbon":[38.72,-9.14],"Barcelona":[41.39,2.17],"Milan":[45.46,9.19],"Toronto":[43.65,-79.38],"Montreal":[45.5,-73.57],"Vancouver":[49.28,-123.12],"Sydney":[-33.87,151.21],"Melbourne":[-37.81,144.96],"Brisbane":[-27.47,153.03],"Auckland":[-36.85,174.76],"Tokyo":[35.68,139.69],"Seoul":[37.57,126.98],"Singapore":[1.35,103.82],"Mumbai":[19.08,72.88],"Delhi":[28.61,77.21],"Bangalore":[12.97,77.59],"São Paulo":[-23.55,-46.63],"Rio de Janeiro":[-22.91,-43.17],"Mexico City":[19.43,-99.13],"Bogota":[4.71,-74.07],"Buenos Aires":[-34.6,-58.38],"Lima":[-12.05,-77.04],"Santiago":[-33.45,-70.67],"Cape Town":[-33.93,18.42],"Johannesburg":[-26.2,28.05],"Lagos":[6.52,3.38],"Cairo":[30.04,31.24],"Nairobi":[-1.29,36.82],"Dubai":[25.2,55.27],"Istanbul":[41.01,28.98],"Tel Aviv":[32.09,34.78],"Manila":[14.6,120.98],"Bangkok":[13.76,100.5],"Jakarta":[-6.21,106.85],"Kuala Lumpur":[3.14,101.69],"Ashburn":[39.04,-77.49],"Boardman":[45.84,-119.73],"Council Bluffs":[41.26,-95.86],"The Dalles":[45.59,-121.18],"Quincy":[47.23,-119.85],"Prineville":[44.3,-120.73]};

app.get('/api/globe', (req, res) => {
  const sessions = loadSessions();
  const now = Date.now();
  const locMap = {};
  
  for (const s of sessions) {
    if (!s.city) continue;
    const key = s.city;
    const coords = CITY_COORDS[s.city];
    if (!coords) continue;
    
    if (!locMap[key]) {
      locMap[key] = { city: s.city, country: s.country || '', lat: coords[0], lng: coords[1], count: 0, active: 0 };
    }
    locMap[key].count++;
    if (s.is_active && (now - s.last_activity < 30000)) locMap[key].active++;
  }
  
  res.json({ locations: Object.values(locMap) });
});

// ── Helper: gather all interactions with session metadata ──
function getAllInteractions() {
  const sessions = loadSessions();
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s; });
  const all = [];
  try {
    const files = fs.readdirSync(ACTIVITIES_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const sid = file.replace('.json', '');
      const session = sessionMap[sid] || {};
      try {
        const acts = JSON.parse(fs.readFileSync(path.join(ACTIVITIES_DIR, file), 'utf8'));
        for (const a of acts) {
          all.push({
            ...a, sessionId: sid,
            ip: session.ip || '', city: session.city || '', country: session.country || '',
            device_type: session.device_type || '', browser: session.browser || '',
            traffic_source: session.traffic_source || '', traffic_channel: session.traffic_channel || '',
            page_url: a.url || session.landing_page || '',
            landing_page: session.landing_page || ''
          });
        }
      } catch {}
    }
  } catch {}
  return all;
}

// ── API: Visitors (grouped by IP) ──
app.get('/api/visitors', (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const all = getAllInteractions();

  // Group by IP
  const grouped = {};
  for (const a of all) {
    const key = a.ip || 'unknown';
    if (!grouped[key]) {
      grouped[key] = { ip: a.ip, city: a.city, country: a.country, device_type: a.device_type, browser: a.browser,
        traffic_source: a.traffic_source, traffic_channel: a.traffic_channel,
        interactions: 0, sessions: new Set(), first_seen: a.timestamp, last_seen: a.timestamp, actions: {} };
    }
    const g = grouped[key];
    g.interactions++;
    g.sessions.add(a.sessionId);
    if (a.timestamp < g.first_seen) g.first_seen = a.timestamp;
    if (a.timestamp > g.last_seen) g.last_seen = a.timestamp;
    const act = (a.action || 'other').toLowerCase();
    g.actions[act] = (g.actions[act] || 0) + 1;
    // Keep latest location/device info
    if (a.city) { g.city = a.city; g.country = a.country; }
    if (a.device_type) g.device_type = a.device_type;
    if (a.traffic_source) g.traffic_source = a.traffic_source;
    if (a.traffic_channel) g.traffic_channel = a.traffic_channel;
  }

  let visitors = Object.values(grouped).map(g => ({
    ...g, sessions: g.sessions.size,
    has_purchase: !!(g.actions['purchase'] || g.actions['pixel: purchase']),
    has_cart: !!(g.actions['add to cart'] || g.actions['pixel: addtocart'] || g.actions['pixel: add to cart']),
    has_checkout: !!(g.actions['pixel: initiatecheckout'] || g.actions['pixel: initiate checkout'])
  }));

  if (search) visitors = visitors.filter(v =>
    (v.ip || '').includes(search) || (v.city || '').toLowerCase().includes(search) ||
    (v.country || '').toLowerCase().includes(search)
  );

  visitors.sort((a, b) => b.last_seen - a.last_seen);
  res.json({ visitors, total: visitors.length });
});

// ── API: Single visitor interactions ──
app.get('/api/visitors/:ip', (req, res) => {
  const ip = req.params.ip;
  const all = getAllInteractions().filter(a => a.ip === ip);
  all.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ interactions: all, total: all.length, ip });
});

// ── API: All interactions (flat list) ──
app.get('/api/interactions', (req, res) => {
  const filter = (req.query.action || '').toLowerCase();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const sessionSearch = (req.query.search || '').toLowerCase();
  let all = getAllInteractions();
  if (filter) all = all.filter(a => (a.action || '').toLowerCase().includes(filter));
  if (sessionSearch) all = all.filter(a =>
    (a.ip || '').includes(sessionSearch) || (a.city || '').toLowerCase().includes(sessionSearch) ||
    (a.detail || '').toLowerCase().includes(sessionSearch) || (a.page_url || '').toLowerCase().includes(sessionSearch)
  );
  all.sort((a, b) => b.timestamp - a.timestamp);
  const total = all.length;
  res.json({ interactions: all.slice((page - 1) * limit, page * limit), total, page, limit });
});

// ── API: Settings (payment gateway toggle) ──
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { payment_gateway: 'stripe' }; } // default to stripe
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  // Validate payment_gateway
  if (updated.payment_gateway && !['stripe', 'whop'].includes(updated.payment_gateway)) {
    return res.status(400).json({ error: 'payment_gateway must be "stripe" or "whop"' });
  }
  saveSettings(updated);
  console.log('[Settings] Updated:', updated);
  res.json(updated);
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  🎬 RevMED Replay Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Snippet:    http://localhost:${PORT}/snippet.js`);
  console.log(`  API:        http://localhost:${PORT}/api/sessions\n`);
});
