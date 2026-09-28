# AGS Security Request System: Handoff Spec

**For the Claude building the production version:** this repo is a working demo. Read this whole file first. Then treat the code here as the reference implementation: copy what fits, and change what the *Open questions* section says the owner decides differently. Everything below reflects decisions already made with the owner, and each one gives its reason so you don't reverse it by accident.

- Live demo: https://syaffe770.github.io/ags-security-demo/
- Repo: https://github.com/syaffe770/ags-security-demo

---

## 1. What it does

1. A client fills in a one-page form: contact details, event, date and times, and how many armed and unarmed guards. They see a **live price estimate** as they type.
2. On submit they get an **instant** success screen. The request is saved as a row in a Google Sheet.
3. The owner gets an email about the request, and the client gets a confirmation email with the estimate.
4. The owner manages requests in the Sheet with a status per row: New → Quoted → Booked → Invoiced (or Declined).
5. After the job, the owner corrects the hours if needed and clicks **Send invoice**. The client gets an email with a **PDF invoice** attached, and the row records the invoice number, date, and total.

Everything runs on free tools: GitHub Pages, a Google Sheet, and Apps Script. There's no server, database, or build step.

## 2. Architecture

```
index.html (GitHub Pages) --POST form-urlencoded--> Apps Script web app (doPost)
                                                        |-> appends row to the Google Sheet it's bound to
                                                        |-> MailApp: owner notification + client confirmation
Google Sheet menu "AGS Demo" --> setupSheet / resetDemo / sendInvoice (PDF via Utilities.newBlob().getAs('application/pdf'))
```

| File | Purpose |
|---|---|
| `index.html` | The whole site: inline CSS, a pure-logic `<script id="logic">` block (validation and pricing, testable), and a DOM script. About 30KB, and it makes no external requests. |
| `apps-script/Code.gs` | Script bound to the Sheet: `doPost`, emails, invoice generation, sheet setup, demo data. |
| `apps-script/appsscript.json` | Time zone America/New_York, the Sheets advanced service (for the filter view), and web app settings. |
| `tests/` | Browser-run tests (`python -m http.server 8123`, then open `/tests/`). They load the *real* `index.html` logic and the *real* `Code.gs` with fake Google services. 33 tests. |

**Why these choices:**
- **No Tailwind or build step:** one self-contained HTML file is styled on first paint and has nothing to break.
- **No clasp:** pasting one file into the Apps Script editor is faster than enabling the API and doing another OAuth login.
- **Script bound to the Sheet:** it uses `SpreadsheetApp.getActive()`, so no Sheet ID appears in the code.

## 3. Business rules

| Rule | Value | Where |
|---|---|---|
| Armed guard rate | $65 per guard per hour | `RATES.armed` in `index.html` **and** `RATE_ARMED` in `Code.gs` |
| Unarmed guard rate | $45 per guard per hour | `RATES.unarmed` / `RATE_UNARMED` |
| Minimum | 4 billed hours per guard | `MIN_HOURS` in both files |
| Price formula | `(armed × 65 + unarmed × 45) × max(hours, 4)` | `estimate()` / `priceLines_()` |
| Reply promise | "within 24 hours" | page text + `REPLY_PROMISE` |
| Invoice due | 15 days | `INVOICE_DUE_DAYS` |
| Invoice numbers | `AGS-YYYY-0001`, counter kept in Script Properties; re-sending reuses the number | `nextInvoiceNumber_` |
| Service area | Connecticut (not enforced; owner declines others by hand) | none |

Examples: 2 armed for 3 hours comes to $520 (the minimum applies). 1 armed + 1 unarmed for 5 hours comes to $550. An overnight shift from 10 PM to 6 AM is 8 hours.

A test checks that the browser estimate and the Sheet estimate agree. If you change the rates, change both files.

## 4. The form

Fields, in order:
1. **Email** (required, valid format)
2. **Phone** (required, at least 10 digits)
3. **Organization** (required)
4. **Point of contact** (required; placeholder "e.g. Rabbi, administrator")
5. **Location** (required, street address)
6. **Date needed** (required, not in the past; "today" is computed from **local** time, never `toISOString()`, which is UTC and breaks evenings)
7. **Start and End time** (required, labeled Eastern, 15-minute steps; **end ≤ start means an overnight shift**, shown as "(next day)"; end = start is rejected)
8. **Guards needed:** Armed [ ] and Unarmed [ ], whole numbers 0–50, at least one guard in total
9. **Live estimate box:** a line per guard type and a total, with "4-hour minimum applied" when it applies and "Final price confirmed by AGS"
10. **Details** (optional, up to 2000 characters)
11. **Hidden honeypot** field `website`

Behavior:
- **Errors:** shown inline under each field, plus a live summary, `aria-invalid` on bad fields, and focus moved to the first one. There are no `alert()` popups.
- **Urgent note:** if the event starts within 48 hours, a note says "please also call".
- **Instant success:** on a valid submit, the success screen appears immediately, in about 20ms. It has an animated check, a summary including the estimate, the phone and email, and a "Submit another request" button.
- **Background send:** a normal `fetch(SCRIPT_URL, {method:'POST', body: URLSearchParams})`. It's form-encoded, so there's no CORS preflight, and Apps Script's text responses are readable cross-origin. A status line changes to "✓ Received by our team" only when the server returns `ok`.
- **Failure:** on a failure or a 20-second timeout, a banner says "We may not have received this. Please call…" with a **Try again** button.
- **Request ID:** each submission carries a `crypto.randomUUID()`, and the server ignores repeats for 6 hours, so Try again can't create duplicate rows.
- **Page setup:** `noindex`, an inline SVG favicon (no favicon.ico request), a `<noscript>` fallback, and it works at phone width.

## 5. Server (`Code.gs`)

`doPost`:
1. If the honeypot is filled, return `ok` and store nothing.
2. Clean the input: trim, truncate to 500 characters (Details to 2000), and validate again on the server. If anything is invalid, return `invalid`.
3. **Formula-injection guard:** prefix any value starting with `= + - @` with `'`.
4. `LockService.tryLock(10s)`. If the lock isn't available, email the owner the full request so nothing is lost.
5. Skip the row if the Request ID was already seen. Otherwise append the row **by header name**, so reordering columns in the Sheet is safe.
6. Send emails **after** the row is saved. An email failure still returns `ok`, because the row exists, and the owner gets an error report.
   - **Owner notification:** `replyTo` is the client (the owner just hits Reply). The subject starts with **URGENT** if the event is within 48 hours, and the email links to the Sheet.
   - **Client confirmation:** includes the estimate, sends at most once per address per hour and at most 40 a day, and only while the Gmail quota has at least 10 sends left for the owner. This stops the form from being used to spam people.
7. **Escaping:** all user text is HTML-escaped in every email and in the invoice PDF.

**Owner address:** comes from the Script Property `OWNER_EMAIL`. It is **not in the code**, because the repo is public. If the property is unset, the deploying account gets the emails.

**Sheet columns:** Timestamp · Email · Phone · Organization · Point of Contact · Location · Event Date · Start · End · Hours · Armed Guards · Unarmed Guards · Estimate $ · Details · Status · Guard Assigned · Owner Notes · Invoice # · Invoice Sent · Invoice Total · Request ID (hidden)

**Sheet menu "AGS Demo":**
- **Send invoice for selected row:** validates the row, shows a Yes/No summary, then emails the client an HTML invoice plus a PDF, BCCs the owner, and writes the invoice number, date, and total, setting Status to Invoiced.
- **Setup sheet:** indigo header, frozen row, date and currency formats, a Status dropdown, row colors by status (New yellow, Quoted blue, Booked green, Invoiced purple, Declined gray), an "Open requests" filter view (New and Quoted, soonest first), column widths, and wrapped text.
- **Reset demo data:** asks for confirmation, then loads 7 sample rows. Their dates are relative to today, and they cover every status plus one overnight shift and one row that's ready to invoice.
- **Send test submission.**

## 6. Setup for the real owner

**GitHub (you, their Claude, can do this):**
1. Copy this repo into their account: click "Use this template" on GitHub, or clone it and push to a new repo.
2. Turn on Pages from `main` at `/`.
3. Replace the demo placeholders everywhere:

   | Placeholder | Where it appears |
   |---|---|
   | Company name | `index.html`, `COMPANY_NAME` |
   | Tagline | `index.html` |
   | Phone `(203) 555-0142` | `index.html` (several times), `PHONE`, `PAYMENT_TERMS` |
   | Public email `requests@ags-security.example` | `index.html`, `PUBLIC_EMAIL` |
   | `PAYMENT_TERMS` | `Code.gs` |
   | Footer "Demo site. Not a real company." | `index.html` |
   | `noindex` tag | `index.html`: remove it once the site is real |

**Google (the owner clicks; about 5 minutes, and it must be signed in as them):**
1. Create a Google Sheet, then open **Extensions → Apps Script**.
2. Paste in `Code.gs`. In Project Settings, tick "Show appsscript.json", then paste in `appsscript.json`. Save.
3. In **Project Settings → Script Properties**, add `OWNER_EMAIL` = the address that should get notifications.
4. In the editor, pick `setupSheet` and click **Run**. Authorize it; the "Google hasn't verified this app" screen means **Advanced → Go to project**. Then run `seedDemo` if they want sample rows.
5. **Deploy → New deployment → Web app**, with *Execute as*: Me and *Access*: **Anyone** (not "Anyone with Google account"). Copy the `/exec` URL.
6. Put that URL into `SCRIPT_URL` in `index.html` and push.
7. **Test:** `curl` on `/exec` can show a misleading Google "Page Not Found" page. Test from a browser with `fetch(url).then(r => r.text())`, which should return "AGS request endpoint is running." Then submit the live form once.
8. **Later Code.gs changes:** paste the new code, then **Deploy → Manage deployments → ✏️ → New version**. The URL stays the same.

**Order matters when changing fields:** deploy the new `Code.gs` *before* pushing an `index.html` that sends new field names. Otherwise live submissions are rejected as `invalid` and clients see the "please call" banner.

## 7. Open questions for the owner (decide before going live)

1. **Sales tax:** Connecticut generally taxes security and watchman services (6.35%). Should invoices add a tax line? Check with their accountant.
2. **Which email clients see:** emails come *from* the Google account that deployed the script. For a business address, either deploy from a Google Workspace account on their domain, or set up a Gmail "Send mail as" alias and switch `MailApp` to `GmailApp` with the `from:` option.
3. **Email limits:** consumer Gmail allows about 100 recipients a day, and each request uses up to 2. Google Workspace allows about 1,500.
4. **Payment:** check, Zelle, or a card or online payment link (Stripe Payment Links or Square) on the invoice? Is a deposit required at booking?
5. **When invoices go out:** after the job (current), at booking, or both, meaning a deposit invoice plus a final one?
6. **Pricing edge cases:** holiday or overnight premiums? A different rate for short notice? A per-guard minimum or a per-event one? Travel outside the area?
7. **Business details on the invoice:** mailing address, license number, insurance line, logo.
8. **Status emails:** automatically email the client when a row is marked Booked or Declined, using an installable `onEdit` trigger?
9. **Recurring coverage:** synagogues often need guards every Shabbat. Should the form support weekly requests?
10. **Domain:** a custom domain on GitHub Pages instead of `github.io`?
11. **Records:** save a copy of each invoice PDF to a Drive folder? This adds the Drive permission scope. Right now the BCC copy to the owner is the record.

## 8. Deliberately left out (for a demo)

Logins, a database, an admin dashboard, online payments, a CAPTCHA, analytics, and end-to-end browser test frameworks. The Sheet *is* the admin tool. Add any of these only if the owner asks.
