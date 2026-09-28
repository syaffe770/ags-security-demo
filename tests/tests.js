// Loads the real browser logic from ../index.html and the real ../apps-script/Code.gs
// (with fake Google services) and checks them. Open tests/index.html via a local server.
var results = [];

function test(name, fn) {
  try { fn(); results.push({ name: name, ok: true }); }
  catch (e) { results.push({ name: name, ok: false, msg: e.message }); }
}
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ', got ' + a);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

function isoOffset(days) {
  var d = new Date(Date.now() + days * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function validForm() {
  return { email: 'a@b.co', phone: '(203) 555-0142', organization: 'Org', contact: 'Rabbi X', location: '1 Main St',
    eventDate: '2026-10-12', startTime: '18:00', endTime: '23:00', armedGuards: '1', unarmedGuards: '', details: '' };
}

function validPost(extra) {
  return Object.assign({ email: 'req@example.com', phone: '203-555-0142', organization: 'Org', contact: 'Rabbi X',
    location: '1 Main St', eventDate: isoOffset(10), startTime: '18:00', endTime: '23:00',
    armedGuards: '1', unarmedGuards: '1', details: 'hi', requestId: 'r-' + Math.random() }, extra || {});
}

// Fake Apps Script services, recording what the script does.
function makeServer(gs, opts) {
  opts = opts || {};
  var env = { rows: [], sent: [], cache: {}, props: Object.assign({ OWNER_EMAIL: 'owner@example.com' }, opts.props) };
  var sheet = {
    getLastColumn: function () { return env.rows[0] ? env.rows[0].length : 0; },
    getLastRow: function () { return env.rows.length; },
    getRange: function (r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        setValue: function (v) { env.rows[r - 1][c - 1] = v; return this; },
        getValues: function () {
          var out = [];
          for (var i = 0; i < nr; i++) out.push((env.rows[r - 1 + i] || []).slice(c - 1, c - 1 + nc));
          return out;
        },
        setValues: function (v) { v.forEach(function (row, i) { env.rows[r - 1 + i] = row.slice(); }); return this; }
      };
    },
    appendRow: function (row) { env.rows.push(row); }
  };
  var services = {
    SpreadsheetApp: { getActive: function () {
      return { getSheets: function () { return [sheet]; }, getSheetByName: function () { return sheet; },
        getUrl: function () { return 'https://docs.google.com/spreadsheets/d/x'; } };
    } },
    MailApp: {
      getRemainingDailyQuota: function () { return opts.quota == null ? 100 : opts.quota; },
      sendEmail: function (o) { if (opts.mailThrows) throw new Error('quota'); env.sent.push(o); }
    },
    LockService: { getScriptLock: function () {
      return { tryLock: function () { return opts.lock !== false; }, waitLock: function () {}, releaseLock: function () {} };
    } },
    CacheService: { getScriptCache: function () {
      return { get: function (k) { return env.cache[k] || null; }, put: function (k, v) { env.cache[k] = v; } };
    } },
    PropertiesService: { getScriptProperties: function () {
      return { getProperty: function (k) { return env.props[k] == null ? null : env.props[k]; },
        setProperty: function (k, v) { env.props[k] = v; } };
    } },
    Utilities: {
      formatDate: function (d) { return isoOffset((d - Date.now()) / 86400000); },
      newBlob: function (html) {
        return { getAs: function () { return { html: html, setName: function (n) { this.name = n; return this; } }; } };
      }
    },
    ContentService: { createTextOutput: function (s) { return { getContent: function () { return s; } }; } },
    Session: { getEffectiveUser: function () { return { getEmail: function () { return 'deployer@example.com'; } }; } },
    Sheets: undefined,
    console: console
  };
  var names = Object.keys(services);
  var api = new Function(names.join(','), gs +
    '\nreturn {doPost:doPost, cleanInput_:cleanInput_, validateRequest_:validateRequest_, safeCell_:safeCell_,' +
    ' buildRecord_:buildRecord_, isUrgent_:isUrgent_, HEADERS:HEADERS, ownerEmail_:ownerEmail_,' +
    ' buildInvoice_:buildInvoice_, sendInvoiceForRow_:sendInvoiceForRow_, readRecord_:readRecord_};')
    .apply(null, names.map(function (n) { return services[n]; }));
  env.api = api;
  env.sheet = sheet;
  env.post = function (params) { return api.doPost({ parameter: params }).getContent(); };
  env.record = function (i) {
    var h = env.rows[0], r = env.rows[i], o = {};
    h.forEach(function (k, j) { o[k] = r[j]; });
    return o;
  };
  return env;
}

(async function run() {
  var html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  var AGS = new Function(/<script id="logic">([\s\S]*?)<\/script>/.exec(html)[1] + '\nreturn AGS;')();
  var gs = await (await fetch('../apps-script/Code.gs', { cache: 'no-store' })).text();
  var now = new Date(2026, 8, 27, 12, 0);

  // ---- Browser form logic ----
  test('valid form has no errors', function () { eq(AGS.validate(validForm(), now), {}); });

  test('empty form flags every required field', function () {
    eq(Object.keys(AGS.validate({}, now)).sort(),
      ['contact', 'email', 'endTime', 'eventDate', 'guards', 'location', 'organization', 'phone', 'startTime']);
  });

  test('bad email and short phone are rejected', function () {
    var e = AGS.validate(Object.assign(validForm(), { email: 'nope@x', phone: '555-0142' }), now);
    ok(e.email && e.phone);
  });

  test('today is allowed late in the evening (no UTC shift)', function () {
    var late = new Date(2026, 8, 27, 23, 30);
    eq(AGS.validate(Object.assign(validForm(), { eventDate: '2026-09-27' }), late), {});
  });

  test('past dates are rejected', function () {
    ok(AGS.validate(Object.assign(validForm(), { eventDate: '2026-09-26' }), now).eventDate);
  });

  test('overnight shift is allowed and detected', function () {
    var d = Object.assign(validForm(), { startTime: '22:00', endTime: '06:00' });
    eq(AGS.validate(d, now), {});
    ok(AGS.isOvernight('22:00', '06:00'));
    eq(AGS.hoursBetween('17:00', '00:30'), 7.5);
  });

  test('equal start and end is rejected', function () {
    ok(AGS.validate(Object.assign(validForm(), { startTime: '18:00', endTime: '18:00' }), now).endTime);
  });

  test('guards: at least one, whole numbers 0-50', function () {
    ok(AGS.validate(Object.assign(validForm(), { armedGuards: '', unarmedGuards: '' }), now).guards);
    ok(AGS.validate(Object.assign(validForm(), { armedGuards: '0', unarmedGuards: '0' }), now).guards);
    ok(AGS.validate(Object.assign(validForm(), { armedGuards: '1.5' }), now).guards);
    ok(AGS.validate(Object.assign(validForm(), { armedGuards: '51' }), now).guards);
    eq(AGS.validate(Object.assign(validForm(), { armedGuards: '', unarmedGuards: '3' }), now), {});
  });

  test('estimate: $65 armed, $45 unarmed, per guard per hour', function () {
    var e = AGS.estimate('1', '1', '18:00', '23:00');
    eq(e.total, 550); eq(e.billedHours, 5); ok(!e.minApplied);
    eq(AGS.estimate('2', '', '19:00', '22:00').total, 520, '4-hour minimum');
    ok(AGS.estimate('2', '', '19:00', '22:00').minApplied);
    eq(AGS.estimate('', '2', '17:00', '00:30').total, 675, 'overnight 7.5h');
    eq(AGS.estimate('', '', '18:00', '23:00'), null);
    eq(AGS.estimate('1', '', '', '23:00'), null);
  });

  test('money and guard labels', function () {
    eq(AGS.money(1234.5), '$1,234.50');
    eq(AGS.money(45), '$45.00');
    eq(AGS.guardsLabel('2', '1'), '2 armed, 1 unarmed');
    eq(AGS.guardsLabel('', '3'), '3 unarmed');
  });

  test('urgency is within 48 hours of start', function () {
    ok(AGS.isUrgent('2026-09-28', '18:00', now));
    ok(!AGS.isUrgent('2026-10-02', '18:00', now));
  });

  test('time and date formatting', function () {
    eq(AGS.formatTime('00:30'), '12:30 AM');
    eq(AGS.formatTime('18:00'), '6:00 PM');
    eq(AGS.formatHours('2026-10-12', '22:00', '02:00'), 'Mon, Oct 12, 2026, 10:00 PM – 2:00 AM (next day)');
  });

  // ---- Apps Script ----
  test('honeypot: nothing saved, nothing sent', function () {
    var s = makeServer(gs);
    eq(s.post(validPost({ website: 'spam.com' })), 'ok');
    eq(s.rows.length, 0); eq(s.sent.length, 0);
  });

  test('valid request: headers + one row with Status New, two emails', function () {
    var s = makeServer(gs);
    eq(s.post(validPost()), 'ok');
    eq(s.rows[0], s.api.HEADERS);
    eq(s.rows.length, 2);
    var r = s.record(1);
    eq(r['Status'], 'New'); eq(r['Hours'], 5); eq(r['Armed Guards'], 1); eq(r['Unarmed Guards'], 1);
    eq(r['Estimate $'], 550);
    ok(s.sent[1].htmlBody.indexOf('$550.00') >= 0, 'estimate in confirmation email');
    eq(s.sent.length, 2);
    eq(s.sent[0].to, 'owner@example.com'); eq(s.sent[0].replyTo, 'req@example.com');
    eq(s.sent[1].to, 'req@example.com');
  });

  test('formula text is stored as plain text', function () {
    var s = makeServer(gs);
    s.post(validPost({ organization: '=IMPORTXML("http://x","//a")', phone: '+1 203 555 0142' }));
    eq(s.record(1)['Organization'], '\'=IMPORTXML("http://x","//a")');
    eq(s.record(1)['Phone'], "'+1 203 555 0142");
  });

  test('HTML in fields is escaped in the owner email', function () {
    var s = makeServer(gs);
    s.post(validPost({ details: '<script>alert(1)</script>' }));
    ok(s.sent[0].htmlBody.indexOf('<script>') < 0, 'raw script tag in email');
    ok(s.sent[0].htmlBody.indexOf('&lt;script&gt;') >= 0);
  });

  test('retry with same request ID does not duplicate the row', function () {
    var s = makeServer(gs), p = validPost();
    eq(s.post(p), 'ok'); eq(s.post(p), 'ok');
    eq(s.rows.length, 2);
  });

  test('invalid request is dropped', function () {
    var s = makeServer(gs);
    eq(s.post(validPost({ email: 'bad' })), 'invalid');
    eq(s.post(validPost({ armedGuards: '0', unarmedGuards: '' })), 'invalid');
    eq(s.post(validPost({ armedGuards: 'lots' })), 'invalid');
    eq(s.rows.length, 0);
  });

  test('over-long fields are truncated', function () {
    var s = makeServer(gs);
    s.post(validPost({ location: 'x'.repeat(900) }));
    eq(s.record(1)['Location'].length, 500);
  });

  test('owner email falls back to the deploying account', function () {
    var s = makeServer(gs, { props: { OWNER_EMAIL: '' } });
    s.post(validPost());
    eq(s.sent[0].to, 'deployer@example.com');
  });

  test('sheet busy: owner gets the request by email', function () {
    var s = makeServer(gs, { lock: false });
    eq(s.post(validPost()), 'ok');
    eq(s.rows.length, 0); eq(s.sent.length, 1);
    ok(/NOT saved/.test(s.sent[0].subject));
  });

  test('low mail quota: owner notified, no auto-reply', function () {
    var s = makeServer(gs, { quota: 5 });
    s.post(validPost());
    eq(s.sent.length, 1); eq(s.sent[0].to, 'owner@example.com');
  });

  test('one auto-reply per address per hour', function () {
    var s = makeServer(gs);
    s.post(validPost()); s.post(validPost());
    eq(s.sent.filter(function (m) { return m.to === 'req@example.com'; }).length, 1);
  });

  test('daily auto-reply cap', function () {
    var s = makeServer(gs, { props: { autoReplies: JSON.stringify({ day: isoOffset(0), count: 40 }) } });
    s.post(validPost());
    eq(s.sent.length, 1);
  });

  test('urgent requests are flagged in the subject', function () {
    var s = makeServer(gs);
    s.post(validPost({ eventDate: isoOffset(1) }));
    ok(/^URGENT/.test(s.sent[0].subject), s.sent[0].subject);
    var s2 = makeServer(gs);
    s2.post(validPost());
    ok(!/^URGENT/.test(s2.sent[0].subject));
  });

  test('email failure still saves the row and returns ok', function () {
    var s = makeServer(gs, { mailThrows: true });
    eq(s.post(validPost()), 'ok');
    eq(s.rows.length, 2);
  });

  test('overnight end is labeled next day', function () {
    var s = makeServer(gs);
    s.post(validPost({ startTime: '22:00', endTime: '02:00' }));
    eq(s.record(1)['End'], '2:00 AM (next day)'); eq(s.record(1)['Hours'], 4);
  });

  test('browser estimate matches the sheet estimate', function () {
    [['2', '', '19:00', '22:00'], ['1', '3', '22:00', '06:00'], ['', '1', '07:30', '15:45']].forEach(function (c) {
      var s = makeServer(gs);
      s.post(validPost({ armedGuards: c[0], unarmedGuards: c[1], startTime: c[2], endTime: c[3] }));
      eq(s.record(1)['Estimate $'], AGS.estimate(c[0], c[1], c[2], c[3]).total, c.join(' '));
    });
  });

  // ---- Invoices ----
  function invoicedServer() {
    var s = makeServer(gs);
    s.post(validPost({ armedGuards: '2', unarmedGuards: '', startTime: '19:00', endTime: '22:00' }));
    s.sent.length = 0;
    return s;
  }

  test('invoice: priced from the row, emailed with PDF, row marked Invoiced', function () {
    var s = invoicedServer();
    var inv = s.api.sendInvoiceForRow_(s.sheet, 2, new Date());
    eq(inv.total, 520);
    ok(/^AGS-\d{4}-0001$/.test(inv.number), inv.number);
    eq(s.sent.length, 1);
    var m = s.sent[0];
    eq(m.to, 'req@example.com'); eq(m.bcc, 'owner@example.com');
    ok(m.subject.indexOf(inv.number) >= 0);
    eq(m.attachments[0].name, 'Invoice ' + inv.number + '.pdf');
    ok(m.attachments[0].html.indexOf('$520.00') >= 0, 'total in PDF');
    ok(m.attachments[0].html.indexOf('4-hour minimum') >= 0, 'minimum noted');
    var r = s.record(1);
    eq(r['Status'], 'Invoiced'); eq(r['Invoice #'], inv.number); eq(r['Invoice Total'], 520);
  });

  test('invoice uses corrected hours; numbers increase; resend keeps number', function () {
    var s = invoicedServer();
    s.post(validPost({ email: 'second@example.com' }));
    var hoursCol = s.rows[0].indexOf('Hours');
    s.rows[1][hoursCol] = 6; // owner corrects to actual hours worked
    var first = s.api.sendInvoiceForRow_(s.sheet, 2, new Date());
    eq(first.total, 780);
    var second = s.api.sendInvoiceForRow_(s.sheet, 3, new Date());
    ok(/-0002$/.test(second.number), second.number);
    eq(s.api.sendInvoiceForRow_(s.sheet, 2, new Date()).number, first.number);
  });

  test('invoice refuses rows without guards or hours', function () {
    var s = invoicedServer();
    var col = function (h) { return s.rows[0].indexOf(h); };
    s.rows[1][col('Armed Guards')] = 0;
    var threw = false;
    try { s.api.sendInvoiceForRow_(s.sheet, 2, new Date()); } catch (e) { threw = /guard/.test(e.message); }
    ok(threw, 'no guards');
    s.rows[1][col('Armed Guards')] = 2; s.rows[1][col('Hours')] = '';
    threw = false;
    try { s.api.sendInvoiceForRow_(s.sheet, 2, new Date()); } catch (e) { threw = /Hours/.test(e.message); }
    ok(threw, 'no hours');
    eq(s.sent.length, 0);
  });

  test('invoice PDF escapes sheet text', function () {
    var s = makeServer(gs);
    s.post(validPost({ organization: '<b>Evil</b> Org' }));
    s.sent.length = 0;
    s.api.sendInvoiceForRow_(s.sheet, 2, new Date());
    ok(s.sent[0].attachments[0].html.indexOf('<b>Evil</b>') < 0);
  });

  // ---- Page budget ----
  test('index.html is under 50KB and loads nothing external', function () {
    ok(new Blob([html]).size < 50 * 1024, 'size ' + new Blob([html]).size);
    ok(!/<(script|link)[^>]+(src|href)="https?:/i.test(html), 'external resource found');
  });

  var out = document.getElementById('out');
  results.forEach(function (r) {
    var li = document.createElement('li');
    li.className = r.ok ? 'pass' : 'fail';
    li.textContent = (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.msg ? ' – ' + r.msg : '');
    out.appendChild(li);
  });
  var failed = results.filter(function (r) { return !r.ok; }).length;
  document.getElementById('summary').textContent =
    (results.length - failed) + '/' + results.length + ' passed' + (failed ? ' – ' + failed + ' FAILED' : '');
  window.testResults = { total: results.length, failed: failed, results: results };
})().catch(function (e) {
  document.getElementById('summary').textContent = 'Test runner crashed: ' + e.message;
  window.testResults = { crashed: e.message };
});
