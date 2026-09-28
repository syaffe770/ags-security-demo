# AGS Security Request Form (demo)

A one-page request form for "AGS – Advanced Guard Services", with a live price estimate. It's hosted on GitHub Pages. Each request becomes a row in a Google Sheet and emails the owner. After the job, the owner sends the client an invoice (with a PDF) straight from the Sheet.

See [HANDOFF.md](HANDOFF.md) for the full spec for building the real version.

- `index.html`: the whole site, with inline CSS and JS, no build step.
- `apps-script/Code.gs` and `appsscript.json`: the Sheet's script (saves rows, sends emails and invoices, adds the "AGS Demo" menu).
- `tests/`: open `tests/index.html` through a local server to run the tests.

## Where to change things

| To change | Edit |
|---|---|
| Company name, tagline, phone, public email, page headings, field labels/questions | `index.html` (text in the HTML; phone and email appear several times) |
| Validation messages or rules | `index.html`, the `<script id="logic">` block |
| Where notifications go | Script Property `OWNER_EMAIL` (see below) |
| Reply promise, company name/phone in emails | top of `apps-script/Code.gs` |
| Rates ($65 armed, $45 unarmed) and 4-hour minimum | **both** `RATES`/`MIN_HOURS` in `index.html` and `RATE_*`/`MIN_HOURS` in `Code.gs` |
| Invoice payment terms and due days | `PAYMENT_TERMS`, `INVOICE_DUE_DAYS` in `Code.gs` |
| Sheet columns | `HEADERS` in `Code.gs`, then **AGS Demo → Setup sheet** |

Changes to `index.html` go live about a minute after pushing to GitHub. Changes to `Code.gs` must also be pasted into the Apps Script editor and redeployed (step 7 below).

## One-time setup

1. Open the Google Sheet, then go to **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs`. In **Project Settings**, tick *Show "appsscript.json" manifest file*, then replace that file with `apps-script/appsscript.json`. Save.
3. **Deploy → New deployment → Web app**. Set *Execute as*: Me and *Who has access*: Anyone. Click Deploy and authorize.
   If Google says it hasn't verified the app, choose **Advanced → Go to (project name)**. This is expected for your own script.
4. Copy the web app URL (it ends in `/exec`) into `SCRIPT_URL` near the bottom of `index.html`, then push to GitHub.
   Until then the page runs in demo mode: the form works, but nothing is sent.
5. In **Project Settings → Script Properties**, add `OWNER_EMAIL` with the address that should receive the notifications.
6. Reload the Sheet. Use **AGS Demo → Setup sheet**, then **AGS Demo → Reset demo data**, then **Send test submission**.

## Sending an invoice

1. After the job, open the row and correct **Hours** (and the guard counts) to what actually happened.
2. Click any cell in that row, then **AGS Demo → Send invoice for selected row**.
3. Check the summary and click **Yes**. The client gets an email with the invoice PDF attached, and you get a copy (BCC). The row fills in Invoice #, Invoice Sent, and Invoice Total, and its Status changes to **Invoiced**.

Invoice numbers run `AGS-2026-0001`, `AGS-2026-0002`, and so on. Sending again for the same row reuses its number.

## Redeploying after a Code.gs change

7. Paste the new code into the editor and save. Then **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same.

## Changing the notification email

Change the `OWNER_EMAIL` Script Property (Project Settings → Script Properties). It takes effect right away, with no redeploy needed. It's kept out of this public repo on purpose. If it's not set, the account that deployed the script gets the emails.

## Good to know

- **Emails are sent *from* the Google account that deployed the script,** whatever `OWNER_EMAIL` says.
- **Handing this off to the real owner:** they make a copy of the Sheet (the script comes with it) and do steps 2–6 from their own account. That produces a new web app URL for `SCRIPT_URL`.
- **Keep the Sheet private.** It holds requesters' names, phones, and addresses.
- **Email limits:** consumer Gmail allows about 100 emails a day, and each request sends up to 2. Requester confirmations are capped at 40 a day and one per address per hour. Rows are always saved, even when no email goes out.
- **Changing the column layout:** after pasting a new `Code.gs`, run **Setup sheet**, then **Reset demo data**. Old rows won't line up with the new columns.
- **Filter view:** "Open requests" (Data → Filter views) shows New and Quoted requests, soonest event first. If the Sheets advanced service isn't available, setup adds a basic filter instead.
- **Spam protection:** a hidden honeypot field, plus the email caps above.

## Running the tests

```bash
python -m http.server 8123
```

Then open `http://localhost:8123/tests/`.
