// One receipt layout used for: Bluetooth thermal print (ESC/POS), PDF, on-screen preview and WhatsApp text.
import { plain, fmtDateTime } from './calc.js';
import { upiUri } from './qr.js';

export const ORDER_LABEL = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
export const PAY_LABEL = { cash: 'Cash', upi: 'UPI', other: 'Other' };

/** thermal printers only reliably support ASCII */
export function ascii(s) {
  return String(s ?? '')
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

export function wrap(text, width) {
  const out = [];
  for (const para of ascii(text).split(/\r?\n/)) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) { // hard-split very long words
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if ((line + ' ' + word).length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}
const lr = (l, r, w) => {
  l = ascii(l); r = ascii(r);
  if (l.length + r.length + 1 > w) l = l.slice(0, Math.max(0, w - r.length - 1));
  return l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;
};

export function upiPayload(bill, s) {
  return upiUri({
    vpa: s.upi_id, name: s.payee_name || s.cafe_name || 'BITE AND MELT', amountPaise: bill.grand_total,
    billNo: bill.bill_no, note: (s.upi_ref ? s.upi_ref + ' ' : '') + 'Bill ' + bill.bill_no,
  });
}
export const needsQr = (bill, s) => bill.payment_method === 'upi' && bill.payment_status !== 'paid' && bill.status !== 'void' && !!s.upi_id;

/**
 * Returns array of entries:
 *  {t:'text', text, align:'left|center|right', bold, big}  |  {t:'logo'} | {t:'qr', data, caption}  | {t:'gap'}
 */
export function buildReceipt(bill, s, cols = 32) {
  const L = [];
  const text = (text, o = {}) => L.push({ t: 'text', text, align: o.align || 'left', bold: !!o.bold, big: !!o.big });
  const center = (txt, o = {}) => wrap(txt, o.big ? Math.floor(cols / 2) : cols).forEach((x) => text(x, { ...o, align: 'center' }));
  const dash = () => text('-'.repeat(cols));
  const dbl = () => text('='.repeat(cols));

  if (s.print_logo !== false) L.push({ t: 'logo' });
  center((s.cafe_name || 'BITE AND MELT').toUpperCase(), { bold: true, big: true });
  if (s.address) center(s.address);
  if (s.phone) center('Ph: ' + s.phone);
  if (s.gst_enabled && s.gst_number) center('GSTIN: ' + s.gst_number);
  dash();
  if (bill.status === 'void') { center('*** CANCELLED / VOID ***', { bold: true }); dash(); }
  text(lr('Bill No:', bill.bill_no, cols), { bold: true });
  text(lr('Date:', fmtDateTime(bill.created_at), cols));
  text(lr('Order:', ORDER_LABEL[bill.order_type] || bill.order_type, cols));
  if (bill.customer_name) text(lr('Customer:', bill.customer_name, cols));
  if (bill.customer_phone) text(lr('Mobile:', bill.customer_phone, cols));
  dash();
  text(lr('Item', 'Amount', cols), { bold: true });
  dash();
  for (const it of bill.items) {
    wrap(it.name, cols).forEach((x) => text(x, { bold: true }));
    text(lr(`  ${it.qty} x ${plain(it.price)}`, plain(it.price * it.qty), cols));
    if (it.disc_amount > 0) text(lr('  Item discount', '-' + plain(it.disc_amount), cols));
  }
  dash();
  text(lr('Subtotal', plain(bill.subtotal), cols));
  if (bill.item_discount > 0) text(lr('Item discounts', '-' + plain(bill.item_discount), cols));
  if (bill.bill_discount > 0) text(lr('Bill discount', '-' + plain(bill.bill_discount), cols));
  if (bill.tax_total > 0) text(lr(`GST ${bill.gst_rate}%${bill.gst_mode === 'inclusive' ? ' (incl.)' : ''}`, plain(bill.tax_total), cols));
  if (bill.round_off) text(lr('Round off', (bill.round_off > 0 ? '+' : '') + plain(bill.round_off), cols));
  dbl();
  const totalLine = lr('TOTAL', 'Rs.' + plain(bill.grand_total), Math.floor(cols / 2));
  text(totalLine, { bold: true, big: true });
  dbl();
  text(lr('Payment:', PAY_LABEL[bill.payment_method] || bill.payment_method, cols));
  text(lr('Status:', bill.payment_status === 'paid' ? 'PAID' : 'PENDING', cols), { bold: true });
  if (needsQr(bill, s)) {
    dash();
    center('Scan & pay with any UPI app', { bold: true });
    L.push({ t: 'qr', data: upiPayload(bill, s) });
    center('Rs. ' + plain(bill.grand_total), { bold: true });
    center('UPI: ' + s.upi_id);
    center('Ref: ' + bill.bill_no);
  }
  if (bill.notes) { dash(); wrap('Note: ' + bill.notes, cols).forEach((x) => text(x)); }
  dash();
  if (s.footer) center(s.footer, { bold: true });
  center('Thank You! Visit Again');
  return L;
}

/** WhatsApp message text. States payment status exactly as recorded - never claims payment from a QR. */
export function whatsappText(bill, s) {
  const lines = [];
  lines.push(`*${s.cafe_name || 'BITE AND MELT'}*`);
  if (s.address) lines.push(s.address);
  lines.push('');
  lines.push(`Bill No: *${bill.bill_no}*`);
  lines.push(`Date: ${fmtDateTime(bill.created_at)}`);
  lines.push(`Order: ${ORDER_LABEL[bill.order_type] || ''}`);
  lines.push('');
  for (const it of bill.items) lines.push(`${it.qty} x ${it.name} = ₹${plain(it.price * it.qty - (it.disc_amount || 0))}`);
  lines.push('');
  if (bill.discount_total > 0) lines.push(`Discount: -₹${plain(bill.discount_total)}`);
  if (bill.tax_total > 0) lines.push(`GST ${bill.gst_rate}%: ₹${plain(bill.tax_total)}`);
  lines.push(`*Total: ₹${plain(bill.grand_total)}*`);
  lines.push(`Payment: ${PAY_LABEL[bill.payment_method] || ''} - *${bill.payment_status === 'paid' ? 'PAID' : 'PENDING'}*`);
  if (bill.status === 'void') lines.push('⚠️ This bill has been CANCELLED.');
  // Online payment link (created by the server through the payment gateway). The UPI ID itself is no longer shown here.
  const pl = bill.payment_link;
  if (bill.payment_status !== 'paid' && bill.status !== 'void' && pl && pl.url && (pl.status === 'created' || pl.status === 'partial')) {
    lines.push('');
    lines.push(`👉 *Pay Now:* ${pl.url}`);
    lines.push('(Google Pay, PhonePe, Paytm or any UPI app)');
    lines.push(`Order No: ${bill.bill_no}`);
    lines.push(`Payment Ref: ${pl.reference}`);
    lines.push(`Amount: ₹${plain(bill.grand_total)}`);
  }
  lines.push('');
  lines.push(s.footer || 'Thank you! Visit again 🙏');
  return lines.join('\n');
}
