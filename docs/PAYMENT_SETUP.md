# Online payment ("Pay Now" link in WhatsApp bills)

**Status: built, switched OFF.** It stays off until you create a gateway account and put its keys on the server. With no keys, the WhatsApp bill simply shows the amount and "PENDING" (the UPI ID is no longer printed in the message), the app never creates a link, and nothing is ever simulated.

## How it works
1. A bill is saved (UPI / Pending). The server asks the gateway for a payment link for the **exact bill amount**, with the bill number as the order number and `BM-…-P1` as the payment reference.
2. The WhatsApp message gets: `Pay Now: <link>`, Order No, Payment Ref, Amount. The customer opens the link and pays with Google Pay, PhonePe, Paytm or any UPI app.
3. The gateway calls your server (`/api/webhooks/payments`) with a **signed** message. The server checks the signature, asks the gateway directly "is this link really paid, and for how much?", and only then marks the bill **PAID** (method UPI, reference = gateway payment ID). Failed/pending/expired payments leave the bill Pending (shown as "Pending"/unpaid).
4. Clicking or opening the link never changes a bill. The same webhook arriving twice is ignored. A wrong amount, or a payment for a cancelled bill, is **not** marked paid (it is logged so you can refund).
5. Staff can also press **Check payment status** on the bill; this asks the gateway directly (it cannot force "Paid").
6. API keys exist only in server environment variables; the browser only learns "online payment on/off".

## Setup: Razorpay (recommended, fully documented API)
1. Create an account at razorpay.com, finish KYC for live payments (use **Test mode** first). Check that Payment Links and UPI are enabled for your account.
2. Dashboard → Account & Settings → API Keys → generate **Key Id** and **Key Secret** (test keys start `rzp_test_`).
3. Dashboard → Webhooks → Add new webhook:
   * URL: `https://YOUR-POS-DOMAIN/api/webhooks/payments`  (must be public HTTPS; `localhost` will not work)
   * Secret: choose a long random text (this is `RAZORPAY_WEBHOOK_SECRET`)
   * Events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`
4. Start the server with:
```bash
export PAYMENT_PROVIDER=razorpay
export RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
export RAZORPAY_KEY_SECRET=xxxxxxxx
export RAZORPAY_WEBHOOK_SECRET=the-secret-from-step-3
export PUBLIC_BASE_URL=https://YOUR-POS-DOMAIN
npm start
```
The start-up log says `online payment ON via razorpay`, or lists which variable is missing.
5. Test: make a UPI bill ₹1 → tap WhatsApp → pay the link in test mode → the bill should turn PAID within seconds (or press *Check payment status*).

## Setup: Cashfree (supported, less verified)
`PAYMENT_PROVIDER=cashfree`, `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENV=sandbox` (or `production`), `PUBLIC_BASE_URL`. Webhook URL is the same; webhook signature check = HMAC-SHA256(timestamp + raw body) in base64, header `x-webhook-signature`. Cashfree's documentation does not clearly say whether Payment Link webhooks use this JSON scheme or an older form-encoded one, so test in sandbox first; if the webhook is refused, *Check payment status* still confirms payments correctly.

## All environment variables
| Variable | Purpose |
|---|---|
| `PAYMENT_PROVIDER` | `none` (default), `razorpay` or `cashfree` |
| `PUBLIC_BASE_URL` | public https address (return page after payment) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay |
| `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENV` | Cashfree |
| `PAYMENT_LINK_EXPIRY_HOURS` | optional, default 72 |
| `PAYMENT_API_BASE` | testing only, do not set |

## Important notes
* Verified here only against a **mock gateway** (`npm test`), not a real Razorpay/Cashfree account. Do a ₹1 test in the gateway's test mode before going live.
* Gateways charge a fee per transaction; refunds are done in the gateway dashboard.
* The manual "I verified it" Mark-as-Paid flow and the in-app UPI QR still work as before.
