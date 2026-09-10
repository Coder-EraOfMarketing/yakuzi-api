import { CommissionInvoicePdfService, formatMoney } from './commission-invoice-pdf.service';
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
});
