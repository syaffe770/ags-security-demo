/**
 * AGS – Advanced Guard Services: security request intake + invoicing (DEMO).
 * Bound to the requests Google Sheet. Deploy steps are in README.md.
 */

// ---- Settings (edit these) ----
// Notification address: set Script Property OWNER_EMAIL (Project Settings → Script Properties).
// It stays private and survives code updates. If unset, the deploying account gets the emails.
var REPLY_PROMISE = 'within 24 hours';
var COMPANY_NAME = 'AGS – Advanced Guard Services';
var PHONE = '(203) 555-0142';
var PUBLIC_EMAIL = 'requests@ags-security.example';
var SHEET_NAME = '';                      // blank = first tab
var TZ = 'America/New_York';
var AUTO_REPLY_DAILY_CAP = 40;            // max confirmation emails to requesters per day
var MAIL_RESERVE = 10;                    // daily sends kept back for owner notifications
var BRAND = '#1e1b3a';

// Pricing: per guard, per hour, with a minimum of billed hours. Keep in sync with RATES in index.html.
var RATE_ARMED = 65;
var RATE_UNARMED = 45;
var MIN_HOURS = 4;
var INVOICE_DUE_DAYS = 15;
var PAYMENT_TERMS = 'Payment due within 15 days. Pay by check to AGS – Advanced Guard Services, ' +
  'or by Zelle to (203) 555-0142. Please include the invoice number.';   // demo placeholder

var HEADERS = ['Timestamp', 'Email', 'Phone', 'Organization', 'Point of Contact', 'Location', 'Event Date',
  'Start', 'End', 'Hours', 'Armed Guards', 'Unarmed Guards', 'Estimate $', 'Details', 'Status',
  'Guard Assigned', 'Owner Notes', 'Invoice #', 'Invoice Sent', 'Invoice Total', 'Request ID'];
var STATUSES = ['New', 'Quoted', 'Booked', 'Invoiced', 'Declined'];
var FIELDS = ['email', 'phone', 'organization', 'contact', 'location', 'eventDate', 'startTime', 'endTime',
  'armedGuards', 'unarmedGuards', 'details', 'requestId'];
var MAX_LEN = 500, MAX_DETAILS = 2000;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- Web app ----

function doGet() {
  return text_('AGS request endpoint is running.');
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.website) return text_('ok'); // honeypot filled: pretend success, store nothing
  var data;
  try {
    data = cleanInput_(p);
    if (validateRequest_(data).length) return text_('invalid');

    var cache = CacheService.getScriptCache();
    var ridKey = data.requestId ? 'rid:' + data.requestId.slice(0, 100) : null;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      notifyOwner_('[AGS] Request NOT saved to sheet (sheet busy)',
        '<p>Please add this request by hand.</p>' + detailsTable_(data));
      return text_('ok'); // the owner has it by email
    }
    try {
      if (ridKey && cache.get(ridKey)) return text_('ok'); // retry of a request already saved
      var sheet = getSheet_();
      ensureHeaders_(sheet);
      appendRecord_(sheet, buildRecord_(data, new Date()));
      if (ridKey) cache.put(ridKey, '1', 21600);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    reportError_(err, p);
    return text_('error');
  }

  // The row is saved; an email problem shouldn't make the requester think it failed.
  try {
    sendNotifications_(data);
  } catch (err) {
    reportError_(err, p);
  }
  return text_('ok');
}

// ---- Input ----

function cleanInput_(p) {
  var d = {};
  FIELDS.forEach(function (k) {
    d[k] = String(p[k] == null ? '' : p[k]).trim().slice(0, k === 'details' ? MAX_DETAILS : MAX_LEN);
  });
  return d;
}

function validateRequest_(d) {
  var errors = [];
  ['email', 'phone', 'organization', 'contact', 'location', 'eventDate', 'startTime', 'endTime']
    .forEach(function (k) { if (!d[k]) errors.push(k + ' is required'); });
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errors.push('email is invalid');
  if (d.phone && d.phone.replace(/\D/g, '').length < 10) errors.push('phone is too short');
  if (d.eventDate && !parseDate_(d.eventDate)) errors.push('eventDate is invalid');
  var s = parseTime_(d.startTime), en = parseTime_(d.endTime);
  if (d.startTime && s === null) errors.push('startTime is invalid');
  if (d.endTime && en === null) errors.push('endTime is invalid');
  if (s !== null && s === en) errors.push('endTime equals startTime');
  var a = count_(d.armedGuards), u = count_(d.unarmedGuards);
  if (isNaN(a) || isNaN(u) || a > 50 || u > 50) errors.push('guard counts are invalid');
  else if (a + u < 1) errors.push('at least one guard is required');
  return errors;
}

function count_(v) {
  v = String(v == null ? '' : v).trim();
  return v === '' ? 0 : /^\d+$/.test(v) ? +v : NaN;
}

// Stop typed text like "=IMPORTXML(...)" from becoming a live formula in the sheet.
function safeCell_(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

// ---- Pricing ----

function priceLines_(armed, unarmed, hours) {
  var billed = Math.max(hours, MIN_HOURS), lines = [];
  if (armed) lines.push({ description: 'Armed security guard', qty: armed, hours: billed, rate: RATE_ARMED,
    amount: armed * RATE_ARMED * billed });
  if (unarmed) lines.push({ description: 'Unarmed security guard', qty: unarmed, hours: billed, rate: RATE_UNARMED,
    amount: unarmed * RATE_UNARMED * billed });
  var total = Math.round(lines.reduce(function (s, l) { return s + l.amount; }, 0) * 100) / 100;
  return { hours: hours, billedHours: billed, minApplied: hours < MIN_HOURS, lines: lines, total: total };
}

function estimateFor_(d) {
  return priceLines_(count_(d.armedGuards), count_(d.unarmedGuards), hoursBetween_(d.startTime, d.endTime));
}

function money_(n) {
  return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function guardsLabel_(armed, unarmed) {
  var parts = [];
  if (armed) parts.push(armed + ' armed');
  if (unarmed) parts.push(unarmed + ' unarmed');
  return parts.join(', ');
}

// ---- Sheet ----

function getSheet_() {
  var ss = SpreadsheetApp.getActive();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function ensureHeaders_(sheet) {
  if (sheet.getLastColumn() === 0 || !sheet.getRange(1, 1, 1, 1).getValues()[0][0]) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function buildRecord_(d, now) {
  return {
    'Timestamp': now,
    'Email': safeCell_(d.email),
    'Phone': safeCell_(d.phone),
    'Organization': safeCell_(d.organization),
    'Point of Contact': safeCell_(d.contact),
    'Location': safeCell_(d.location),
    'Event Date': parseDate_(d.eventDate),
    'Start': formatTime_(d.startTime),
    'End': formatTime_(d.endTime) + (isOvernight_(d.startTime, d.endTime) ? ' (next day)' : ''),
    'Hours': hoursBetween_(d.startTime, d.endTime),
    'Armed Guards': count_(d.armedGuards),
    'Unarmed Guards': count_(d.unarmedGuards),
    'Estimate $': estimateFor_(d).total,
    'Details': safeCell_(d.details),
    'Status': 'New',
    'Request ID': safeCell_(d.requestId)
  };
}

function headerRow_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

// Writes by header name, so reordering columns in the sheet doesn't break anything.
function appendRecord_(sheet, record) {
  sheet.appendRow(headerRow_(sheet).map(function (h) { return h in record ? record[h] : ''; }));
}

function readRecord_(sheet, row) {
  var headers = headerRow_(sheet);
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  var rec = {};
  headers.forEach(function (h, i) { rec[h] = values[i]; });
  return rec;
}

function setCells_(sheet, row, values) {
  var headers = headerRow_(sheet);
  Object.keys(values).forEach(function (h) {
    var i = headers.indexOf(h);
    if (i >= 0) sheet.getRange(row, i + 1).setValue(values[h]);
  });
}

// ---- Email ----

function ownerEmail_() {
  return PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || Session.getEffectiveUser().getEmail();
}

function sendNotifications_(d) {
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < 1) return;
  var urgent = isUrgent_(d, new Date());
  MailApp.sendEmail({
    to: ownerEmail_(),
    replyTo: d.email,
    name: COMPANY_NAME + ' (form)',
    subject: (urgent ? 'URGENT – ' : '') + 'New security request: ' + d.organization + ' – ' + shortDate_(d.eventDate),
    htmlBody: ownerEmailHtml_(d, urgent)
  });
  if (quota - 1 > MAIL_RESERVE && takeAutoReplySlot_(d.email)) {
    MailApp.sendEmail({
      to: d.email,
      replyTo: ownerEmail_(),
      name: COMPANY_NAME,
      subject: 'We received your security request',
      htmlBody: autoReplyHtml_(d)
    });
  }
}

// One auto-reply per address per hour, and a daily cap, so the form can't be used to spam people.
function takeAutoReplySlot_(email) {
  var cache = CacheService.getScriptCache();
  var key = 'ar:' + email.toLowerCase().slice(0, 200);
  if (cache.get(key)) return false;
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var state = JSON.parse(props.getProperty('autoReplies') || '{}');
  if (state.day !== today) state = { day: today, count: 0 };
  if (state.count >= AUTO_REPLY_DAILY_CAP) return false;
  state.count++;
  props.setProperty('autoReplies', JSON.stringify(state));
  cache.put(key, '1', 3600);
  return true;
}

function ownerEmailHtml_(d, urgent) {
  var url = SpreadsheetApp.getActive().getUrl();
  return wrapEmail_(
    (urgent ? '<p style="background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px;margin:0 0 16px">' +
      '<b>Urgent:</b> this event starts within 48 hours.</p>' : '') +
    '<h2 style="margin:0 0 12px;font-size:18px">New request from ' + esc_(d.organization) + '</h2>' +
    detailsTable_(d) +
    '<p style="margin:20px 0 0"><a href="' + esc_(url) + '" style="background:' + BRAND + ';color:#fff;' +
      'padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Open the request sheet</a></p>' +
    '<p style="color:#6b7280;font-size:13px">Reply to this email to answer ' + esc_(d.contact) + ' directly.</p>');
}

function autoReplyHtml_(d) {
  return wrapEmail_(
    '<p>Hi ' + esc_(d.contact) + ',</p>' +
    '<p>We received your request for <b>' + esc_(longDate_(d.eventDate)) + '</b>. ' +
      esc_(COMPANY_NAME) + ' will confirm ' + esc_(REPLY_PROMISE) + '.</p>' +
    detailsTable_(d) +
    '<p style="color:#6b7280;font-size:13px">The estimate is based on the hours and guards you requested. ' +
      'The final price is confirmed by AGS.</p>' +
    '<p>Need us sooner? Call <a href="tel:' + PHONE.replace(/\D/g, '') + '">' + esc_(PHONE) + '</a> or email ' +
      '<a href="mailto:' + esc_(PUBLIC_EMAIL) + '">' + esc_(PUBLIC_EMAIL) + '</a>.</p>' +
    '<p>' + esc_(COMPANY_NAME) + '</p>');
}

function detailsTable_(d) {
  var est = estimateFor_(d);
  var rows = [
    ['Organization', esc_(d.organization)],
    ['Point of contact', esc_(d.contact)],
    ['Email', '<a href="mailto:' + esc_(d.email) + '">' + esc_(d.email) + '</a>'],
    ['Phone', '<a href="tel:' + esc_(d.phone.replace(/[^\d+]/g, '')) + '">' + esc_(d.phone) + '</a>'],
    ['Location', esc_(d.location)],
    ['When', esc_(hoursLabel_(d)) + ' (' + est.hours + ' hrs)'],
    ['Guards', esc_(guardsLabel_(count_(d.armedGuards), count_(d.unarmedGuards)))],
    ['Estimate', '<b>' + money_(est.total) + '</b>' +
      (est.minApplied ? ' (' + MIN_HOURS + '-hour minimum applied)' : '')],
    ['Details', esc_(d.details || '—').replace(/\n/g, '<br>')]
  ];
  return '<table style="border-collapse:collapse;width:100%;font-size:14px">' + rows.map(function (r) {
    return '<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">' + r[0] +
      '</td><td style="padding:6px 0;vertical-align:top">' + r[1] + '</td></tr>';
  }).join('') + '</table>';
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrapEmail_(inner) {
  return '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;' +
    'max-width:560px;line-height:1.5">' + inner + '</div>';
}

function notifyOwner_(subject, html) {
  MailApp.sendEmail({ to: ownerEmail_(), name: COMPANY_NAME + ' (form)', subject: subject, htmlBody: wrapEmail_(html) });
}

function reportError_(err, params) {
  try {
    var raw = Object.keys(params).map(function (k) {
      return '<tr><td style="padding:4px 12px 4px 0;color:#6b7280">' + esc_(k) + '</td><td>' + esc_(params[k]) + '</td></tr>';
    }).join('');
    notifyOwner_('[AGS] Error handling a request',
      '<p>' + esc_(String((err && err.stack) || err)) + '</p><table>' + raw + '</table>');
  } catch (ignored) {
    console.error(err);
  }
}

// ---- Invoices ----

// Price a sheet row. Uses the row's Hours and guard counts, so the owner can
// correct them to what actually happened before invoicing.
function buildInvoice_(rec) {
  var hours = Number(rec['Hours']);
  var armed = Number(rec['Armed Guards']) || 0, unarmed = Number(rec['Unarmed Guards']) || 0;
  if (!(hours > 0)) throw new Error('This row has no Hours. Type the hours worked (for example 5) in its Hours column, then try again.');
  if (armed + unarmed < 1) throw new Error('This row needs at least one armed or unarmed guard before it can be invoiced.');
  if (!rec['Email']) throw new Error('This row has no email address to send the invoice to.');
  return priceLines_(armed, unarmed, hours);
}

function nextInvoiceNumber_(now) {
  var props = PropertiesService.getScriptProperties();
  var seq = Number(props.getProperty('invoiceSeq') || 0) + 1;
  props.setProperty('invoiceSeq', String(seq));
  return 'AGS-' + Utilities.formatDate(now, TZ, 'yyyy').slice(0, 4) + '-' + ('000' + seq).slice(-4);
}

function sendInvoiceForRow_(sheet, row, now) {
  var rec = readRecord_(sheet, row);
  var inv = buildInvoice_(rec);
  if (MailApp.getRemainingDailyQuota() < 2) throw new Error('Daily email limit reached. Try again tomorrow.');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    inv.number = rec['Invoice #'] || nextInvoiceNumber_(now); // re-sending keeps the same number
  } finally {
    lock.releaseLock();
  }
  inv.date = now;
  inv.due = new Date(now.getTime() + INVOICE_DUE_DAYS * 86400000);

  var pdf = Utilities.newBlob(invoiceHtml_(rec, inv), 'text/html', inv.number + '.html')
    .getAs('application/pdf').setName('Invoice ' + inv.number + '.pdf');
  MailApp.sendEmail({
    to: String(rec['Email']),
    bcc: ownerEmail_(),
    replyTo: ownerEmail_(),
    name: COMPANY_NAME,
    subject: 'Invoice ' + inv.number + ' from ' + COMPANY_NAME,
    htmlBody: invoiceEmailHtml_(rec, inv),
    attachments: [pdf]
  });
  setCells_(sheet, row, { 'Invoice #': inv.number, 'Invoice Sent': now, 'Invoice Total': inv.total, 'Status': 'Invoiced' });
  return inv;
}

function cellDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'EEE, MMM d, yyyy') : String(v || '');
}

function invoiceLinesHtml_(inv, cell) {
  return inv.lines.map(function (l) {
    return '<tr><td style="' + cell + '">' + esc_(l.description) + '</td>' +
      '<td style="' + cell + 'text-align:right">' + l.qty + '</td>' +
      '<td style="' + cell + 'text-align:right">' + l.hours + '</td>' +
      '<td style="' + cell + 'text-align:right">' + money_(l.rate) + '</td>' +
      '<td style="' + cell + 'text-align:right">' + money_(l.amount) + '</td></tr>';
  }).join('');
}

// Rendered to PDF by Apps Script, which supports only simple inline CSS and tables.
function invoiceHtml_(rec, inv) {
  var cell = 'padding:8px 6px;border-bottom:1px solid #e5e7eb;';
  var head = 'padding:8px 6px;background:' + BRAND + ';color:#ffffff;font-size:12px;';
  return '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:13px">' +
    '<table style="width:100%"><tr>' +
      '<td><div style="font-size:20px;font-weight:bold;color:' + BRAND + '">' + esc_(COMPANY_NAME) + '</div>' +
        '<div style="color:#4b5563">' + esc_(PHONE) + ' · ' + esc_(PUBLIC_EMAIL) + '</div></td>' +
      '<td style="text-align:right;vertical-align:top"><div style="font-size:24px;font-weight:bold;color:' + BRAND +
        '">INVOICE</div><div>' + esc_(inv.number) + '</div></td>' +
    '</tr></table>' +
    '<table style="width:100%;margin-top:24px"><tr>' +
      '<td style="vertical-align:top;width:50%"><div style="color:#6b7280;font-size:11px">BILL TO</div>' +
        '<div style="font-weight:bold">' + esc_(rec['Organization']) + '</div>' +
        '<div>' + esc_(rec['Point of Contact']) + '</div><div>' + esc_(rec['Email']) + '</div>' +
        '<div>' + esc_(rec['Phone']) + '</div></td>' +
      '<td style="vertical-align:top;text-align:right">' +
        '<div><span style="color:#6b7280">Invoice date:</span> ' + esc_(cellDate_(inv.date)) + '</div>' +
        '<div><span style="color:#6b7280">Due date:</span> ' + esc_(cellDate_(inv.due)) + '</div></td>' +
    '</tr></table>' +
    '<div style="margin-top:20px;padding:10px;background:#f3f4f6">' +
      '<b>Service:</b> ' + esc_(cellDate_(rec['Event Date'])) + ', ' + esc_(rec['Start']) + ' – ' + esc_(rec['End']) +
      '<br><b>Location:</b> ' + esc_(rec['Location']) + '</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-top:20px">' +
      '<tr><td style="' + head + '">Description</td><td style="' + head + 'text-align:right">Guards</td>' +
      '<td style="' + head + 'text-align:right">Hours</td><td style="' + head + 'text-align:right">Rate/hr</td>' +
      '<td style="' + head + 'text-align:right">Amount</td></tr>' +
      invoiceLinesHtml_(inv, cell) +
      '<tr><td colspan="4" style="padding:10px 6px;text-align:right;font-weight:bold">Total due</td>' +
      '<td style="padding:10px 6px;text-align:right;font-weight:bold;font-size:16px">' + money_(inv.total) + '</td></tr>' +
    '</table>' +
    (inv.minApplied ? '<p style="color:#6b7280">A ' + MIN_HOURS + '-hour minimum per guard applies (' + inv.hours +
      ' hours worked).</p>' : '') +
    '<p style="margin-top:24px">' + esc_(PAYMENT_TERMS) + '</p>' +
    '<p>Thank you for choosing ' + esc_(COMPANY_NAME) + '.</p>' +
    '</body></html>';
}

function invoiceEmailHtml_(rec, inv) {
  var cell = 'padding:6px 8px 6px 0;border-bottom:1px solid #e5e7eb;';
  return wrapEmail_(
    '<p>Hi ' + esc_(rec['Point of Contact']) + ',</p>' +
    '<p>Thank you for choosing ' + esc_(COMPANY_NAME) + '. Your invoice <b>' + esc_(inv.number) + '</b> for ' +
      esc_(cellDate_(rec['Event Date'])) + ' is attached.</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' +
      '<tr><td style="' + cell + 'color:#6b7280">Description</td><td style="' + cell + 'color:#6b7280;text-align:right">Guards</td>' +
      '<td style="' + cell + 'color:#6b7280;text-align:right">Hours</td><td style="' + cell + 'color:#6b7280;text-align:right">Rate</td>' +
      '<td style="' + cell + 'color:#6b7280;text-align:right">Amount</td></tr>' +
      invoiceLinesHtml_(inv, cell) +
      '<tr><td colspan="4" style="padding:10px 8px 0 0;text-align:right"><b>Total due</b></td>' +
      '<td style="padding:10px 0 0;text-align:right"><b>' + money_(inv.total) + '</b></td></tr></table>' +
    '<p><b>Due:</b> ' + esc_(cellDate_(inv.due)) + '<br>' + esc_(PAYMENT_TERMS) + '</p>' +
    '<p>Questions? Reply to this email or call ' + esc_(PHONE) + '.</p>' +
    '<p>' + esc_(COMPANY_NAME) + '</p>');
}

// ---- Dates and times ----

function parseDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function parseTime_(s) {
  var m = /^(\d{2}):(\d{2})/.exec(s || '');
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}

function isOvernight_(start, end) {
  var s = parseTime_(start), e = parseTime_(end);
  return s !== null && e !== null && e < s;
}

function hoursBetween_(start, end) {
  var diff = parseTime_(end) - parseTime_(start);
  if (diff <= 0) diff += 1440;
  return Math.round(diff / 60 * 100) / 100;
}

function formatTime_(s) {
  var t = parseTime_(s);
  if (t === null) return '';
  var h = Math.floor(t / 60), m = t % 60;
  return ((h + 11) % 12 + 1) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
}

function shortDate_(s) {
  var d = parseDate_(s);
  return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() : s;
}

function longDate_(s) {
  var d = parseDate_(s);
  return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : s;
}

function hoursLabel_(d) {
  return longDate_(d.eventDate) + ', ' + formatTime_(d.startTime) + ' – ' + formatTime_(d.endTime) +
    (isOvernight_(d.startTime, d.endTime) ? ' (next day)' : '');
}

function isUrgent_(d, now) {
  var date = parseDate_(d.eventDate);
  if (!date) return false;
  date.setMinutes(parseTime_(d.startTime) || 0);
  return date - now < 48 * 3600 * 1000;
}

function text_(s) {
  return ContentService.createTextOutput(s);
}

// ---- Sheet menu ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AGS Demo')
    .addItem('Send invoice for selected row', 'sendInvoice')
    .addSeparator()
    .addItem('Setup sheet', 'setupSheet')
    .addItem('Reset demo data', 'resetDemo')
    .addItem('Send test submission', 'sendTestSubmission')
    .addToUi();
}

function sendInvoice() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getSheet_();
  var range = SpreadsheetApp.getActiveRange();
  var row = range && range.getSheet().getSheetId() === sheet.getSheetId() ? range.getRow() : 0;
  if (row < 2) {
    ui.alert('Click any cell in the request row you want to invoice, then try again.');
    return;
  }
  if (headerRow_(sheet).indexOf('Hours') < 0) {
    ui.alert('The sheet still has the old column layout. Run AGS Demo → Reset demo data, then try again.');
    return;
  }
  var rec = readRecord_(sheet, row), inv;
  try {
    inv = buildInvoice_(rec);
  } catch (err) {
    ui.alert(err.message);
    return;
  }
  var lines = inv.lines.map(function (l) {
    return l.qty + ' × ' + l.description.toLowerCase() + ' × ' + l.hours + ' hrs × ' + money_(l.rate) + ' = ' + money_(l.amount);
  }).join('\n');
  var again = rec['Invoice #'] ? 'Invoice ' + rec['Invoice #'] + ' was already sent. Send it again?\n\n' : '';
  var answer = ui.alert('Send invoice?', again + rec['Organization'] + '\n' + lines + '\nTotal: ' + money_(inv.total) +
    '\n\nTo: ' + rec['Email'] + ' (you get a copy)', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  try {
    var sent = sendInvoiceForRow_(sheet, row, new Date());
    SpreadsheetApp.getActive().toast('Invoice ' + sent.number + ' sent to ' + rec['Email'] + '.', 'AGS Demo', 6);
  } catch (err) {
    ui.alert('Invoice not sent: ' + err.message);
  }
}

function setupSheet() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  var sheet = getSheet_();
  var n = HEADERS.length;
  if (sheet.getMaxColumns() < n) sheet.insertColumnsAfter(sheet.getMaxColumns(), n - sheet.getMaxColumns());
  var maxCols = sheet.getMaxColumns(), rows = sheet.getMaxRows() - 1;

  // Start clean so leftovers from an older column layout don't linger.
  sheet.showColumns(1, maxCols);
  sheet.getRange(1, 1, 1, maxCols).clearContent().clearFormat().clearNote();
  sheet.getRange(2, 1, rows, maxCols).clearDataValidations().clearFormat();

  sheet.getRange(1, 1, 1, n).setValues([HEADERS])
    .setFontWeight('bold').setBackground(BRAND).setFontColor('#ffffff').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  var col = function (name) { return HEADERS.indexOf(name) + 1; };
  var body = function (name) { return sheet.getRange(2, col(name), rows, 1); };

  sheet.getRange(1, col('Hours')).setNote('Scheduled hours. Change to the actual hours worked before sending the invoice.');
  body('Timestamp').setNumberFormat('mmm d, yyyy h:mm AM/PM');
  body('Event Date').setNumberFormat('ddd, mmm d, yyyy');
  body('Invoice Sent').setNumberFormat('mmm d, yyyy');
  body('Hours').setNumberFormat('0.##');
  ['Estimate $', 'Invoice Total'].forEach(function (h) { body(h).setNumberFormat('$#,##0.00'); });
  body('Status').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  ['Location', 'Details', 'Owner Notes'].forEach(function (h) { body(h).setWrap(true); });

  var widths = { 'Timestamp': 160, 'Email': 200, 'Phone': 120, 'Organization': 200, 'Point of Contact': 150,
    'Location': 220, 'Event Date': 140, 'Start': 80, 'End': 120, 'Hours': 60, 'Armed Guards': 100,
    'Unarmed Guards': 110, 'Estimate $': 100, 'Details': 260, 'Status': 100, 'Guard Assigned': 150,
    'Owner Notes': 240, 'Invoice #': 120, 'Invoice Sent': 110, 'Invoice Total': 110 };
  Object.keys(widths).forEach(function (h) { sheet.setColumnWidth(col(h), widths[h]); });
  sheet.hideColumns(col('Request ID'));

  var statusCol = colLetter_(col('Status'));
  var colors = { 'New': '#fef9c3', 'Quoted': '#dbeafe', 'Booked': '#dcfce7', 'Invoiced': '#ede9fe', 'Declined': '#e5e7eb' };
  var all = sheet.getRange(2, 1, rows, n);
  sheet.setConditionalFormatRules(STATUSES.map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + statusCol + '2="' + s + '"')
      .setBackground(colors[s]).setRanges([all]).build();
  }));

  var viewNote = createOpenRequestsView_(ss, sheet)
    ? 'Filter view "Open requests" created (Data → Filter views).'
    : 'Sheets advanced service unavailable: added a basic filter instead.';
  ss.toast('Sheet is set up. ' + viewNote, 'AGS Demo', 8);
}

// Filter view: Status is New or Quoted, soonest event first.
function createOpenRequestsView_(ss, sheet) {
  var range = { sheetId: sheet.getSheetId(), startRowIndex: 0, startColumnIndex: 0, endColumnIndex: HEADERS.length };
  var statusIdx = HEADERS.indexOf('Status');
  var dateIdx = HEADERS.indexOf('Event Date');
  var hidden = ['Booked', 'Invoiced', 'Declined'];
  try {
    var meta = Sheets.Spreadsheets.get(ss.getId(), { fields: 'sheets(properties.sheetId,filterViews(filterViewId,title))' });
    var requests = [];
    meta.sheets.forEach(function (s) {
      (s.filterViews || []).forEach(function (v) {
        if (v.title === 'Open requests') requests.push({ deleteFilterView: { filterId: v.filterViewId } });
      });
    });
    requests.push({ addFilterView: { filter: {
      title: 'Open requests',
      range: range,
      sortSpecs: [{ dimensionIndex: dateIdx, sortOrder: 'ASCENDING' }],
      filterSpecs: [{ columnIndex: statusIdx, filterCriteria: { hiddenValues: hidden } }]
    } } });
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, ss.getId());
    return true;
  } catch (err) {
    if (sheet.getFilter()) sheet.getFilter().remove();
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).createFilter()
      .setColumnFilterCriteria(statusIdx + 1, SpreadsheetApp.newFilterCriteria().setHiddenValues(hidden).build());
    return false;
  }
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---- Demo data ----

function seedDemo() {
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  var now = new Date();
  var day = function (offset) {
    return Utilities.formatDate(new Date(now.getTime() + offset * 86400000), TZ, 'yyyy-MM-dd');
  };
  var samples = [
    { organization: 'Congregation Ohr Shalom', contact: 'Rabbi David Levine', email: 'office@ohrshalom-demo.example',
      phone: '(203) 555-0107', location: '140 Elm Street, New Haven, CT', eventDate: day(2), startTime: '18:00',
      endTime: '23:00', armedGuards: '2', unarmedGuards: '', details: 'Evening services, about 300 attendees. Two entrances.',
      status: 'New', ageHours: 3 },
    { organization: 'Maple Hill Day School', contact: 'Dana Ortiz, administrator', email: 'dortiz@maplehill-demo.example',
      phone: '(860) 555-0118', location: '55 Maple Hill Road, West Hartford, CT', eventDate: day(9), startTime: '07:30',
      endTime: '10:30', armedGuards: '', unarmedGuards: '1', details: 'Front entrance during parent visiting morning.',
      status: 'New', ageHours: 20 },
    { organization: 'Temple Beth Torah Youth Group', contact: 'Sarah Klein', email: 'youth@bethtorah-demo.example',
      phone: '(203) 555-0125', location: '9 Riverside Avenue, Stamford, CT', eventDate: day(5), startTime: '19:00',
      endTime: '23:00', armedGuards: '1', unarmedGuards: '2', details: 'Teen concert in the social hall.',
      status: 'Quoted', notes: 'Sent estimate Tuesday. Waiting to hear back.', ageHours: 50 },
    { organization: 'Greenfield Community Center', contact: 'Mark Feld, events chair', email: 'events@greenfield-demo.example',
      phone: '(203) 555-0133', location: '300 Park Avenue, Bridgeport, CT', eventDate: day(14), startTime: '17:00',
      endTime: '00:30', armedGuards: '2', unarmedGuards: '', details: 'Annual gala, valet out front, runs past midnight.',
      status: 'Booked', guard: 'M. Rivera, J. Chen', notes: 'Deposit received.', ageHours: 96 },
    { organization: 'Kesher Academy', contact: 'Principal Amy Rosen', email: 'arosen@kesher-demo.example',
      phone: '(860) 555-0146', location: '22 Oak Lane, Hamden, CT', eventDate: day(-3), startTime: '08:00',
      endTime: '14:00', armedGuards: '', unarmedGuards: '2', details: 'Science fair.',
      status: 'Booked', guard: 'T. Nguyen, R. Patel', notes: 'Event done. Ready to invoice (select this row → AGS Demo → Send invoice).',
      ageHours: 200 },
    { organization: 'Beth El Men\'s Club', contact: 'Josh Katz', email: 'mensclub@bethel-demo.example',
      phone: '(203) 555-0151', location: '18 Chapel Street, Milford, CT', eventDate: day(-12), startTime: '19:00',
      endTime: '22:00', armedGuards: '1', unarmedGuards: '', details: 'Fundraiser dinner.',
      status: 'Invoiced', guard: 'M. Rivera', invoice: 'AGS-DEMO-0001', invoiceAge: 10, ageHours: 500 },
    { organization: 'Riverside Hall', contact: 'Lena Katz', email: 'lena@riverside-demo.example',
      phone: '(914) 555-0152', location: '18 Hudson Street, Yonkers, NY', eventDate: day(-6), startTime: '16:00',
      endTime: '23:00', armedGuards: '2', unarmedGuards: '', details: 'Wedding reception.',
      status: 'Declined', notes: 'Outside our coverage area (NY).', ageHours: 240 }
  ];
  samples.forEach(function (s, i) {
    var record = buildRecord_(cleanInput_(s), new Date(now.getTime() - s.ageHours * 3600000));
    record['Status'] = s.status;
    record['Guard Assigned'] = s.guard || '';
    record['Owner Notes'] = s.notes || '';
    record['Request ID'] = 'demo-' + (i + 1);
    if (s.invoice) {
      record['Invoice #'] = s.invoice;
      record['Invoice Sent'] = new Date(now.getTime() - s.invoiceAge * 86400000);
      record['Invoice Total'] = record['Estimate $'];
    }
    appendRecord_(sheet, record);
  });
}

function resetDemo() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Reset demo data?',
    'This deletes every row below the header and adds 7 sample requests.', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getMaxColumns()).clearContent();
  setupSheet(); // make sure the columns match this version of the code before adding rows
  seedDemo();
  SpreadsheetApp.getActive().toast('Demo data reset.', 'AGS Demo', 5);
}

function sendTestSubmission() {
  var tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd');
  var result = doPost({ parameter: {
    email: ownerEmail_(), phone: PHONE, organization: 'Test Organization', contact: 'Test Contact',
    location: '1 Test Street, New Haven, CT', eventDate: tomorrow, startTime: '18:00', endTime: '22:00',
    armedGuards: '1', unarmedGuards: '1', details: 'Sent from the AGS Demo menu.',
    requestId: 'test-' + Date.now()
  } }).getContent();
  SpreadsheetApp.getUi().alert('Test submission result: ' + result +
    (result === 'ok' ? '\n\nCheck the sheet for a new row and ' + ownerEmail_() + ' for the emails.' : ''));
}
