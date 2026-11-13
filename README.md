# BITE AND MELT – Cafe Billing & POS

Mobile-first billing system for BITE AND MELT, Navsari, Gujarat. Sky-blue / yellow / white theme, ₹ currency, Asia/Kolkata time.

* **Server**: Node.js 22.5+ with no npm packages (built-in SQLite). One folder, nothing to install.
* **App**: plain HTML/CSS/JS web app (installable PWA) + a small **Android wrapper** (`android/`) that adds direct Bluetooth printing.
* **Data**: one SQLite file at `data/bitemelt.db` on *your server*. This is cloud storage only if you host the server in the cloud (see `docs/DEPLOY.md`), and backups are your responsibility (see `docs/BACKUP_RECOVERY.md`).

## Run it (try it in 2 minutes)

```bash
cd bite-and-melt-pos
BM_ADMIN_PASSWORD='ChooseAStrongOne1' npm start     # http://localhost:3000, user: admin
```
Without `BM_ADMIN_PASSWORD` a random admin password is printed once on first start and you must change it after login.

## Features
New Bill (search, categories, qty +/-, item and bill discounts, notes, dine-in/takeaway/delivery, Cash/UPI/Other, auto bill numbers, optional GST) · bill-specific UPI QR with exact amount and bill number (bill stays **Pending** until you tick "I verified this payment") · WhatsApp click-to-chat + PDF share · Bill History (search, filters, reprint, WhatsApp, admin-password void with record kept) · Reports (today, daily/weekly/monthly, top items, category sales, CSV and Excel export) · Menu management (items, images, categories, availability, order, visibility) · Settings (cafe details, logo, UPI, printer, footer, GST, bill number format, users, password) · offline billing with safe sync and duplicate protection.

All money is computed in whole paise on the server as well as the browser; the server ignores any price or total sent by the client. Old bills keep the prices they were created with.

## New in this version
Official logo, food photos with tap-to-change upload, and a WhatsApp "Pay Now" link through Razorpay/Cashfree (OFF until you add keys). See `docs/CHANGES.md` and `docs/PAYMENT_SETUP.md`. Optional environment variables: `PAYMENT_PROVIDER`, `PUBLIC_BASE_URL`, `RAZORPAY_*`, `CASHFREE_*`, `PAYMENT_LINK_EXPIRY_HOURS`.

## Tests
```bash
npm test          # API + payment-gateway (mock) checks (totals, discounts, duplicates, UPI never auto-Paid, void, GST, export, roles, backup)
npm run test:e2e  # 37 browser checks in Chromium (needs Playwright): billing, QR decode, ESC/POS output, WhatsApp URL, offline sync…
```

## What is and is not verified
* Verified by the automated tests above: everything in the web app and server, using a **mock** printer object.
* **Not verified**: the Android app has not been compiled or run (no Android SDK was available when it was written), and no real 58 mm printer was available. Follow `docs/ANDROID_SETUP.md`, then run the checklist in `docs/TEST_CHECKLIST.md` on your phone and printer before relying on it.
* WhatsApp opens with a pre-filled message; WhatsApp reports no delivery status, so the app never claims a message was delivered. You still press Send in WhatsApp.
* UPI QR only requests payment. Paid status is set by staff after checking the money arrived (a payment gateway such as Razorpay would be needed for automatic confirmation).
