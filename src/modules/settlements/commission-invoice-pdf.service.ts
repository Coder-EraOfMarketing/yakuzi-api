import { Injectable } from '@nestjs/common';
// Default import, NOT `import * as PDFDocument`: tsconfig sets esModuleInterop,
// under which a namespace import is not constructable.
import PDFDocument from 'pdfkit';
import type { CommissionInvoice, CommissionInvoiceParty } from './commission-invoice';

/**
 * Renders a commission invoice to a PDF buffer.
 *
 * In memory only — nothing is written to disk. The deploy rsyncs with
 * --delete so server-side files do not survive, and the VM disk has run out
 * before now.
 *
 * NOTE ON CURRENCY: pdfkit's built-in Helvetica is WinAnsi encoded and has no
 * rupee glyph, so amounts are written as "Rs." — the same compromise the
 * order invoice makes. Pasting the symbol back in renders a broken character.
 */

const PURPLE = '#593696';
const SLATE = '#475569';
const MUTED = '#94a3b8';
const BORDER = '#e2e8f0';
const DASH = '—';

export function formatMoney(n: number): string {
  return `Rs. ${Number(n ?? 0).toFixed(2)}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

@Injectable()
export class CommissionInvoicePdfService {
  /** A filesystem-safe attachment name, e.g. YKZ-COM-2026-27-15D8CB94.pdf */
  filename(invoice: CommissionInvoice): string {
    const safe = invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-');
    return `${safe}.pdf`;
  }

  async render(invoice: CommissionInvoice): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];

    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.draw(doc, invoice);
    doc.end();
    return done;
  }

  private draw(doc: InstanceType<typeof PDFDocument>, invoice: CommissionInvoice): void {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    doc.font('Helvetica-Bold').fontSize(20).fillColor(PURPLE).text('YUKIZI', left, 40);

    // A document without the issuer's GSTIN is not a tax invoice, and says so
    // rather than letting a seller file it as one.
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#0f172a')
      .text(invoice.isTaxInvoice ? 'TAX INVOICE' : 'PAYOUT STATEMENT', left, 40, {
        width,
        align: 'right',
      });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(SLATE)
      .text('Marketplace commission', left, 58, { width, align: 'right' });

    let y = 92;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(SLATE)
      .text(`Invoice no: ${invoice.invoiceNumber}`, left, y)
      .text(`Date: ${formatDate(invoice.invoiceDate)}`, left, y + 14)
      .text(`Order: ${invoice.orderReference || DASH}`, left, y + 28)
      .text(`Payout ref: ${invoice.payoutReference || DASH}`, left, y + 42);

    y += 70;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).stroke();

    // ── Parties. Yukizi supplies, the seller is billed. ──────
    y += 12;
    const colWidth = width / 2 - 10;
    this.party(doc, 'From (Supplier)', invoice.issuer, left, y, colWidth);
    this.party(doc, 'Billed to', invoice.seller, left + colWidth + 20, y, colWidth);

    y += 92;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Place of supply: ${invoice.seller.state || DASH}` +
          (invoice.isIntraState ? '  (intra-state)' : '  (inter-state)'),
        left,
        y,
      );

    // ── The single line: the commission itself ───────────────
    y += 20;
    doc.rect(left, y, width, 20).fillColor('#f8fafc').fill();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(SLATE);
    doc.text('DESCRIPTION', left + 8, y + 6, { width: width - 220 });
    doc.text('TAXABLE VALUE', left + width - 210, y + 6, { width: 100, align: 'right' });
    doc.text('GST', left + width - 100, y + 6, { width: 92, align: 'right' });

    y += 24;
    const rate =
      invoice.commissionRatePercent != null
        ? ` at ${invoice.commissionRatePercent}%`
        : '';
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#0f172a')
      .text(
        `Marketplace commission${rate} on order ${invoice.orderReference || DASH}` +
          ` (order value ${formatMoney(invoice.grossAmount)})`,
        left + 8,
        y,
        { width: width - 230 },
      );
    doc.text(formatMoney(invoice.commission), left + width - 210, y, {
      width: 100,
      align: 'right',
    });
    doc.text(formatMoney(invoice.totalGst), left + width - 100, y, {
      width: 92,
      align: 'right',
    });

    y += 34;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).stroke();

    // ── Tax stated component by component ────────────────────
    y += 10;
    const rows: Array<[string, string]> = [
      ['Taxable value', formatMoney(invoice.commission)],
    ];
    if (invoice.isIntraState) {
      rows.push([`CGST${this.half(invoice)}`, formatMoney(invoice.cgst)]);
      rows.push([`SGST${this.half(invoice)}`, formatMoney(invoice.sgst)]);
    } else {
      rows.push([
        `IGST${invoice.gstRate != null ? ` @ ${invoice.gstRate}%` : ''}`,
        formatMoney(invoice.igst),
      ]);
    }

    doc.font('Helvetica').fontSize(9).fillColor(SLATE);
    for (const [label, value] of rows) {
      doc.text(label, left + width - 260, y, { width: 160, align: 'right' });
      doc.text(value, left + width - 92, y, { width: 92, align: 'right' });
      y += 14;
    }

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
    doc.text('Total charged', left + width - 260, y + 4, { width: 160, align: 'right' });
    doc.text(formatMoney(invoice.totalCharged), left + width - 92, y + 4, {
      width: 92,
      align: 'right',
    });

    // ── What this meant for the payout ───────────────────────
    y += 34;
    doc.rect(left, y, width, 44).fillColor('#f8fafc').fill();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(SLATE)
      .text(
        `This amount was deducted at source from your payout for this item. ` +
          `Net paid to you: ${formatMoney(invoice.netPaidToSeller)}.`,
        left + 10,
        y + 10,
        { width: width - 20 },
      );

    y += 60;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        invoice.isTaxInvoice
          ? 'Computer-generated document. No signature required.'
          : 'Not a tax invoice: no GSTIN is on file for the issuer. Issued as a payout statement only.',
        left,
        y,
        { width },
      );
  }

  /** "@ 9%" — half the rate each side, e.g. 18% split into CGST + SGST. */
  private half(invoice: CommissionInvoice): string {
    return invoice.gstRate != null ? ` @ ${invoice.gstRate / 2}%` : '';
  }

  private party(
    doc: InstanceType<typeof PDFDocument>,
    heading: string,
    party: CommissionInvoiceParty,
    x: number,
    y: number,
    width: number,
  ): void {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(heading.toUpperCase(), x, y, { width });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#0f172a')
      .text(party.name || DASH, x, y + 12, { width });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(SLATE)
      .text(party.address || DASH, x, y + 26, { width })
      .text(`GSTIN: ${party.gstin || DASH}`, x, y + 52, { width })
      .text(party.email || DASH, x, y + 64, { width });
  }
}
