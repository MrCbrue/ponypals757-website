/**
 * PonyPals Test Suite
 * Tests request handling, validation, party request input box persistence, and admin workflows.
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run against a throwaway copy of the requests file so tests never touch real bookings
const tmpRequestsFile = path.join(os.tmpdir(), `ponypals-test-requests-${process.pid}.json`);
fs.copyFileSync(path.join(__dirname, '..', 'data', 'requests.json'), tmpRequestsFile);
process.env.PONYPALS_REQUESTS_FILE = tmpRequestsFile;
process.on('exit', () => {
  try { fs.unlinkSync(tmpRequestsFile); } catch (_) { /* already gone */ }
});

const { handleRequest, HOST, parseEnvContent, loadDotEnv } = require('../server.js');

class MockRequest extends EventEmitter {
  constructor(method, url, body = null, headers = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3000', ...headers };
    this.socket = { remoteAddress: '127.0.0.1', encrypted: false };
    this._body = body ? JSON.stringify(body) : null;
  }

  start() {
    process.nextTick(() => {
      if (this._body) {
        this.emit('data', Buffer.from(this._body));
      }
      this.emit('end');
    });
  }
}

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.bodyChunks = [];
    this.ended = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  write(chunk) {
    if (chunk) this.bodyChunks.push(Buffer.from(chunk));
  }

  end(chunk) {
    if (chunk) this.bodyChunks.push(Buffer.from(chunk));
    this.ended = true;
    if (this._resolve) {
      const fullBuffer = Buffer.concat(this.bodyChunks);
      const isJson = (this.headers['Content-Type'] || '').includes('application/json');
      const bodyStr = fullBuffer.toString('utf-8');
      this._resolve({
        statusCode: this.statusCode,
        headers: this.headers,
        rawBody: fullBuffer,
        text: bodyStr,
        json: isJson ? JSON.parse(bodyStr) : null
      });
    }
  }

  waitForResponse() {
    return new Promise(resolve => {
      this._resolve = resolve;
    });
  }
}

async function simulate(method, url, body = null, headers = {}) {
  const req = new MockRequest(method, url, body, headers);
  const res = new MockResponse();
  const promise = res.waitForResponse();
  handleRequest(req, res);
  req.start();
  return promise;
}

async function runTests() {
  console.log('--- Starting PonyPals Test Suite ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  const prevUser = process.env.ADMIN_USER;
  const prevPass = process.env.ADMIN_PASSWORD;

  try {
    // 0. Default bind host
    console.log('\nTest 0: Localhost binding configuration');
    assert(HOST === '127.0.0.1', `Default bind host is 127.0.0.1 (got ${HOST})`);

    // 1. GET /
    console.log('\nTest 1: Serving Homepage (index.html)');
    const resHome = await simulate('GET', '/');
    assert(resHome.statusCode === 200, 'Home returns status 200');
    assert(resHome.text.includes('PonyPals'), 'Home contains brand name');
    assert(resHome.text.includes('Hampton, Virginia'), 'Home states Hampton, Virginia location');
    assert(resHome.text.includes('specialRequests'), 'Home contains party request input box');
    assert(resHome.text.includes('pkgSelectContainer'), 'Home contains package selector');
    for (const pkgName of ['Pony Party', 'Lesson', 'Pony Play Date', 'Pony Ride', 'Pony Rental for Photos']) {
      assert(resHome.text.includes(pkgName), `Home lists package: ${pkgName}`);
    }
    for (const placeholder of ['Buttercup', 'Starlight', 'Barnaby', 'Peaches', 'Springfield', 'Little Buckaroo', 'Classic Carousel', 'Unicorn Gala', 'Oakwood', 'Meadowbrook', 'Pleasantville', 'Riverside']) {
      assert(!resHome.text.includes(placeholder), `Home has no placeholder: ${placeholder}`);
    }

    // 2. GET /api/ponies
    console.log('\nTest 2: GET /api/ponies');
    const resPonies = await simulate('GET', '/api/ponies');
    assert(resPonies.statusCode === 200, 'Ponies API returns status 200');
    assert(resPonies.json.success === true, 'Ponies API success is true');
    assert(Array.isArray(resPonies.json.ponies) && resPonies.json.ponies.length === 0, 'Placeholder ponies list is empty');

    // 3. GET /api/packages
    console.log('\nTest 3: GET /api/packages');
    const resPackages = await simulate('GET', '/api/packages');
    assert(resPackages.statusCode === 200, 'Packages API returns status 200');
    assert(resPackages.json.packages.length === 5, 'Found 5 packages');
    const pkgPriceById = Object.fromEntries(resPackages.json.packages.map(p => [p.id, p.price]));
    assert(
      pkgPriceById['pony-party'] === 275 &&
      pkgPriceById['lesson'] === 65 &&
      pkgPriceById['pony-play-date'] === 55 &&
      pkgPriceById['pony-ride'] === 35 &&
      pkgPriceById['pony-rental-for-photos'] === 275,
      'All 5 package prices match specification'
    );

    // 4. POST /api/requests (Validation failure test)
    console.log('\nTest 4: POST /api/requests validation errors');
    const resInvalid = await simulate('POST', '/api/requests', {
      parentName: '',
      email: 'not-an-email'
    });
    assert(resInvalid.statusCode === 400, 'Empty required fields return 400');
    assert(resInvalid.json.errors && resInvalid.json.errors.length > 0, 'Returns error list');

    // 5. POST /api/requests (Public Request with Input Box Notes)
    console.log('\nTest 5: POST /api/requests (Booking Request Submission with Custom Input Box)');
    const customRequestText = 'Themed party in Hampton! Looking forward to celebrating with Pony Pals.';
    const bookingPayload = {
      parentName: 'Jennifer Hayes',
      email: 'jennifer.hayes@example.com',
      phone: '(757) 555-0142',
      childName: 'Charlotte',
      childAge: 5,
      eventDate: '2026-12-05',
      eventTime: 'Early afternoon (1 to 3pm)',
      locationAddress: 'Hampton, VA',
      surfaceType: 'Backyard grass',
      estimatedKids: 12,
      packageId: 'pony-party', // $275
      specialRequests: customRequestText
    };

    const resSubmit = await simulate('POST', '/api/requests', bookingPayload);
    assert(resSubmit.statusCode === 201, 'Request created with status 201');
    assert(resSubmit.json.success === true, 'Success flag is true');
    assert(resSubmit.json.booking.id.startsWith('REQ-'), `Generated ID: ${resSubmit.json.booking.id}`);
    assert(resSubmit.json.booking.estimatedTotal === 275, `Estimated total calculated ($275): got $${resSubmit.json.booking.estimatedTotal}`);
    assert(resSubmit.json.booking.specialRequests === customRequestText, 'Special request input text saved accurately');
    const createdId = resSubmit.json.booking.id;

    // 6. Admin fail-closed when ADMIN_PASSWORD is not set
    console.log('\nTest 6: Admin portal fails closed without ADMIN_PASSWORD');
    delete process.env.ADMIN_PASSWORD;
    const resLockedAdmin = await simulate('GET', '/admin');
    assert(resLockedAdmin.statusCode === 503, 'Unconfigured /admin returns 503');
    const resLockedApi = await simulate('GET', '/api/requests');
    assert(resLockedApi.statusCode === 503, 'Unconfigured /api/requests returns 503');

    // Configure admin credentials for remaining auth tests
    process.env.ADMIN_USER = 'owner';
    process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';

    // 7. Unauthenticated admin access is rejected
    console.log('\nTest 7: Unauthenticated admin access control');
    const resUnauthList = await simulate('GET', '/api/requests');
    assert(resUnauthList.statusCode === 401, 'Unauthenticated GET /api/requests returns 401');
    const resUnauthStats = await simulate('GET', '/api/stats');
    assert(resUnauthStats.statusCode === 401, 'Unauthenticated GET /api/stats returns 401');
    const resUnauthPatch = await simulate('PATCH', `/api/requests/${createdId}`, { status: 'Confirmed' });
    assert(resUnauthPatch.statusCode === 401, 'Unauthenticated PATCH /api/requests/:id returns 401');
    const resUnauthDel = await simulate('DELETE', `/api/requests/${createdId}`);
    assert(resUnauthDel.statusCode === 401, 'Unauthenticated DELETE /api/requests/:id returns 401');
    const resUnauthJs = await simulate('GET', '/js/admin.js');
    assert(resUnauthJs.statusCode === 401, 'Unauthenticated GET /js/admin.js returns 401');
    const resLoginPrompt = await simulate('GET', '/admin');
    assert(resLoginPrompt.statusCode === 200 && resLoginPrompt.text.includes('adminLoginForm'), 'Unauthenticated GET /admin shows sign-in form');
    assert(!resLoginPrompt.text.includes('requestsTbody'), 'Unauthenticated GET /admin does not expose admin table');
    const resAdminHtmlRedirect = await simulate('GET', '/admin.html');
    assert(resAdminHtmlRedirect.statusCode === 302 && resAdminHtmlRedirect.headers.Location === '/admin', 'Unauthenticated GET /admin.html redirects to /admin');

    // 8. Admin login, authenticated workflows, and logout
    console.log('\nTest 8: Admin sign-in, authenticated API/dashboard, and sign-out');
    const resBadLogin = await simulate('POST', '/api/admin/login', { username: 'owner', password: 'wrong' });
    assert(resBadLogin.statusCode === 401, 'Wrong password returns 401');

    const resLogin = await simulate('POST', '/api/admin/login', {
      username: 'owner',
      password: 'correct-horse-battery-staple'
    });
    assert(resLogin.statusCode === 200 && resLogin.json.success === true, 'Valid login returns 200');
    const setCookie = resLogin.headers['Set-Cookie'] || '';
    assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), 'Session cookie sets HttpOnly and SameSite=Strict');
    const cookieHeader = setCookie.split(';')[0];

    const resList = await simulate('GET', '/api/requests', null, { cookie: cookieHeader });
    assert(resList.statusCode === 200, 'Authenticated GET /api/requests returns 200');
    const found = resList.json.requests.find(r => r.id === createdId);
    assert(found !== undefined, `Found newly created booking ${createdId} in requests list`);

    const resPatch = await simulate('PATCH', `/api/requests/${createdId}`, { status: 'Confirmed' }, { cookie: cookieHeader });
    assert(resPatch.statusCode === 200, 'Authenticated PATCH updates status with 200');
    assert(resPatch.json.booking.status === 'Confirmed', 'Booking status is now Confirmed');

    const resStats = await simulate('GET', '/api/stats', null, { cookie: cookieHeader });
    assert(resStats.statusCode === 200, 'Authenticated GET /api/stats returns 200');
    assert(resStats.json.confirmed === 1, `Confirmed count is ${resStats.json.confirmed}`);
    assert(resStats.json.revenue === 275, `Confirmed revenue is $${resStats.json.revenue}`);

    const resAdmin = await simulate('GET', '/admin', null, { cookie: cookieHeader });
    assert(resAdmin.statusCode === 200, 'Authenticated admin page returns 200');
    assert(resAdmin.text.includes('Party requests'), 'Authenticated admin page contains dashboard header');
    assert(resAdmin.text.includes('logoutBtn'), 'Authenticated admin page contains sign-out button');

    const resAdminJs = await simulate('GET', '/js/admin.js', null, { cookie: cookieHeader });
    assert(resAdminJs.statusCode === 200, 'Authenticated GET /js/admin.js returns 200');

    const basicHeader = 'Basic ' + Buffer.from('owner:correct-horse-battery-staple').toString('base64');
    const resDel = await simulate('DELETE', `/api/requests/${createdId}`, null, { authorization: basicHeader });
    assert(resDel.statusCode === 200, 'Basic Auth DELETE /api/requests/:id returns 200');

    const resLogout = await simulate('POST', '/api/admin/logout', null, { cookie: cookieHeader });
    assert(resLogout.statusCode === 200 && (resLogout.headers['Set-Cookie'] || '').includes('Max-Age=0'), 'Logout clears session cookie');

    // 9. Front-end consistency checks
    console.log('\nTest 9: Front-end consistency checks');
    const read = p => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf-8');
    const emojiRe = /\p{Extended_Pictographic}/u;
    for (const file of ['index.html', 'admin.html', 'js/app.js', 'js/admin.js']) {
      assert(!emojiRe.test(read(file)), `${file} contains no emoji`);
    }
    assert(!/gradient\(/.test(read('css/style.css').replace(/url\("data:[^"]*"\)/g, '')), 'Stylesheet uses no gradients');
    assert(!read('index.html').includes('\u2014'), 'Homepage copy has no em dashes');

    const idsIn = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    const idsUsed = (js) => [...js.matchAll(/(?:getElementById|\$)\('([^']+)'\)/g)].map(m => m[1]);
    for (const [htmlFile, jsFile] of [['index.html', 'js/app.js'], ['admin.html', 'js/admin.js']]) {
      const have = idsIn(read(htmlFile));
      const missing = idsUsed(read(jsFile)).filter(id => !have.has(id));
      assert(missing.length === 0, `${jsFile} only references ids present in ${htmlFile}${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);
    }

    // 10. Linux .env parsing & precedence checks
    console.log('\nTest 10: Linux .env parsing and precedence');
    const parsedEnv = parseEnvContent(
      '\uFEFF# comment\n' +
      'export ADMIN_USER=ponyowner\n' +
      'PORT=3001 # local port\n' +
      'ADMIN_PASSWORD="my#secret=pass"\n' +
      "SINGLE_QUOTED='hello world'\n"
    );
    assert(parsedEnv.ADMIN_USER === 'ponyowner', 'Parses export prefix and strips UTF-8 BOM');
    assert(parsedEnv.PORT === '3001', 'Strips inline comment from unquoted value');
    assert(parsedEnv.ADMIN_PASSWORD === 'my#secret=pass', 'Preserves # and = inside quoted value');
    assert(parsedEnv.SINGLE_QUOTED === 'hello world', 'Parses single-quoted value');

    const tmpEnvFile = path.join(os.tmpdir(), `ponypals-test-env-${process.pid}.env`);
    fs.writeFileSync(tmpEnvFile, 'PONYPALS_TEST_VAR=from_file\nADMIN_USER=should_not_override\n', 'utf-8');
    delete process.env.PONYPALS_TEST_VAR;
    try {
      loadDotEnv([tmpEnvFile]);
      assert(process.env.PONYPALS_TEST_VAR === 'from_file', 'loadDotEnv loads unset variable from file');
      assert(process.env.ADMIN_USER === 'owner', 'loadDotEnv does not override existing process.env');
    } finally {
      delete process.env.PONYPALS_TEST_VAR;
      try { fs.unlinkSync(tmpEnvFile); } catch (_) {}
    }

    console.log(`\n================================`);
    console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
    console.log(`================================`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Unexpected test error:', err);
    process.exit(1);
  } finally {
    if (prevUser === undefined) delete process.env.ADMIN_USER;
    else process.env.ADMIN_USER = prevUser;
    if (prevPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevPass;
  }
}

runTests();
