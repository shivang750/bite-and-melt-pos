import { normalizeIndianMobile } from './calc.js';
import { whatsappText } from './receipt.js';
import { receiptPdf } from './pdf.js';
import { receiptPng, receiptImageName, receiptCaption } from './receiptImage.js';
import { downloadBlob, blobToBase64 } from './ui.js';

export const pdfFileName = (bill) => `Bill-${bill.bill_no}.pdf`;

/** Opens WhatsApp click-to-chat with the message pre-filled. WhatsApp gives us no delivery information. */
export function openWhatsApp(bill, settings, phoneInput) {
  const phone = normalizeIndianMobile(phoneInput);
  if (!phone) throw new Error('Enter a valid 10-digit Indian mobile number (starting 6-9).');
  const url = `https://wa.me/91${phone}?text=${encodeURIComponent(whatsappText(bill, settings))}`;
  // An anchor with target=_blank keeps this app open (window.open with 'noopener' returns null and would tempt a same-tab navigation).
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  document.body.append(a); a.click(); a.remove();
  return phone;
}

/** Share the PDF receipt through the Android share sheet (pick WhatsApp). Falls back to downloading the PDF. */
export async function sharePdf(bill, settings) {
  const bytes = receiptPdf(bill, settings);
  if (window.BiteMeltPrinter && window.BiteMeltPrinter.shareFile) { // Android wrapper: native share sheet (choose WhatsApp)
    const r = String(window.BiteMeltPrinter.shareFile(pdfFileName(bill), 'application/pdf', await blobToBase64(new Blob([bytes], { type: 'application/pdf' })), `${settings.cafe_name} - Bill ${bill.bill_no}`, whatsappText(bill, settings)));
    if (r !== 'OK') throw new Error(r.replace(/^ERROR:\s*/, ''));
    return 'shared';
  }
  const file = new File([bytes], pdfFileName(bill), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${settings.cafe_name} - Bill ${bill.bill_no}`, text: whatsappText(bill, settings) });
      return 'shared';
    } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), pdfFileName(bill));
  return 'downloaded';
}

/** Builds the receipt image ahead of time (a phone only allows the share sheet to open straight from a tap, so the image must already exist). */
export async function prepareReceiptImage(bill, settings) {
  const blob = await receiptPng(bill, settings);
  return { blob, file: new File([blob], receiptImageName(bill), { type: 'image/png' }), caption: receiptCaption(bill, settings) };
}

/**
 * Sends the receipt IMAGE through WhatsApp. WhatsApp offers no way to attach an image to a chat link, so:
 *  - phone/tablet: the system share sheet opens with the image; choose WhatsApp, then the chat of the number entered
 *  - Android wrapper app: native share sheet
 *  - computer: image is copied to the clipboard (and saved), the chat for that number opens, press Ctrl+V then Send
 * Everything up to the share call is synchronous on purpose (browsers require it to happen directly inside the tap).
 * Returns 'shared' | 'cancelled' | 'copied' | 'downloaded'. Delivery can never be known.
 */
export function shareReceiptImage(bill, settings, phoneInput, prepared) {
  const phone = normalizeIndianMobile(phoneInput);
  if (!phone) throw new Error('Enter a valid 10-digit Indian mobile number (starting 6-9).');
  const { blob, file, caption } = prepared;
  if (window.BiteMeltPrinter && window.BiteMeltPrinter.shareFile) {
    return blobToBase64(blob).then((b64) => {
      const r = String(window.BiteMeltPrinter.shareFile(receiptImageName(bill), 'image/png', b64, `${settings.cafe_name} - Bill ${bill.bill_no}`, caption));
      if (r !== 'OK') throw new Error(r.replace(/^ERROR:\s*/, ''));
      return 'shared';
    });
  }
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: `${settings.cafe_name} - Bill ${bill.bill_no}`, text: caption })
      .then(() => 'shared')
      .catch((e) => { if (e && e.name === 'AbortError') return 'cancelled'; return desktopFallback(); });
  }
  return desktopFallback();
  async function desktopFallback() {
    let copied = false;
    try { if (navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; } } catch { /* clipboard blocked */ }
    if (!copied) downloadBlob(blob, receiptImageName(bill));
    const a = document.createElement('a'); a.href = `https://wa.me/91${phone}?text=${encodeURIComponent(caption)}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.append(a); a.click(); a.remove();
    return copied ? 'copied' : 'downloaded';
  }
}
