# Change log (upgrade of the existing POS)

Backups taken first (in `/home/claude/backups/`): database copy, full data folder, and a code archive. No existing table was altered; new tables are only *added*.

1. **Logo**: your uploaded logo is `public/brand/logo.png` (unmodified) and is used on the login screen, header (which sits over the sidebar on desktop), dashboard and as the browser/home-screen icon (`public/brand/favicon.png` = the same logo centred on a white 512×512 square, because favicons must be square; the logo itself is not cropped or stretched). Replace the file to change the logo; or upload one in Settings (that one takes priority). Receipts still print the built-in black-and-white mark unless you upload a logo in Settings.
2. **Food photos**: clean placeholder (fork-and-knife on soft colour) for items without photos; photo + name + price grid on New Bill; in Menu Management tap any thumbnail (or Edit → Food photo) to take/choose a photo from phone or computer. Photos are saved in `data/uploads/` (permanent, included in the folder you back up). Bulk helper: `npm run import-images -- /folder` matches files named like the items ("Veg Burger.jpg"). **No sample photos were added**: I cannot generate or invent food photos, so every item shows the placeholder until you upload real ones.
3. **WhatsApp bill**: UPI ID removed; "Pay Now" link + Order No + Payment Ref added when online payment is configured (see PAYMENT_SETUP.md). Server: new routes `POST /api/bills/:id/payment-link`, `POST /api/bills/:id/payment-link/check`, `POST /api/webhooks/payments`; new tables `payment_links`, `webhook_events`; new file `server/payments.js`.
4. **Mobile**: touch targets raised to 44 px, desktop New Bill cart no longer clipped on 1280 px screens.
5. **Tests**: `npm test` (API + payments, 35 checks), `npm run test:e2e` (37), `node tests/e2e-payment.cjs` (4).

## WhatsApp receipt image (later change)
"Send receipt image" renders the same receipt layout that goes to the thermal printer (same 32/48 columns, line spacing, bold, logo and UPI QR rules) as a 768 px PNG (`public/js/receiptImage.js`) and passes it to the phone's share sheet (choose WhatsApp, then the chat of the number entered). WhatsApp cannot attach an image to a chat link, so on a computer the image is copied to the clipboard and the chat opens for Ctrl+V. The old text message stays available as "Send as text". Printing, calculations and the database are untouched. Logo: Settings logo, else public/brand/logo.png, drawn in grey tones; printed receipts still use the 1-bit built-in mark unless a logo is uploaded in Settings.

## Latest changes (Nov 2026)
* Bill discount quick buttons: No disc, 5, 10, 15, 20, 25, 50, 100 %.
* Every printed / shared bill with a total above ₹0 carries a UPI QR for the exact bill total (any payment method). Needs a UPI ID.
* The cafe's real menu, phone number and UPI ID are built into the code (`server/db.js`), so a fresh/reset database (free Render restart) starts with them instead of sample data.
* Settings > Backup & data: "Restore from backup (.db)" brings back menu, bills and settings from a downloaded backup. Staff accounts are not touched.
* New Bill: category buttons (Burger, Sandwich, Pizza, ...) wrap so all are visible; the first category opens by default and shows only its own items; "All" is the last button; searching looks across every category.
