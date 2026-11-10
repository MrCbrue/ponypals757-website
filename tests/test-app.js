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

const { handleRequest } = require('../server.js');

class MockRequest extends EventEmitter {
  constructor(method, url, body = null, headers = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: 'localhost:3000', ...headers };
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

async function simulate(method, url, body = null) {
  const req = new MockRequest(method, url, body);
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

  try {
    // 1. GET /
    console.log('\nTest 1: Serving Homepage (index.html)');
    const resHome = await simulate('GET', '/');
    assert(resHome.statusCode === 200, 'Home returns status 200');
    assert(resHome.text.includes('PonyPals'), 'Home contains brand name');
    assert(resHome.text.includes('specialRequests'), 'Home contains party request input box');
    assert(resHome.text.includes('pkgSelectContainer'), 'Home contains package selector');

    // 2. GET /api/ponies
    console.log('\nTest 2: GET /api/ponies');
    const resPonies = await simulate('GET', '/api/ponies');
    assert(resPonies.statusCode === 200, 'Ponies API returns status 200');
    assert(resPonies.json.success === true, 'Ponies API success is true');
    assert(resPonies.json.ponies.length >= 4, `Ponies count is ${resPonies.json.ponies.length}`);
    const buttercup = resPonies.json.ponies.find(p => p.name === 'Buttercup');
    assert(buttercup && buttercup.maxRiderWeight === 65, 'Buttercup profile loaded with rider weight');

    // 3. GET /api/packages
    console.log('\nTest 3: GET /api/packages');
    const resPackages = await simulate('GET', '/api/packages');
    assert(resPackages.statusCode === 200, 'Packages API returns status 200');
    assert(resPackages.json.packages.length === 3, 'Found 3 packages');
    assert(resPackages.json.addOns.length >= 4, 'Found add-ons');

    // 4. POST /api/requests (Validation failure test)
    console.log('\nTest 4: POST /api/requests validation errors');
    const resInvalid = await simulate('POST', '/api/requests', {
      parentName: '',
      email: 'not-an-email'
    });
    assert(resInvalid.statusCode === 400, 'Empty required fields return 400');
    assert(resInvalid.json.errors && resInvalid.json.errors.length > 0, 'Returns error list');

    // 5. POST /api/requests (Full Party Request with Input Box Notes)
    console.log('\nTest 5: POST /api/requests (Party Request Submission with Custom Input Box)');
    const customRequestText = 'Charlotte is turning 5! She loves pink unicorns and apples. Can handler please wear flower crown? Wide side yard gate is ready.';
    const bookingPayload = {
      parentName: 'Jennifer Hayes',
      email: 'jennifer.hayes@example.com',
      phone: '(555) 421-9988',
      childName: 'Charlotte',
      childAge: 5,
      eventDate: '2026-12-05',
      eventTime: 'Early Afternoon (1:00 PM - 3:00 PM)',
      locationAddress: '88 Whispering Pines Way, Meadowbrook',
      surfaceType: 'Backyard Lawn (Grass)',
      estimatedKids: 14,
      packageId: 'carousel', // $385
      selectedPonies: ['Buttercup', 'Starlight'],
      addOns: ['unicorn-makeover'], // +$45
      specialRequests: customRequestText
    };

    const resSubmit = await simulate('POST', '/api/requests', bookingPayload);
    assert(resSubmit.statusCode === 201, 'Request created with status 201');
    assert(resSubmit.json.success === true, 'Success flag is true');
    assert(resSubmit.json.booking.id.startsWith('REQ-'), `Generated ID: ${resSubmit.json.booking.id}`);
    assert(resSubmit.json.booking.estimatedTotal === 430, `Estimated total calculated ($385 + $45 = $430): got $${resSubmit.json.booking.estimatedTotal}`);
    assert(resSubmit.json.booking.specialRequests === customRequestText, 'Special request input text saved accurately');
    const createdId = resSubmit.json.booking.id;

    // 6. GET /api/requests (Confirm request is in list)
    console.log('\nTest 6: GET /api/requests (Verify persistence)');
    const resList = await simulate('GET', '/api/requests');
    assert(resList.statusCode === 200, 'Requests list returns 200');
    const found = resList.json.requests.find(r => r.id === createdId);
    assert(found !== undefined, `Found newly created booking ${createdId} in requests list`);

    // 7. PATCH /api/requests/:id (Owner updates status to Confirmed)
    console.log('\nTest 7: PATCH /api/requests/:id');
    const resPatch = await simulate('PATCH', `/api/requests/${createdId}`, { status: 'Confirmed' });
    assert(resPatch.statusCode === 200, 'Status updated with 200');
    assert(resPatch.json.booking.status === 'Confirmed', 'Booking status is now Confirmed');

    // 8. GET /api/stats (Verify stats calculation)
    console.log('\nTest 8: GET /api/stats');
    const resStats = await simulate('GET', '/api/stats');
    assert(resStats.statusCode === 200, 'Stats returned 200');
    assert(resStats.json.confirmed >= 1, `Confirmed count is ${resStats.json.confirmed}`);
    assert(resStats.json.revenue >= 430, `Confirmed revenue is $${resStats.json.revenue}`);

    // 9. GET /admin
    console.log('\nTest 9: Admin portal route (admin.html)');
    const resAdmin = await simulate('GET', '/admin');
    assert(resAdmin.statusCode === 200, 'Admin page returns 200');
    assert(resAdmin.text.includes('Party requests'), 'Admin page contains header');

    // 10. Design guardrails + script/markup consistency
    console.log('\nTest 10: Front-end consistency checks');
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

    console.log(`\n================================`);
    console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
    console.log(`================================`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Unexpected test error:', err);
    process.exit(1);
  }
}

runTests();
