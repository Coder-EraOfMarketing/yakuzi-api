import {
  CommissionInvoicePdfService,
  commissionLineDescription,
  formatMoney,
} from './commission-invoice-pdf.service';
import type { CommissionInvoice } from './commission-invoice';

// pdfkit compresses content streams but not object dictionaries, so page
// objects are greppable in the raw buffer. The `[^s]` after `/Page` matters:
// without it this also matches `/Type /Pages`, the page-tree node.
const pageCount = (buffer: Buffer): number =>
  (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const invoice = (over: Partial<CommissionInvoice> = {}): CommissionInvoice => ({
  invoiceNumber: 'YKZ/COM/2026-27/15D8CB94',
  invoiceDate: '2026-09-11T10:00:00.000Z',
  orderReference: 'ABAF6047',
  payoutReference: 'UTR12345',
  issuer: {
    name: 'Yukizi Market Services Private Limited',
    gstin: '19ZZZZZ9999Z1Z9',
    address: 'Kolkata, West Bengal',
    state: 'West Bengal',
    email: 'accounts@yukizi.com',
  },
  seller: {
    name: 'Galazy Enterprises',
    gstin: '19ABCDE1234F1Z5',
    address: '7th floor, Kolkata, West Bengal, 700048',
    state: 'West Bengal',
    email: 'seller@example.com',
  },
  grossAmount: 1000,
  commissionableAmount: 1000,
  commissionRatePercent: 15,
  commission: 150,
  gstRate: 18,
  isIntraState: true,
  cgst: 13.5,
  sgst: 13.5,
  igst: 0,
  totalGst: 27,
  totalCharged: 177,
  netPaidToSeller: 823,
  isTaxInvoice: true,
  ...over,
});

describe('CommissionInvoicePdfService', () => {
  const service = new CommissionInvoicePdfService();

  it('renders a real single-page PDF', async () => {
    const buffer = await service.render(invoice());

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(1000);
    expect(pageCount(buffer)).toBe(1);
  });

  it('stays one page for an inter-state invoice too', async () => {
    const buffer = await service.render(
      invoice({ isIntraState: false, cgst: 0, sgst: 0, igst: 27 }),
    );

    expect(pageCount(buffer)).toBe(1);
  });

  it('renders when every optional field is missing', async () => {
    const buffer = await service.render(
      invoice({
        orderReference: '',
        payoutReference: null,
        commissionRatePercent: null,
        gstRate: null,
        isTaxInvoice: false,
        issuer: { name: 'Yukizi', gstin: null, address: '', state: null, email: null },
        seller: { name: '', gstin: null, address: '', state: null, email: null },
      }),
    );

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(buffer)).toBe(1);
  });

  it('names the file after the invoice, with the slashes replaced', () => {
    expect(service.filename(invoice())).toBe('YKZ-COM-2026-27-15D8CB94.pdf');
  });

  it('writes Rs. rather than the rupee glyph pdfkit cannot encode', () => {
    expect(formatMoney(177)).toBe('Rs. 177.00');
    expect(formatMoney(0)).toBe('Rs. 0.00');
  });

  it('renders when the base is missing, as on a legacy settlement', async () => {
    const buffer = await service.render(invoice({ commissionableAmount: null }));

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(buffer)).toBe(1);
  });
});

/**
 * The sentence the client actually reads. This is the only place the
 * commission RATE appears on the document, and the whole bug was that it named
 * a rate nobody had configured.
 */
describe('commissionLineDescription', () => {
  // The client's real order: ₹11 product + ₹6 shipping, 15% configured.
  const reported = invoice({
    grossAmount: 17,
    commissionableAmount: 11,
    commissionRatePercent: 15,
    commission: 1.65,
    totalGst: 0.3,
  });

  it('prints the configured rate against the product value, not the gross', () => {
    const line = commissionLineDescription(reported);

    expect(line).toBe(
      'Marketplace commission at 15% of Rs. 11.00 product value ' +
        '(order value Rs. 17.00, shipping not commissioned) on order ABAF6047',
    );
  });

  it('never prints the gross-derived 9.71%', () => {
    expect(commissionLineDescription(reported)).not.toContain('9.71');
  });

  it('keeps the order-value-only wording for a legacy settlement', () => {
    // No recorded base, so it claims none. The rate on such a row is still
    // derived from the gross, which is what it was genuinely charged on.
    const line = commissionLineDescription(
      invoice({
        grossAmount: 17,
        commissionableAmount: null,
        commissionRatePercent: 9.71,
      }),
    );

    expect(line).toBe(
      'Marketplace commission at 9.71% (order value Rs. 17.00) on order ABAF6047',
    );
    expect(line).not.toContain('product value');
  });

  it('states no rate when there is none to state', () => {
    const line = commissionLineDescription(
      invoice({ commissionRatePercent: null, commissionableAmount: null }),
    );

    expect(line).toBe(
      'Marketplace commission (order value Rs. 1000.00) on order ABAF6047',
    );
  });

  it('falls back to a dash for a missing order reference', () => {
    expect(commissionLineDescription(invoice({ orderReference: '' }))).toContain(
      'on order —',
    );
  });
});
