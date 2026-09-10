import {
  InvoicePdfService,
  formatMoney,
  formatInvoiceDate,
} from './invoice-pdf.service';
import type { Invoice } from './invoice.service';

// pdfkit compresses content streams but not object dictionaries, so page
// objects are greppable in the raw buffer. The `[^s]` after `/Page` matters:
// without it this also matches `/Type /Pages`, the page-tree node, and every
// count comes out one too high.
const pageCount = (buffer: Buffer): number =>
  (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  invoiceNumber: 'YKZ/INV/2026-27/00323711',
  invoiceDate: '2026-08-06T10:00:00.000Z',
  orderReference: 'YKZ/ORD/2026-27/00323711',
  sellerId: 'seller-1',
  seller: {
    name: 'Galazy Enterprises',
    gstin: null,
    address: '7th floor, Yamuna Building, Kolkata, West Bengal, 700048',
    phone: null,
    email: 'posting@theeraofmarketing.com',
  },
  buyer: {
    name: 'Arko',
    gstin: null,
    address: 'sss, ss, West Bengal, 711303',
    phone: '9008336683',
    email: 'buyer@example.com',
  },
  placeOfSupply: 'West Bengal',
  isIntraState: true,
  lines: [
    {
      serial: 1,
      description: 'Testing',
      quantity: 1,
      unitPrice: 168.71,
      taxableValue: 168.71,
      gstRate: 10,
      gstAmount: 16.87,
      totalAmount: 185.58,
    },
  ],
  taxBreakdown: [
    {
      rate: 10,
      componentRate: 5,
      taxableValue: 168.71,
      cgst: 8.44,
      sgst: 8.43,
      igst: 0,
    },
  ],
  subtotal: 168.71,
  cgst: 8.44,
  sgst: 8.43,
  igst: 0,
  totalTax: 16.87,
  totalAmount: 185.58,
  amountInWords: 'One Hundred Eighty Five Rupees and Fifty Eight Paise Only',
  ...over,
});

describe('InvoicePdfService', () => {
  const service = new InvoicePdfService();

  it('produces a non-empty PDF buffer', async () => {
    const buffer = await service.render(invoice());

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('renders an inter-state invoice without throwing', async () => {
    const buffer = await service.render(
      invoice({
        isIntraState: false,
        taxBreakdown: [
          {
            rate: 18,
            componentRate: 18,
            taxableValue: 100,
            cgst: 0,
            sgst: 0,
            igst: 18,
          },
        ],
        cgst: 0,
        sgst: 0,
        igst: 18,
      }),
    );

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders multiple tax rates and many lines without throwing', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      serial: i + 1,
      description: `Item ${i + 1}`,
      quantity: 2,
      unitPrice: 50,
      taxableValue: 100,
      gstRate: i % 2 ? 18 : 5,
      gstAmount: 10,
      totalAmount: 110,
    }));

    const buffer = await service.render(invoice({ lines }));

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw when the GSTINs are blank', async () => {
    const buffer = await service.render(
      invoice({
        seller: {
          name: 'Galazy',
          gstin: null,
          address: '',
          phone: null,
          email: null,
        },
        buyer: { name: '', gstin: null, address: '', phone: null, email: null },
      }),
    );

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('names the file from the invoice number, safe for a filesystem', () => {
    expect(service.filename(invoice())).toBe('YKZ-INV-2026-27-00323711.pdf');
  });

  it('keeps the standard single-line invoice on one page', async () => {
    const buffer = await service.render(invoice());

    expect(pageCount(buffer)).toBe(1);
  });
});

describe('formatMoney', () => {
  it('formats a plain amount with the Rs. prefix', () => {
    expect(formatMoney(185.58)).toBe('Rs. 185.58');
  });

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('Rs. 0.00');
  });

  it('tolerates a null/undefined input', () => {
    expect(formatMoney(null as unknown as number)).toBe('Rs. 0.00');
  });

  it('rounds to two decimal places', () => {
    expect(formatMoney(168.7)).toBe('Rs. 168.70');
  });
});

describe('formatInvoiceDate', () => {
  it('formats an ISO date', () => {
    const formatted = formatInvoiceDate('2026-08-06T10:00:00.000Z');
    expect(formatted).toContain('2026');
    expect(formatted).toContain('06');
  });

  it('returns an empty string for an unparseable date', () => {
    expect(formatInvoiceDate('not-a-date')).toBe('');
  });
});
