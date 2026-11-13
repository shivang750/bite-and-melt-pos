# Device checklist (to be run by you on the real phone and printer)

Automated tests already cover items 1–6, 8-logic, 9–10 and 12 (`npm test`, `npm run test:e2e`). These need your hardware:

- [ ] Pair printer, choose it in Settings, **Test Print** prints text clearly on 58 mm paper
- [ ] Print a real bill: logo, items wrap within paper width, totals, bill no., date, payment method
- [ ] UPI bill prints a QR; scan the *printed* QR with a phone UPI app → shows exact amount and `BM-…` reference, payee BITE AND MELT
- [ ] Paper cut works (or is ignored harmlessly)
- [ ] Reprint an old bill from Bill History
- [ ] WhatsApp button opens WhatsApp with the pre-filled message; PDF share opens the Android share sheet
- [ ] Switch phone to airplane mode, create a bill (prints and gets an OFL- number), switch back, confirm it syncs and appears in history/reports
- [ ] Export Excel from Reports on the phone and open the file
