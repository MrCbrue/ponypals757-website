const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

// Lightweight .env loader (does not override already-set environment variables)
function parseEnvContent(content) {
  const result = {};
  const clean = String(content).replace(/^\uFEFF/, '');
  for (const rawLine of clean.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/.test(line)) {
      line = line.replace(/^export\s+/, '').trim();
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    result[key] = val;
  }
  return result;
}

function loadDotEnv(explicitPaths = null) {
  const candidates = explicitPaths || [
    process.env.PONYPALS_ENV_FILE,
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env')
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (!fsSync.existsSync(resolved)) continue;
      const parsed = parseEnvContent(fsSync.readFileSync(resolved, 'utf-8'));
      for (const [key, val] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch (_) {}
  }
}
loadDotEnv();

// Detect serverless environment (Vercel / AWS Lambda)
const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NOW_REGION);

// Statically require data files so Vercel's bundler guarantees their inclusion
const defaultPonies = require('./data/ponies.json');
const defaultPackages = require('./data/packages.json');
let defaultRequests = [];
try {
  defaultRequests = require('./data/requests.json');
} catch (_) {
  defaultRequests = [];
}

const HOST = (process.env.HOST || '').trim() || '127.0.0.1';
const parsedPort = Number.parseInt((process.env.PORT || '').trim(), 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const PONIES_FILE = path.join(DATA_DIR, 'ponies.json');
const PACKAGES_FILE = path.join(DATA_DIR, 'packages.json');

const SESSION_COOKIE_NAME = 'ponypals_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_FAILURES = 10;
const ALLOWED_STATUSES = new Set(['Pending', 'Confirmed', 'Completed', 'Cancelled']);
const loginAttempts = new Map();

// On Vercel the root directory is read-only. Writable storage lives in os.tmpdir().
const REQUESTS_FILE = (process.env.PONYPALS_REQUESTS_FILE || '').trim() || (
  isServerless
    ? path.join(os.tmpdir(), 'ponypals-requests.json')
    : path.join(DATA_DIR, 'requests.json')
);

// Safely ensure data directory exists in non-serverless mode
try {
  if (!isServerless && !fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (_) {}

// Safely ensure requests file exists
try {
  if (!fsSync.existsSync(REQUESTS_FILE)) {
    const reqDir = path.dirname(REQUESTS_FILE);
    if (!fsSync.existsSync(reqDir)) {
      fsSync.mkdirSync(reqDir, { recursive: true });
    }
    if (fsSync.existsSync(SEED_REQUESTS_FILE)) {
      fsSync.copyFileSync(SEED_REQUESTS_FILE, REQUESTS_FILE);
    } else {
      fsSync.writeFileSync(REQUESTS_FILE, JSON.stringify(defaultRequests, null, 2), 'utf-8');
    }
  }
} catch (_) {}

// In-memory cache for fast access and fallback if filesystem is locked/read-only
let inMemoryRequests = Array.isArray(defaultRequests) ? [...defaultRequests] : [];

// Auth & security helpers
function getAdminConfig() {
  return {
    username: (process.env.ADMIN_USER || '').trim() || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || ''
  };
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function getSessionKey(config) {
  if (config.sessionSecret) {
    return sha256(config.sessionSecret);
  }
  return crypto.createHmac('sha256', 'ponypals-admin-session-v1').update(config.password).digest();
}

function signSessionToken(username, config) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  }), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionKey(config)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(val);
    } catch (_) {
      cookies[name] = val;
    }
  }
  return cookies;
}

function verifySessionToken(token, config) {
  if (!token || !config.password) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  const expectedSig = crypto.createHmac('sha256', getSessionKey(config)).update(payloadB64).digest();
  let actualSig;
  try {
    actualSig = Buffer.from(sigB64, 'base64url');
  } catch (_) {
    return false;
  }
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    if (!data || typeof data.exp !== 'number' || data.exp <= Date.now()) return false;
    return safeEqual(data.u || '', config.username);
  } catch (_) {
    return false;
  }
}

function verifyBasicAuth(req, config) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ') || !config.password) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf-8');
  } catch (_) {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, config.username) && safeEqual(pass, config.password);
}

function isAdminAuthenticated(req, config) {
  if (!config.password) return false;
  const cookies = parseCookies(req);
  if (verifySessionToken(cookies[SESSION_COOKIE_NAME], config)) return true;
  if (verifyBasicAuth(req, config)) return true;
  return false;
}

function isHttpsRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function buildSessionCookie(value, maxAgeSeconds, secure) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function getClientIp(req) {
  const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLoopback && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return remote;
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.failures >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { failures: 1, windowStart: now });
  } else {
    entry.failures += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra
  };
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
  const buf = Buffer.from(html, 'utf-8');
  res.writeHead(statusCode, securityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...extraHeaders
  }));
  res.end(buf);
}

function renderAdminLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Owner Sign In | PonyPals</title>
  <meta name="robots" content="noindex">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Karla:wght@400;500;700&family=Young+Serif&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .login-card { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 36px 32px; box-shadow: var(--shadow-md); }
    .login-card h1 { font-size: 1.8rem; margin-bottom: 6px; }
    .login-card p { font-size: 0.95rem; margin-bottom: 24px; }
    .login-back { display: inline-block; margin-top: 18px; font-size: 0.9rem; color: var(--ink-faint); }
  </style>
</head>
<body>
  <main class="login-wrap">
    <div class="login-card">
      <h1>Owner portal</h1>
      <p>Sign in to view and manage party requests.</p>
      <div id="loginError" class="form-error" role="alert"></div>
      <form id="adminLoginForm" method="POST" action="/api/admin/login">
        <div class="field">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" class="input" autocomplete="username" required autofocus>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" class="input" autocomplete="current-password" required>
        </div>
        <button type="submit" id="loginBtn" class="btn btn-primary" style="width: 100%; margin-top: 8px;">Sign in</button>
      </form>
      <a href="/" class="login-back">Back to website</a>
    </div>
  </main>
  <script>
    const form = document.getElementById('adminLoginForm');
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.remove('visible');
      errorEl.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username.value,
            password: form.password.value
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.href = '/admin';
          return;
        }
        errorEl.textContent = data.message || 'Invalid username or password.';
        errorEl.classList.add('visible');
      } catch (_) {
        errorEl.textContent = 'Could not reach the server. Please try again.';
        errorEl.classList.add('visible');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });
  </script>
</body>
</html>`;
}

function renderAdminUnconfiguredPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Owner Portal Locked | PonyPals</title>
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <main class="container" style="max-width: 560px; padding: 80px 24px;">
    <h1 style="font-size: 1.9rem; margin-bottom: 12px;">Owner portal is locked</h1>
    <p>Set the <code>ADMIN_PASSWORD</code> environment variable (or add it to <code>.env</code>) and restart the server to enable sign-in.</p>
    <p style="margin-top: 18px;"><a href="/" class="text-link">Back to website</a></p>
  </main>
</body>
</html>`;
}

// Helpers
async function readJson(filePath, fallback = []) {
  if (filePath === REQUESTS_FILE && inMemoryRequests && inMemoryRequests.length > 0) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      inMemoryRequests = parsed;
      return parsed;
    } catch (_) {
      return inMemoryRequests;
    }
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (filePath === REQUESTS_FILE) inMemoryRequests = parsed;
    return parsed;
  } catch (err) {
    if (filePath === PONIES_FILE) return defaultPonies;
    if (filePath === PACKAGES_FILE) return defaultPackages;
    if (filePath === REQUESTS_FILE) return inMemoryRequests || defaultRequests || fallback;
    return fallback;
  }
}

async function writeJson(filePath, data) {
  if (filePath === REQUESTS_FILE) {
    inMemoryRequests = data;
  }
  try {
    const dir = path.dirname(filePath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    console.warn(`[PonyPals] Storage note: disk write (${err.message}), using memory cache.`);
  }
}

function parseJsonBody(req) {
  // If Vercel or another environment has already parsed req.body
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') {
      return Promise.resolve(req.body);
    }
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch (e) {
        return Promise.reject(new Error('Invalid JSON format'));
      }
    }
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2e6) { // 2MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

async function serveStatic(res, filePath, options = {}) {
  try {
    // Resolve absolute path and prevent directory traversal
    const safePath = path.resolve(filePath);
    if (safePath !== PUBLIC_DIR && !safePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, securityHeaders({ 'Content-Type': 'text/plain' }));
      return res.end('Access forbidden');
    }

    const stats = await fs.stat(safePath);
    if (!stats.isFile()) {
      res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain' }));
      return res.end('File not found');
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const content = await fs.readFile(safePath);
    res.writeHead(200, securityHeaders({
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': options.noStore ? 'no-store' : 'no-cache'
    }));
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain' }));
      res.end('File not found');
    } else {
      res.writeHead(500, securityHeaders({ 'Content-Type': 'text/plain' }));
      res.end('Internal server error');
    }
  }
}

function sendJson(res, statusCode, data, options = {}) {
  const jsonStr = JSON.stringify(data);
  const headers = securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    ...(options.noStore ? { 'Cache-Control': 'no-store' } : {}),
    ...(options.cors !== false ? {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    } : {}),
    ...(options.extraHeaders || {})
  });
  res.writeHead(statusCode, headers);
  res.end(jsonStr);
}

function requireAdminApiAuth(req, res) {
  const config = getAdminConfig();
  if (!config.password) {
    sendJson(res, 503, {
      success: false,
      message: 'Admin portal is locked: ADMIN_PASSWORD is not configured.'
    }, { cors: false, noStore: true });
    return false;
  }
  if (!isAdminAuthenticated(req, config)) {
    sendJson(res, 401, {
      success: false,
      message: 'Authentication required'
    }, { cors: false, noStore: true });
    return false;
  }
  return true;
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  // Handle rewrite from /api/:path* -> /api/index.js or /api/
  if (pathname === '/api/index.js' || pathname === '/api') {
    if (req.headers['x-matched-path']) {
      pathname = req.headers['x-matched-path'];
    } else if (parsedUrl.searchParams.has('path')) {
      const p = parsedUrl.searchParams.get('path');
      pathname = p.startsWith('/') ? `/api${p}` : `/api/${p}`;
    }
  }

  const method = req.method.toUpperCase();

  // Handle CORS preflight for public API routes
  if (method === 'OPTIONS') {
    res.writeHead(204, securityHeaders({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }));
    return res.end();
  }

  // --- REST API ROUTES ---
  if (pathname.startsWith('/api/')) {
    try {
      // POST /api/admin/login
      if (pathname === '/api/admin/login' && method === 'POST') {
        const config = getAdminConfig();
        if (!config.password) {
          return sendJson(res, 503, {
            success: false,
            message: 'Admin portal is locked: ADMIN_PASSWORD is not configured.'
          }, { cors: false, noStore: true });
        }

        const ip = getClientIp(req);
        if (isRateLimited(ip)) {
          return sendJson(res, 429, {
            success: false,
            message: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.'
          }, { cors: false, noStore: true });
        }

        const body = await parseJsonBody(req);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';

        if (!safeEqual(username, config.username) || !safeEqual(password, config.password)) {
          recordLoginFailure(ip);
          return sendJson(res, 401, {
            success: false,
            message: 'Invalid username or password.'
          }, { cors: false, noStore: true });
        }

        clearLoginFailures(ip);
        const token = signSessionToken(config.username, config);
        const cookie = buildSessionCookie(token, SESSION_TTL_SECONDS, isHttpsRequest(req));
        return sendJson(res, 200, { success: true }, {
          cors: false,
          noStore: true,
          extraHeaders: { 'Set-Cookie': cookie }
        });
      }

      // POST /api/admin/logout
      if (pathname === '/api/admin/logout' && method === 'POST') {
        const cookie = buildSessionCookie('', 0, isHttpsRequest(req));
        return sendJson(res, 200, { success: true }, {
          cors: false,
          noStore: true,
          extraHeaders: { 'Set-Cookie': cookie }
        });
      }

      // GET /api/ponies
      if (pathname === '/api/ponies' && method === 'GET') {
        const ponies = await readJson(PONIES_FILE, []);
        return sendJson(res, 200, { success: true, ponies });
      }

      // GET /api/packages
      if (pathname === '/api/packages' && method === 'GET') {
        const pkgData = await readJson(PACKAGES_FILE, { packages: [], addOns: [] });
        return sendJson(res, 200, { success: true, ...pkgData });
      }

      // GET /api/stats (Admin protected)
      if (pathname === '/api/stats' && method === 'GET') {
        if (!requireAdminApiAuth(req, res)) return;
        const requests = await readJson(REQUESTS_FILE, []);
        const total = requests.length;
        const pending = requests.filter(r => r.status === 'Pending').length;
        const confirmed = requests.filter(r => r.status === 'Confirmed').length;
        const revenue = requests
          .filter(r => r.status === 'Confirmed')
          .reduce((sum, r) => sum + (Number(r.estimatedTotal) || 0), 0);
        return sendJson(res, 200, { success: true, total, pending, confirmed, revenue }, { cors: false, noStore: true });
      }

      // GET /api/requests (Admin protected)
      if (pathname === '/api/requests' && method === 'GET') {
        if (!requireAdminApiAuth(req, res)) return;
        const requests = await readJson(REQUESTS_FILE, []);
        // Return latest first
        requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return sendJson(res, 200, { success: true, requests }, { cors: false, noStore: true });
      }

      // POST /api/requests (User booking request)
      if (pathname === '/api/requests' && method === 'POST') {
        const body = await parseJsonBody(req);

        // Validation
        const errors = [];
        if (!body.parentName || typeof body.parentName !== 'string' || !body.parentName.trim()) {
          errors.push('Full contact name is required');
        }
        if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
          errors.push('Valid email address is required');
        }
        if (!body.phone || typeof body.phone !== 'string' || body.phone.trim().length < 7) {
          errors.push('Phone number is required');
        }
        if (!body.eventDate || typeof body.eventDate !== 'string') {
          errors.push('Party date is required');
        }
        if (!body.locationAddress || typeof body.locationAddress !== 'string' || !body.locationAddress.trim()) {
          errors.push('Party address or venue location is required');
        }
        if (!body.packageId) {
          errors.push('Please select a party package');
        }

        if (errors.length > 0) {
          return sendJson(res, 400, {
            success: false,
            message: 'Validation failed',
            errors
          });
        }

        // Fetch package & add-on pricing to calculate estimated total
        const pkgData = await readJson(PACKAGES_FILE, { packages: [], addOns: [] });
        const selectedPackage = pkgData.packages.find(p => p.id === body.packageId) || {
          id: body.packageId,
          name: 'Custom Package',
          price: 250
        };

        let calculatedTotal = selectedPackage.price;
        const addOnsList = Array.isArray(body.addOns) ? body.addOns : [];
        for (const addOnId of addOnsList) {
          const match = pkgData.addOns.find(a => a.id === addOnId);
          if (match) {
            calculatedTotal += match.price;
          }
        }

        const newId = `REQ-${Math.floor(1000 + Math.random() * 9000)}`;
        const newBooking = {
          id: newId,
          createdAt: new Date().toISOString(),
          parentName: body.parentName.trim(),
          email: body.email.trim(),
          phone: body.phone.trim(),
          childName: body.childName ? body.childName.trim() : 'Birthday Star',
          childAge: body.childAge ? Number(body.childAge) : null,
          eventDate: body.eventDate,
          eventTime: body.eventTime || 'Afternoon (1:00 PM - 3:00 PM)',
          locationAddress: body.locationAddress.trim(),
          surfaceType: body.surfaceType || 'Lawn / Grass',
          estimatedKids: body.estimatedKids ? Number(body.estimatedKids) : 10,
          packageId: selectedPackage.id,
          packageName: selectedPackage.name,
          selectedPonies: Array.isArray(body.selectedPonies) ? body.selectedPonies : [],
          addOns: addOnsList,
          partyTheme: body.partyTheme ? body.partyTheme.trim() : '',
          specialRequests: body.specialRequests ? body.specialRequests.trim() : '',
          status: 'Pending',
          estimatedTotal: calculatedTotal
        };

        const currentRequests = await readJson(REQUESTS_FILE, []);
        currentRequests.unshift(newBooking);
        await writeJson(REQUESTS_FILE, currentRequests);

        console.log(`[PonyPals] New party request created: ${newBooking.id} by ${newBooking.parentName}`);

        return sendJson(res, 201, {
          success: true,
          message: 'Hooray! Your party request has been received. We will contact you within 24 hours to confirm!',
          booking: newBooking
        });
      }

      // PATCH /api/requests/:id (Admin protected)
      if (pathname.startsWith('/api/requests/') && method === 'PATCH') {
        if (!requireAdminApiAuth(req, res)) return;
        const id = decodeURIComponent(pathname.slice('/api/requests/'.length));
        const body = await parseJsonBody(req);
        if (body.status !== undefined && !ALLOWED_STATUSES.has(body.status)) {
          return sendJson(res, 400, { success: false, message: 'Invalid status value' }, { cors: false, noStore: true });
        }

        const currentRequests = await readJson(REQUESTS_FILE, []);
        const index = currentRequests.findIndex(r => r.id === id);

        if (index === -1) {
          return sendJson(res, 404, { success: false, message: 'Request not found' }, { cors: false, noStore: true });
        }

        // Update fields allowed
        if (body.status) currentRequests[index].status = body.status;
        if (body.notes !== undefined) currentRequests[index].adminNotes = body.notes;

        await writeJson(REQUESTS_FILE, currentRequests);
        return sendJson(res, 200, { success: true, booking: currentRequests[index] }, { cors: false, noStore: true });
      }

      // DELETE /api/requests/:id (Admin protected)
      if (pathname.startsWith('/api/requests/') && method === 'DELETE') {
        if (!requireAdminApiAuth(req, res)) return;
        const id = decodeURIComponent(pathname.slice('/api/requests/'.length));
        const currentRequests = await readJson(REQUESTS_FILE, []);
        const filtered = currentRequests.filter(r => r.id !== id);

        if (filtered.length === currentRequests.length) {
          return sendJson(res, 404, { success: false, message: 'Request not found' }, { cors: false, noStore: true });
        }

        await writeJson(REQUESTS_FILE, filtered);
        return sendJson(res, 200, { success: true, message: 'Request deleted successfully' }, { cors: false, noStore: true });
      }

      return sendJson(res, 404, { success: false, message: 'API route not found' });
    } catch (apiErr) {
      console.error('API Error:', apiErr);
      return sendJson(res, 500, { success: false, message: apiErr.message || 'Server error' });
    }
  }

  // --- STATIC WEB PAGES & ASSETS ---
  if (method === 'GET' || method === 'HEAD') {
    let staticPath = pathname;
    try {
      staticPath = path.posix.normalize(decodeURIComponent(pathname));
    } catch (_) {
      res.writeHead(400, securityHeaders({ 'Content-Type': 'text/plain' }));
      return res.end('Bad Request');
    }

    if (staticPath === '/' || staticPath === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    if (staticPath === '/admin' || staticPath === '/admin/' || staticPath === '/admin.html') {
      const config = getAdminConfig();
      if (!config.password) {
        return sendHtml(res, 503, renderAdminUnconfiguredPage());
      }
      if (!isAdminAuthenticated(req, config)) {
        if (staticPath === '/admin.html') {
          res.writeHead(302, securityHeaders({ Location: '/admin', 'Cache-Control': 'no-store' }));
          return res.end();
        }
        return sendHtml(res, 200, renderAdminLoginPage());
      }
      return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'), { noStore: true });
    }

    if (staticPath === '/js/admin.js') {
      const config = getAdminConfig();
      if (!config.password || !isAdminAuthenticated(req, config)) {
        res.writeHead(401, securityHeaders({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }));
        return res.end('Authentication required');
      }
      return serveStatic(res, path.join(PUBLIC_DIR, 'js', 'admin.js'), { noStore: true });
    }

    // Static asset request
    const candidatePath = path.join(PUBLIC_DIR, staticPath);
    return serveStatic(res, candidatePath);
  }

  res.writeHead(405, securityHeaders({ 'Content-Type': 'text/plain' }));
  res.end('Method Not Allowed');
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  const adminConfigured = Boolean(getAdminConfig().password);
  server.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`PonyPals Party Rides Server listening on http://${HOST}:${PORT}`);
    console.log(`Website: http://${HOST}:${PORT}`);
    console.log(`Admin Dashboard: http://${HOST}:${PORT}/admin (${adminConfigured ? 'auth enabled' : 'LOCKED - set ADMIN_PASSWORD'})`);
    console.log(`====================================================`);
  });
}

// Export function as primary export for Vercel Serverless Function compatibility,
// while attaching properties so destructuring like { handleRequest, server } works.
handleRequest.server = server;
handleRequest.handleRequest = handleRequest;
handleRequest.readJson = readJson;
handleRequest.writeJson = writeJson;
handleRequest.parseEnvContent = parseEnvContent;
handleRequest.loadDotEnv = loadDotEnv;
handleRequest.HOST = HOST;
handleRequest.PORT = PORT;

module.exports = handleRequest;
