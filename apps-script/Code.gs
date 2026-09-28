/**
 * AGS – Advanced Guard Services: security request intake (DEMO).
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

var HEADERS = ['Timestamp', 'Email', 'Phone', 'Organization', 'Point of Contact', 'Location', 'Event Date',
  'Start', 'End', 'Est. Hours', 'Security Type', 'Guards', 'Details', 'Status', 'Quote $',
  'Guard Assigned', 'Owner Notes', 'Request ID'];
var STATUSES = ['New', 'Quoted', 'Booked', 'Declined'];
var FIELDS = ['email', 'phone', 'organization', 'contact', 'location', 'eventDate', 'startTime', 'endTime',
  'securityType', 'guards', 'details', 'requestId'];
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
  d.securityType = d.securityType.split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s === 'Armed' || s === 'Unarmed'; })
    .join(', ');
  return d;
}

function validateRequest_(d) {
  var errors = [];
  ['email', 'phone', 'organization', 'contact', 'location', 'eventDate', 'startTime', 'endTime', 'securityType']
    .forEach(function (k) { if (!d[k]) errors.push(k + ' is required'); });
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errors.push('email is invalid');
  if (d.phone && d.phone.replace(/\D/g, '').length < 10) errors.push('phone is too short');
  if (d.eventDate && !parseDate_(d.eventDate)) errors.push('eventDate is invalid');
  var s = parseTime_(d.startTime), en = parseTime_(d.endTime);
  if (d.startTime && s === null) errors.push('startTime is invalid');
  if (d.endTime && en === null) errors.push('endTime is invalid');
  if (s !== null && s === en) errors.push('endTime equals startTime');
  if (d.guards && !(/^\d+$/.test(d.guards) && +d.guards >= 1 && +d.guards <= 50)) errors.push('guards is invalid');
  return errors;
}

// Stop typed text like "=IMPORTXML(...)" from becoming a live formula in the sheet.
function safeCell_(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
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
    'Est. Hours': hoursBetween_(d.startTime, d.endTime),
    'Security Type': d.securityType,
    'Guards': d.guards ? Number(d.guards) : '',
    'Details': safeCell_(d.details),
    'Status': 'New',
    'Request ID': safeCell_(d.requestId)
  };
}

// Writes by header name, so reordering columns in the sheet doesn't break anything.
function appendRecord_(sheet, record) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(function (h) { return h in record ? record[h] : ''; }));
}

// ---- Email ----

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
    '<p>Need us sooner? Call <a href="tel:' + PHONE.replace(/\D/g, '') + '">' + esc_(PHONE) + '</a> or email ' +
      '<a href="mailto:' + esc_(PUBLIC_EMAIL) + '">' + esc_(PUBLIC_EMAIL) + '</a>.</p>' +
    '<p>' + esc_(COMPANY_NAME) + '</p>');
}

function detailsTable_(d) {
  var rows = [
    ['Organization', esc_(d.organization)],
    ['Point of contact', esc_(d.contact)],
    ['Email', '<a href="mailto:' + esc_(d.email) + '">' + esc_(d.email) + '</a>'],
    ['Phone', '<a href="tel:' + esc_(d.phone.replace(/[^\d+]/g, '')) + '">' + esc_(d.phone) + '</a>'],
    ['Location', esc_(d.location)],
    ['When', esc_(hoursLabel_(d)) + ' (' + hoursBetween_(d.startTime, d.endTime) + ' hrs)'],
    ['Security type', esc_(d.securityType)],
    ['Guards', esc_(d.guards || 'Not sure yet')],
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

function ownerEmail_() {
  return PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || Session.getEffectiveUser().getEmail();
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
    .addItem('Setup sheet', 'setupSheet')
    .addItem('Reset demo data', 'resetDemo')
    .addSeparator()
    .addItem('Send test submission', 'sendTestSubmission')
    .addToUi();
}

function setupSheet() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  var sheet = getSheet_();
  var n = HEADERS.length;
  if (sheet.getMaxColumns() < n) sheet.insertColumnsAfter(sheet.getMaxColumns(), n - sheet.getMaxColumns());
  sheet.getRange(1, 1, 1, n).setValues([HEADERS])
    .setFontWeight('bold').setBackground(BRAND).setFontColor('#ffffff').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  var rows = sheet.getMaxRows() - 1;
  var col = function (name) { return HEADERS.indexOf(name) + 1; };
  var body = function (name) { return sheet.getRange(2, col(name), rows, 1); };

  body('Timestamp').setNumberFormat('mmm d, yyyy h:mm AM/PM');
  body('Event Date').setNumberFormat('ddd, mmm d, yyyy');
  body('Est. Hours').setNumberFormat('0.##');
  body('Quote $').setNumberFormat('$#,##0.00');
  body('Status').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  ['Location', 'Details', 'Owner Notes'].forEach(function (h) { body(h).setWrap(true); });

  var widths = { 'Timestamp': 160, 'Email': 200, 'Phone': 120, 'Organization': 200, 'Point of Contact': 150,
    'Location': 220, 'Event Date': 140, 'Start': 80, 'End': 120, 'Est. Hours': 80, 'Security Type': 120,
    'Guards': 70, 'Details': 280, 'Status': 100, 'Quote $': 100, 'Guard Assigned': 150, 'Owner Notes': 240 };
  Object.keys(widths).forEach(function (h) { sheet.setColumnWidth(col(h), widths[h]); });
  sheet.hideColumns(col('Request ID'));

  var statusCol = colLetter_(col('Status'));
  var colors = { 'New': '#fef9c3', 'Quoted': '#dbeafe', 'Booked': '#dcfce7', 'Declined': '#e5e7eb' };
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
      filterSpecs: [{ columnIndex: statusIdx, filterCriteria: { hiddenValues: ['Booked', 'Declined'] } }]
    } } });
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, ss.getId());
    return true;
  } catch (err) {
    if (sheet.getFilter()) sheet.getFilter().remove();
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).createFilter()
      .setColumnFilterCriteria(statusIdx + 1,
        SpreadsheetApp.newFilterCriteria().setHiddenValues(['Booked', 'Declined']).build());
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
      endTime: '23:00', securityType: 'Armed', guards: '2', details: 'Evening services, about 300 attendees. Two entrances.',
      status: 'New', ageHours: 3 },
    { organization: 'Maple Hill Day School', contact: 'Dana Ortiz, administrator', email: 'dortiz@maplehill-demo.example',
      phone: '(860) 555-0118', location: '55 Maple Hill Road, West Hartford, CT', eventDate: day(9), startTime: '07:30',
      endTime: '15:30', securityType: 'Unarmed', guards: '1', details: 'Front entrance during parent visiting day.',
      status: 'New', ageHours: 20 },
    { organization: 'Temple Beth Torah Youth Group', contact: 'Sarah Klein', email: 'youth@bethtorah-demo.example',
      phone: '(203) 555-0125', location: '9 Riverside Avenue, Stamford, CT', eventDate: day(5), startTime: '19:00',
      endTime: '22:00', securityType: 'Armed, Unarmed', guards: '3', details: 'Teen concert in the social hall.',
      status: 'Quoted', quote: 1260, notes: 'Sent quote Tuesday. Waiting to hear back.', ageHours: 50 },
    { organization: 'Greenfield Community Center', contact: 'Mark Feld, events chair', email: 'events@greenfield-demo.example',
      phone: '(203) 555-0133', location: '300 Park Avenue, Bridgeport, CT', eventDate: day(14), startTime: '17:00',
      endTime: '00:30', securityType: 'Armed', guards: '2', details: 'Annual gala, valet out front, runs past midnight.',
      status: 'Booked', quote: 1450, guard: 'M. Rivera, J. Chen', notes: 'Deposit received.', ageHours: 96 },
    { organization: 'Kesher Academy', contact: 'Principal Amy Rosen', email: 'arosen@kesher-demo.example',
      phone: '(860) 555-0146', location: '22 Oak Lane, Hamden, CT', eventDate: day(20), startTime: '08:00',
      endTime: '14:00', securityType: 'Unarmed', guards: '', details: 'Science fair. Not sure how many guards we need.',
      status: 'Quoted', quote: 540, notes: 'Suggested 1 guard.', ageHours: 30 },
    { organization: 'Riverside Hall', contact: 'Josh Katz', email: 'josh@riverside-demo.example',
      phone: '(914) 555-0151', location: '18 Hudson Street, Yonkers, NY', eventDate: day(-6), startTime: '16:00',
      endTime: '23:00', securityType: 'Armed', guards: '2', details: 'Wedding reception.',
      status: 'Declined', notes: 'Outside our coverage area (NY).', ageHours: 240 }
  ];
  samples.forEach(function (s, i) {
    var record = buildRecord_(cleanInput_(s), new Date(now.getTime() - s.ageHours * 3600000));
    record['Status'] = s.status;
    record['Quote $'] = s.quote || '';
    record['Guard Assigned'] = s.guard || '';
    record['Owner Notes'] = s.notes || '';
    record['Request ID'] = 'demo-' + (i + 1);
    appendRecord_(sheet, record);
  });
}

function resetDemo() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Reset demo data?',
    'This deletes every row below the header and adds 6 sample requests.', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getMaxColumns()).clearContent();
  seedDemo();
  SpreadsheetApp.getActive().toast('Demo data reset.', 'AGS Demo', 5);
}

function sendTestSubmission() {
  var tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), TZ, 'yyyy-MM-dd');
  var result = doPost({ parameter: {
    email: ownerEmail_(), phone: PHONE, organization: 'Test Organization', contact: 'Test Contact',
    location: '1 Test Street, New Haven, CT', eventDate: tomorrow, startTime: '18:00', endTime: '22:00',
    securityType: 'Armed, Unarmed', guards: '2', details: 'Sent from the AGS Demo menu.',
    requestId: 'test-' + Date.now()
  } }).getContent();
  SpreadsheetApp.getUi().alert('Test submission result: ' + result +
    (result === 'ok' ? '\n\nCheck the sheet for a new row and ' + ownerEmail_() + ' for the emails.' : ''));
}
