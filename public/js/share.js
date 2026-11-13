import { normalizeIndianMobile } from './calc.js';
import { whatsappText } from './receipt.js';
import { receiptPdf } from './pdf.js';
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
