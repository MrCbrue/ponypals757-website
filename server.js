const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// REQUESTS_FILE can be overridden (the test suite points it at a temp file)
const REQUESTS_FILE = process.env.PONYPALS_REQUESTS_FILE || path.join(DATA_DIR, 'requests.json');
const PONIES_FILE = path.join(DATA_DIR, 'ponies.json');
const PACKAGES_FILE = path.join(DATA_DIR, 'packages.json');

// Ensure data directory exists
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure requests.json exists
if (!fsSync.existsSync(REQUESTS_FILE)) {
  fsSync.writeFileSync(REQUESTS_FILE, JSON.stringify([], null, 2), 'utf-8');
}

// Helpers
async function readJson(filePath, fallback = []) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const tempPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

function parseJsonBody(req) {
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

async function serveStatic(res, filePath) {
  try {
    // Resolve absolute path and prevent directory traversal
    const safePath = path.resolve(filePath);
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Access forbidden');
    }

    const stats = await fs.stat(safePath);
    if (!stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File not found');
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const content = await fs.readFile(safePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
}

function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(jsonStr);
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // --- REST API ROUTES ---
  if (pathname.startsWith('/api/')) {
    try {
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

      // GET /api/stats
      if (pathname === '/api/stats' && method === 'GET') {
        const requests = await readJson(REQUESTS_FILE, []);
        const total = requests.length;
        const pending = requests.filter(r => r.status === 'Pending').length;
        const confirmed = requests.filter(r => r.status === 'Confirmed').length;
        const revenue = requests
          .filter(r => r.status === 'Confirmed')
          .reduce((sum, r) => sum + (Number(r.estimatedTotal) || 0), 0);
        return sendJson(res, 200, { success: true, total, pending, confirmed, revenue });
      }

      // GET /api/requests
      if (pathname === '/api/requests' && method === 'GET') {
        const requests = await readJson(REQUESTS_FILE, []);
        // Return latest first
        requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return sendJson(res, 200, { success: true, requests });
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

      // PATCH /api/requests/:id
      if (pathname.startsWith('/api/requests/') && method === 'PATCH') {
        const id = pathname.replace('/api/requests/', '');
        const body = await parseJsonBody(req);
        const currentRequests = await readJson(REQUESTS_FILE, []);
        const index = currentRequests.findIndex(r => r.id === id);

        if (index === -1) {
          return sendJson(res, 404, { success: false, message: 'Request not found' });
        }

        // Update fields allowed
        if (body.status) currentRequests[index].status = body.status;
        if (body.notes !== undefined) currentRequests[index].adminNotes = body.notes;

        await writeJson(REQUESTS_FILE, currentRequests);
        return sendJson(res, 200, { success: true, booking: currentRequests[index] });
      }

      // DELETE /api/requests/:id
      if (pathname.startsWith('/api/requests/') && method === 'DELETE') {
        const id = pathname.replace('/api/requests/', '');
        const currentRequests = await readJson(REQUESTS_FILE, []);
        const filtered = currentRequests.filter(r => r.id !== id);

        if (filtered.length === currentRequests.length) {
          return sendJson(res, 404, { success: false, message: 'Request not found' });
        }

        await writeJson(REQUESTS_FILE, filtered);
        return sendJson(res, 200, { success: true, message: 'Request deleted successfully' });
      }

      return sendJson(res, 404, { success: false, message: 'API route not found' });
    } catch (apiErr) {
      console.error('API Error:', apiErr);
      return sendJson(res, 500, { success: false, message: apiErr.message || 'Server error' });
    }
  }

  // --- STATIC WEB PAGES & ASSETS ---
  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/admin' || pathname === '/admin.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    // Static asset request
    const candidatePath = path.join(PUBLIC_DIR, pathname);
    return serveStatic(res, candidatePath);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method Not Allowed');
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🐴 PonyPals Party Rides Server is LIVE on port ${PORT}!`);
    console.log(`🌟 Website: http://localhost:${PORT}`);
    console.log(`📋 Admin Dashboard: http://localhost:${PORT}/admin`);
    console.log(`====================================================`);
  });
}

module.exports = { server, handleRequest, readJson, writeJson };
