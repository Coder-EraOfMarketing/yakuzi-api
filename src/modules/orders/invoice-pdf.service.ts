import { Injectable } from '@nestjs/common';
// Default import, NOT `import * as PDFDocument`: tsconfig sets esModuleInterop,
// under which a namespace import is not constructable and `new PDFDocument()`
// fails to compile.
import PDFDocument from 'pdfkit';
import type { Invoice, InvoiceParty } from './invoice.service';

/**
 * Renders a tax invoice to a PDF buffer with pdfkit.
 *
 * In memory only — nothing is written to disk. The deploy rsyncs with --delete
 * so server-side files do not survive, and the VM disk hit 97% recently.
 *
 * NOTE ON CURRENCY: pdfkit's built-in Helvetica is WinAnsi encoded and has no
 * rupee glyph, so amounts are written as "Rs." rather than the symbol used on
 * the web page. Pasting the symbol back in renders a broken character.
 *
 * Blank fields print as an em dash, exactly as the web invoice does, so the
 * document degrades identically while seller GSTINs are still being collected.
 * Yukizi's own registered details do not appear at all: this invoice is the
 * seller's to the buyer, and Yukizi is not a party to that sale.
 */

const PURPLE = '#593696';
const SLATE = '#475569';
const MUTED = '#94a3b8';
const BORDER = '#e2e8f0';

const DASH = '—';

/** Pure formatter, exported so it can be unit tested directly against the
 * PDF's compressed content streams instead of parsed out of them. */
export function formatMoney(n: number): string {
  return `Rs. ${Number(n ?? 0).toFixed(2)}`;
}

/** Pure formatter, exported for the same reason as {@link formatMoney}. */
export function formatInvoiceDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

@Injectable()
export class InvoicePdfService {
  /** A filesystem-safe attachment name, e.g. YKZ-INV-2026-27-00323711.pdf */
  filename(invoice: Invoice): string {
    const safe = invoice.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-');
    return `${safe}.pdf`;
  }

  async render(invoice: Invoice): Promise<Buffer> {
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

  private draw(doc: InstanceType<typeof PDFDocument>, invoice: Invoice): void {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ── Header ───────────────────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(PURPLE)
      .text('YUKIZI', left, 40);

    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .fillColor(PURPLE)
      .text('TAX INVOICE', left, 40, { width, align: 'right' });

    let y = 72;
    const meta: [string, string][] = [
      ['Invoice No.', invoice.invoiceNumber],
      ['Invoice Date', formatInvoiceDate(invoice.invoiceDate)],
      ['Order ID', invoice.orderReference],
    ];
    for (const [label, value] of meta) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(SLATE)
        .text(label, left, y, { width: width - 180, align: 'right' });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#0f172a')
        .text(value, right - 175, y, { width: 175, align: 'right' });
      y += 14;
    }

    y += 6;
    doc
      .moveTo(left, y)
      .lineTo(right, y)
      .lineWidth(1.5)
      .strokeColor(PURPLE)
      .stroke();
    y += 16;

    // ── On-behalf-of notice ──────────────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(PURPLE)
      .text('Generated via Yukizi Marketplace', left, y);
    y += 12;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(SLATE)
      .text(
        'This invoice is generated on behalf of the seller for the supply of goods to the customer.',
        left,
        y,
        { width },
      );
    y += 22;

    // ── Parties ──────────────────────────────────────────────
    const colWidth = width / 2 - 10;
    const partyTop = y;
    const sellerBottom = this.drawParty(
      doc,
      'SELLER (Supplier)',
      invoice.seller,
      left,
      partyTop,
      colWidth,
    );
    const buyerBottom = this.drawParty(
      doc,
      'BUYER (Customer)',
      invoice.buyer,
      left + colWidth + 20,
      partyTop,
      colWidth,
    );
    y = Math.max(sellerBottom, buyerBottom) + 18;

    // ── Line table ───────────────────────────────────────────
    // Widths sum to 465pt plus 8 gaps of 4pt = 497pt, inside the 515pt of usable
    // A4 width. Do NOT zero-pad these numbers: `010` is a legacy octal literal
    // and TypeScript rejects it outright.
    const cols = [
      { label: '#', w: 10, align: 'left' as const },
      { label: 'Item Description', w: 150, align: 'left' as const },
      { label: 'Qty', w: 30, align: 'center' as const },
      { label: 'Unit Price', w: 60, align: 'right' as const },
      { label: 'Taxable', w: 60, align: 'right' as const },
      { label: 'GST %', w: 40, align: 'center' as const },
      { label: 'GST Amt', w: 55, align: 'right' as const },
      { label: 'Total', w: 60, align: 'right' as const },
    ];

    const drawHeader = (top: number): number => {
      doc.rect(left, top, width, 18).fill(PURPLE);
      let x = left + 4;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
      for (const col of cols) {
        doc.text(col.label, x, top + 5.5, { width: col.w, align: col.align });
        x += col.w + 4;
      }
      return top + 18;
    };

    y = drawHeader(y);

    doc.font('Helvetica').fontSize(7.5);
    for (const line of invoice.lines) {
      // Start a new page before running off the bottom, and repeat the header.
      if (y > doc.page.height - 140) {
        doc.addPage();
        y = drawHeader(doc.page.margins.top);
        doc.font('Helvetica').fontSize(7.5);
      }

      const values = [
        String(line.serial),
        line.description,
        String(line.quantity),
        line.unitPrice.toFixed(2),
        line.taxableValue.toFixed(2),
        `${line.gstRate}%`,
        line.gstAmount.toFixed(2),
        line.totalAmount.toFixed(2),
      ];

      let x = left + 4;
      doc.fillColor(SLATE);
      values.forEach((value, i) => {
        doc.text(value, x, y + 5, {
          width: cols[i].w,
          align: cols[i].align,
          ellipsis: true,
          height: 10,
        });
        x += cols[i].w + 4;
      });

      y += 16;
      doc
        .moveTo(left, y)
        .lineTo(right, y)
        .lineWidth(0.5)
        .strokeColor(BORDER)
        .stroke();
    }

    y += 16;
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    // ── Totals ───────────────────────────────────────────────
    const totalsLeft = left + width / 2;
    const totalsWidth = width / 2;

    // Note to Customer, in the left column level with the totals. The web
    // invoice carries this and the PDF did not, and on a short invoice it also
    // fills what was otherwise a large empty band above the footer.
    const noteTop = y;
    const noteWidth = totalsWidth - 20;
    const noteInner = noteWidth - 16;
    const noteBody =
      'This is a tax invoice for the supply of goods. The products have been sold by the ' +
      'seller (Supplier) and this invoice is generated on their behalf by Yukizi Marketplace.';
    const noteBodyHeight = doc
      .font('Helvetica')
      .fontSize(8)
      .heightOfString(noteBody, { width: noteInner });

    doc
      .rect(left, noteTop, noteWidth, noteBodyHeight + 32)
      .fillAndStroke('#f8fafc', BORDER);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(PURPLE)
      .text('Note to Customer', left + 8, noteTop + 8, { width: noteInner });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(SLATE)
      .text(noteBody, left + 8, noteTop + 22, { width: noteInner });

    const row = (label: string, value: string, bold = false) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor(SLATE)
        .text(label, totalsLeft, y, { width: totalsWidth / 2 });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#0f172a')
        .text(value, totalsLeft + totalsWidth / 2, y, {
          width: totalsWidth / 2,
          align: 'right',
        });
      y += 14;
    };

    row('Subtotal (Taxable Value)', formatMoney(invoice.subtotal));

    // Stated rate by rate: a 5% item and an 18% item owe two lines, not one.
    if (invoice.taxBreakdown?.length) {
      for (const tax of invoice.taxBreakdown) {
        if (invoice.isIntraState) {
          row(`CGST (${tax.componentRate}%)`, formatMoney(tax.cgst));
          row(`SGST (${tax.componentRate}%)`, formatMoney(tax.sgst));
        } else {
          row(`IGST (${tax.componentRate}%)`, formatMoney(tax.igst));
        }
      }
    } else if (invoice.isIntraState) {
      row('CGST', formatMoney(invoice.cgst));
      row('SGST', formatMoney(invoice.sgst));
    } else {
      row('IGST', formatMoney(invoice.igst));
    }

    y += 4;
    doc.rect(totalsLeft, y, totalsWidth, 24).fill('#f3edfa');
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(PURPLE)
      .text('TOTAL AMOUNT PAYABLE', totalsLeft + 8, y + 7, {
        width: totalsWidth / 2,
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(PURPLE)
      .text(formatMoney(invoice.totalAmount), totalsLeft, y + 6, {
        width: totalsWidth - 8,
        align: 'right',
      });
    y += 34;

    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text('Amount in Words:', totalsLeft, y, { width: totalsWidth });
    y += 10;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#0f172a')
      .text(invoice.amountInWords, totalsLeft, y, { width: totalsWidth });
    y += 20;

    if (invoice.placeOfSupply) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(SLATE)
        .text(`Place of supply: ${invoice.placeOfSupply}`, left, y);
      y += 16;
    }

    // ── Assurances ───────────────────────────────────────────
    // Four columns, as on the web invoice. Purely decorative, so it is drawn
    // only when it genuinely fits above the footer — on a long multi-page
    // invoice it is skipped rather than allowed to collide with anything.
    const assurances: [string, string][] = [
      ['100% Authentic Products', 'Sourced directly from trusted sellers.'],
      ['Hassle-free Returns', 'Easy returns & refunds as per Yukizi policy.'],
      ['Need Help?', 'Email support@yukizi.com'],
      ['Secure Payments', 'Your transactions are safe and secure.'],
    ];
    const assuranceHeight = 44;
    if (y + assuranceHeight < doc.page.height - 130) {
      doc.rect(left, y, width, assuranceHeight).stroke(BORDER);
      const colWidth = (width - 32) / assurances.length;
      assurances.forEach(([title, body], i) => {
        const x = left + 12 + i * colWidth;
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(PURPLE)
          .text(title, x, y + 10, { width: colWidth - 8 });
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(MUTED)
          .text(body, x, y + 22, { width: colWidth - 8 });
      });
      y += assuranceHeight + 12;
    }

    // ── Footer ───────────────────────────────────────────────
    // This document is the seller's invoice to the buyer; Yukizi is the
    // marketplace they met on, not a party to the sale. So no Yukizi GSTIN or
    // CIN line here — the supplier's own registered details are printed with
    // the seller above, and empty labels for a company that is not selling
    // anything only made the invoice look unfinished.
    const footerTop = doc.page.height - 110;
    doc.rect(left, footerTop, width, 50).fill(PURPLE);
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#ffffff')
      .text(
        'Sold to you by the seller named above, whose registered details and',
        left + 10,
        footerTop + 10,
      )
      .text(
        'GSTIN appear with their address. Yukizi operates the marketplace.',
        left + 10,
        footerTop + 21,
      )
      .text(
        'Questions about this order: support@yukizi.com   |   yukizi.com',
        left + 10,
        footerTop + 34,
      );

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        'This is a system generated invoice and does not require signature.',
        left,
        footerTop + 58,
        { width, align: 'center' },
      );
  }

  private drawParty(
    doc: InstanceType<typeof PDFDocument>,
    title: string,
    party: InvoiceParty,
    x: number,
    top: number,
    width: number,
  ): number {
    let y = top;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(PURPLE)
      .text(title, x, y, { width });
    y += 13;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#0f172a')
      .text(party.name || DASH, x, y, { width });
    y += 13;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(SLATE)
      .text(`GSTIN: ${party.gstin || DASH}`, x, y, { width });
    y += 11;
    doc.text(party.address || DASH, x, y, { width });
    y = doc.y + 2;
    if (party.phone) {
      doc.text(`Phone: ${party.phone}`, x, y, { width });
      y = doc.y + 2;
    }
    if (party.email) {
      doc.text(`Email: ${party.email}`, x, y, { width });
      y = doc.y + 2;
    }
    return y;
  }
}
