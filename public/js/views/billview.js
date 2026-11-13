import { h, icon, btn, modal, toast, field, badge } from '../ui.js';
import { inr, fmtDateTime, normalizeIndianMobile } from '../calc.js';
import { buildReceipt, needsQr, upiPayload, ORDER_LABEL, PAY_LABEL } from '../receipt.js';
import { qrSvg } from '../qr.js';
import { LOGO_COLOR, svgDataUrl } from '../logo.js';
import { state } from '../store.js';
import { post } from '../api.js';
import { printBill } from '../printer.js';
import { openWhatsApp, sharePdf } from '../share.js';

export const statusBadge = (b) => b.status === 'void' ? badge('Cancelled', 'bad') : b.payment_status === 'paid' ? badge('Paid', 'good') : badge('Pending', 'warn');

export function qrImage(bill, settings, px = 220) {
  return h('img', { class: 'qr', width: px, height: px, alt: 'UPI QR code for ' + inr(bill.grand_total), src: svgDataUrl(qrSvg(upiPayload(bill, settings), px)) });
}

export async function doPrint(bill) {
  try { toast(await printBill(bill, state.settings), 'info'); }
  catch (e) { toast('Print failed: ' + e.message, 'error'); }
}

/** Opens the bill modal. opts: {fresh, onNewBill, onUpdate} */
export function showBill(initial, opts = {}) {
  let bill = initial;
  const s = state.settings;
  let phoneVal = initial.customer_phone || '', linkBusy = false, linkErr = '', linkTried = false;
  const needsLink = () => !!s.online_payment_enabled && !!bill.id && !bill.local && bill.status !== 'void' && bill.payment_status !== 'paid';
  const linkLive = () => bill.payment_link && bill.payment_link.url && ['created', 'partial'].includes(bill.payment_link.status);
  async function ensureLink() {
    if (!needsLink() || linkLive() || linkBusy) return;
    linkTried = true; linkBusy = true; linkErr = ''; render();
    try { const r = await post(`/api/bills/${bill.id}/payment-link`, {}); bill = r.bill; opts.onUpdate && opts.onUpdate(bill); }
    catch (e) { linkErr = e.message || 'Could not create the payment link'; }
    linkBusy = false; render();
  }
  async function checkPayment() {
    try {
      const r = await post(`/api/bills/${bill.id}/payment-link/check`, {}); bill = r.bill; render(); opts.onUpdate && opts.onUpdate(bill);
      toast(r.outcome === 'paid' || r.outcome === 'already_paid' ? 'Payment received. Bill marked PAID.' : r.outcome === 'amount_mismatch' ? 'The amount paid does not match this bill. Not marked paid - check your gateway dashboard.' : 'Not paid yet. The bill stays UNPAID until the gateway confirms payment.', r.outcome === 'paid' || r.outcome === 'already_paid' ? 'ok' : 'info');
    } catch (e) { toast(e.message, 'error'); }
  }
  const body = h('div', { class: 'billview' });
  let m;
  const render = () => {
    body.replaceChildren();
    const unsynced = !!bill.local;
    if (unsynced) body.append(h('div', { class: 'banner warn' }, icon('wifioff', 20), h('div', null, h('b', null, 'Saved on this device.'), ' It will upload automatically when the internet is back. Printing and sharing work normally.')));
    if (bill.status === 'void') body.append(h('div', { class: 'banner bad' }, icon('ban', 20), h('div', null, h('b', null, 'Cancelled. '), bill.void_reason, bill.voided_at ? ` (${fmtDateTime(bill.voided_at)})` : '')));

    // big total + status
    body.append(h('div', { class: 'bv-top' },
      h('div', null, h('div', { class: 'muted' }, 'Bill ' + bill.bill_no), h('div', { class: 'bv-total' }, inr(bill.grand_total)), h('div', { class: 'muted' }, fmtDateTime(bill.created_at) + ' · ' + (ORDER_LABEL[bill.order_type] || ''))),
      h('div', { class: 'bv-badges' }, statusBadge(bill), badge(PAY_LABEL[bill.payment_method] || '', 'info'))));

    // UPI QR (pending only) - generation never marks anything paid
    if (needsQr(bill, s)) {
      body.append(h('div', { class: 'qr-card' },
        qrImage(bill, s),
        h('div', { class: 'qr-info' },
          h('div', { class: 'qr-amt' }, inr(bill.grand_total)),
          h('div', { class: 'muted' }, 'Scan with any UPI app'),
          h('div', { class: 'muted small' }, `To: ${s.payee_name} (${s.upi_id})`), h('div', { class: 'muted small' }, 'Ref: ' + bill.bill_no),
          h('div', { class: 'banner info tight' }, 'Payment stays ', h('b', null, 'PENDING'), ' until you check your UPI/bank app and press “Mark as Paid”. A scanned QR is not proof of payment.'),
          btn('Mark as Paid (I verified it)', { cls: 'good', ic: 'check', disabled: unsynced, onclick: () => markPaid() }),
          unsynced ? h('div', { class: 'muted small' }, 'Available after the bill is synced.') : null)));
    } else if (bill.payment_method === 'upi' && bill.payment_status !== 'paid' && bill.status !== 'void' && !s.upi_id) {
      body.append(h('div', { class: 'banner warn' }, 'No UPI ID is set, so no QR can be shown. An admin can add it in Settings > UPI.'));
    } else if (bill.payment_status === 'pending' && bill.status !== 'void') {
      body.append(h('div', { class: 'actions-row' }, btn('Mark as Paid', { cls: 'good', ic: 'check', disabled: unsynced, onclick: () => markPaid() })));
    }

    // online payment link status (never marks anything paid by itself)
    if (needsLink()) {
      if (linkBusy) body.append(h('div', { class: 'banner info tight' }, 'Preparing the online payment link…'));
      else if (linkLive()) body.append(h('div', { class: 'banner info' }, icon('qr', 20), h('div', null, h('b', null, 'Online payment link ready'), h('div', { class: 'small muted' }, `Ref ${bill.payment_link.reference}. Customer pays in any UPI app. The bill turns PAID only when the payment gateway confirms it.`),
        h('div', { class: 'actions-row' }, btn('Check payment status', { cls: 'ghost', ic: 'refresh', onclick: checkPayment })))));
      else body.append(h('div', { class: 'banner warn' }, icon('wifioff', 20), h('div', null, h('b', null, 'No payment link yet. '), linkErr || 'Tap retry.', h('div', { class: 'actions-row' }, btn('Create payment link', { cls: 'ghost', onclick: ensureLink })))));
    } else if (bill.payment_link && bill.payment_link.status === 'paid') body.append(h('div', { class: 'banner good' }, icon('check', 20), h('div', null, h('b', null, 'Paid online. '), 'Confirmed by the payment gateway.')));

    // receipt preview
    const lines = buildReceipt(bill, { ...s, print_logo: false }, 32).filter((e) => e.t === 'text');
    body.append(h('details', { class: 'paper-wrap', open: opts.fresh ? undefined : true }, h('summary', null, 'Receipt preview'),
      h('div', { class: 'paper' },
        h('img', { class: 'paper-logo', src: s.logo || svgDataUrl(LOGO_COLOR), alt: '', width: 64, height: 64 }),
        h('pre', null, lines.map((l) => { const pad = l.align === 'center' ? ' '.repeat(Math.max(0, Math.floor((32 - l.text.length) / 2))) : ''; return h(l.bold ? 'b' : 'span', null, pad + l.text + '\n'); })))));

    // WhatsApp
    const phone = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'off', placeholder: '10-digit mobile e.g. 98765 43210', value: phoneVal, maxlength: 17, oninput: (e) => { phoneVal = e.target.value; } });
    const err = h('div', { class: 'err small' });
    const note = h('div', { class: 'muted small' });
    const wa = () => {
      err.textContent = '';
      if (needsLink() && !linkLive()) { // the link must be ready BEFORE the tap, otherwise phones block the WhatsApp window
        if (linkBusy) { toast('Preparing the payment link… tap WhatsApp again in a moment', 'info'); return; }
        if (!linkTried) { ensureLink(); toast('Preparing the payment link… tap WhatsApp again in a moment', 'info'); return; }
        if (!confirm('The online payment link could not be created. Send the bill on WhatsApp without a Pay Now link?')) return;
      }
      try { openWhatsApp(bill, s, phone.value); note.textContent = 'WhatsApp was opened with the message ready. Press Send inside WhatsApp - we cannot see whether it was delivered.'; }
      catch (e) { err.textContent = e.message; phone.focus(); }
    };
    body.append(h('div', { class: 'wa-box' },
      h('div', { class: 'lbl' }, 'Send on WhatsApp'),
      h('div', { class: 'wa-row' }, phone, btn('Open WhatsApp', { cls: 'wa', ic: 'wa', onclick: wa })),
      err,
      h('div', { class: 'actions-row' }, btn('Share PDF', { cls: 'ghost', ic: 'share', onclick: async () => {
        try { const r = await sharePdf(bill, s); if (r === 'downloaded') toast('PDF saved to your downloads. Attach it in WhatsApp.', 'info'); else if (r === 'shared') toast('Share sheet opened - choose WhatsApp.', 'info'); }
        catch (e) { toast('Could not create PDF: ' + e.message, 'error'); } } })),
      note));

    // main actions
    const acts = [btn('Print Bill', { cls: 'primary big', ic: 'print', onclick: () => doPrint(bill) })];
    if (opts.fresh) acts.push(btn('New Bill', { cls: 'sky big', ic: 'plus', onclick: () => { m.close(); opts.onNewBill && opts.onNewBill(); } }));
    body.append(h('div', { class: 'bv-actions' }, acts));
    if (!unsynced && bill.status !== 'void') body.append(h('div', { class: 'center' }, btn('Cancel this bill…', { cls: 'link danger-text', ic: 'ban', onclick: () => voidBill() })));
  };

  async function markPaid() {
    const ref = h('input', { type: 'text', maxlength: 60, placeholder: 'UPI transaction ID (optional)' });
    const method = h('select', null, ...['cash', 'upi', 'other'].map((k) => h('option', { value: k, selected: k === bill.payment_method }, PAY_LABEL[k])));
    const ok = h('input', { type: 'checkbox' });
    const mm = modal({ title: 'Mark bill as Paid', body: h('div', null,
        h('p', null, `Confirm that ${inr(bill.grand_total)} for bill ${bill.bill_no} has actually been received.`),
        field('Received by', method), field('Reference (UTR / txn id)', ref),
        h('label', { class: 'check' }, ok, h('span', null, 'I have verified this payment in my UPI / bank app or received the cash.'))),
      actions: [btn('Cancel', { cls: 'ghost', onclick: () => mm.close() }),
        btn('Mark Paid', { cls: 'good', onclick: async () => {
          if (!ok.checked) { toast('Please tick the confirmation box', 'error'); return; }
          try { const r = await post(`/api/bills/${bill.id}/pay`, { confirm: true, method: method.value, reference: ref.value }); bill = r.bill; mm.close(); render(); opts.onUpdate && opts.onUpdate(bill); toast('Marked as Paid', 'ok'); }
          catch (e) { toast(e.message, 'error'); } } })] });
  }
  async function voidBill() {
    const reason = h('input', { type: 'text', maxlength: 200, placeholder: 'Reason (e.g. wrong order)' });
    const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Admin password' });
    const mm = modal({ title: 'Cancel bill ' + bill.bill_no, body: h('div', null,
        h('p', null, 'The bill stays in your records as Cancelled and is removed from sales totals. This needs an admin password.'),
        field('Reason', reason), field('Admin password', pw)),
      actions: [btn('Keep bill', { cls: 'ghost', onclick: () => mm.close() }),
        btn('Cancel bill', { cls: 'danger', onclick: async () => {
          if (!reason.value.trim()) { toast('Please enter a reason', 'error'); return; }
          try { const r = await post(`/api/bills/${bill.id}/void`, { reason: reason.value, admin_password: pw.value }); bill = r.bill; mm.close(); render(); opts.onUpdate && opts.onUpdate(bill); toast('Bill cancelled', 'ok'); }
          catch (e) { toast(e.message, 'error'); } } })] });
  }

  render();
  if (opts.fresh) ensureLink();
  m = modal({ title: opts.fresh ? 'Bill created' : 'Bill details', body, wide: true });
  return m;
}
