import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrdersController } from './orders.controller';
import type { InvoiceEmailOutcome } from './invoice-email.service';

const ORDER_ID = '00323711-1111-2222-3333-444444444444';
const USER_ID = 'buyer-1';

const build = () => {
  const invoiceService = {
    getInvoicesForOrder: jest.fn().mockResolvedValue([{ invoiceNumber: 'x' }]),
  };
  const invoiceEmailService = {
    resendForOrder: jest.fn(),
  };
  const invoicePdfService = {
    render: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.3 fake')),
    filename: jest.fn().mockReturnValue('YKZ-INV-2026-27-00323711.pdf'),
  };

  const controller = new OrdersController(
    {} as never,
    {} as never,
    invoiceService as never,
    invoiceEmailService as never,
    invoicePdfService as never,
  );

  return { controller, invoiceService, invoiceEmailService, invoicePdfService };
};

/** Minimal express Response stand-in that records what was written to it. */
const fakeResponse = () => {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    body: undefined as Buffer | undefined,
    setHeader: jest.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    send: jest.fn((payload: Buffer) => {
      res.body = payload;
    }),
  };
  return res;
};

// This is the ONLY place in the codebase that turns an InvoiceEmailOutcome
// into an HTTP status. sendForOrders/resendForOrder never throw, so every
// distinction a caller sees comes from this mapping — get it wrong here and
// a caller-fixable problem (no email on file) and a server problem (SMTP
// down) both read as the same thing again, which is the exact silent-success
// pattern this endpoint exists to avoid.
describe('OrdersController.emailOrderInvoices', () => {
  it('runs the ownership guard before ever calling resendForOrder', async () => {
    const { controller, invoiceService, invoiceEmailService } = build();
    invoiceService.getInvoicesForOrder.mockRejectedValue(
      new ForbiddenException('This order belongs to another account'),
    );

    await expect(
      controller.emailOrderInvoices(USER_ID, ORDER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(invoiceEmailService.resendForOrder).not.toHaveBeenCalled();
  });

  it('returns 200 with sent:true on success', async () => {
    const { controller, invoiceEmailService } = build();
    invoiceEmailService.resendForOrder.mockResolvedValue({
      sent: true,
    } satisfies InvoiceEmailOutcome);

    const result = await controller.emailOrderInvoices(USER_ID, ORDER_ID);

    expect(result).toEqual({
      message: 'Invoice emailed successfully',
      data: { sent: true },
    });
  });

  it('maps no-recipient to 422', async () => {
    const { controller, invoiceEmailService } = build();
    invoiceEmailService.resendForOrder.mockResolvedValue({
      sent: false,
      reason: 'no-recipient',
    } satisfies InvoiceEmailOutcome);

    await expect(
      controller.emailOrderInvoices(USER_ID, ORDER_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps nothing-to-send to 404', async () => {
    const { controller, invoiceEmailService } = build();
    invoiceEmailService.resendForOrder.mockResolvedValue({
      sent: false,
      reason: 'nothing-to-send',
    } satisfies InvoiceEmailOutcome);

    await expect(
      controller.emailOrderInvoices(USER_ID, ORDER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps not-configured to 503, without leaking the reason to the client', async () => {
    const { controller, invoiceEmailService } = build();
    invoiceEmailService.resendForOrder.mockResolvedValue({
      sent: false,
      reason: 'not-configured',
    } satisfies InvoiceEmailOutcome);

    const error: unknown = await controller
      .emailOrderInvoices(USER_ID, ORDER_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).not.toMatch(
      /not-configured|smtp/i,
    );
  });

  it('maps send-failed to 503, without leaking the reason to the client', async () => {
    const { controller, invoiceEmailService } = build();
    invoiceEmailService.resendForOrder.mockResolvedValue({
      sent: false,
      reason: 'send-failed',
    } satisfies InvoiceEmailOutcome);

    const error: unknown = await controller
      .emailOrderInvoices(USER_ID, ORDER_ID)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).not.toMatch(
      /send-failed/i,
    );
  });
});

/**
 * The download reuses getInvoicesForOrder purely for its access rules — that
 * method returns a SELLER only the invoices they supplied, so the seller
 * isolation on a shared order is inherited rather than re-implemented here.
 * These pin that inheritance down: if the download ever stops going through
 * it, a seller could pull a co-seller's invoice, which names their customer.
 */
describe('OrdersController.downloadOrderInvoicePdf', () => {
  const SELLER_ID = '11111111-2222-3333-4444-555555555555';

  it('sends the PDF as an attachment named after the invoice', async () => {
    const { controller, invoiceService, invoicePdfService } = build();
    const invoice = { invoiceNumber: 'YKZ/INV/2026-27/00323711', sellerId: SELLER_ID };
    invoiceService.getInvoicesForOrder.mockResolvedValue([invoice]);
    const res = fakeResponse();

    await controller.downloadOrderInvoicePdf(
      USER_ID,
      ORDER_ID,
      SELLER_ID,
      res as never,
    );

    expect(invoicePdfService.render).toHaveBeenCalledWith(invoice);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="YKZ-INV-2026-27-00323711.pdf"',
    );
    expect(res.body?.toString()).toContain('%PDF');
  });

  it('never lets a shared cache keep a document naming the buyer', async () => {
    const { controller, invoiceService } = build();
    invoiceService.getInvoicesForOrder.mockResolvedValue([
      { invoiceNumber: 'x', sellerId: SELLER_ID },
    ]);
    const res = fakeResponse();

    await controller.downloadOrderInvoicePdf(
      USER_ID,
      ORDER_ID,
      SELLER_ID,
      res as never,
    );

    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('picks the right invoice off a multi-seller order', async () => {
    const { controller, invoiceService, invoicePdfService } = build();
    const wanted = { invoiceNumber: 'wanted', sellerId: SELLER_ID };
    invoiceService.getInvoicesForOrder.mockResolvedValue([
      { invoiceNumber: 'other', sellerId: 'aaaaaaaa-2222-3333-4444-555555555555' },
      wanted,
    ]);

    await controller.downloadOrderInvoicePdf(
      USER_ID,
      ORDER_ID,
      SELLER_ID,
      fakeResponse() as never,
    );

    expect(invoicePdfService.render).toHaveBeenCalledWith(wanted);
  });

  it('404s when that seller supplied nothing on the order', async () => {
    const { controller, invoiceService, invoicePdfService } = build();
    invoiceService.getInvoicesForOrder.mockResolvedValue([
      { invoiceNumber: 'other', sellerId: 'aaaaaaaa-2222-3333-4444-555555555555' },
    ]);

    await expect(
      controller.downloadOrderInvoicePdf(
        USER_ID,
        ORDER_ID,
        SELLER_ID,
        fakeResponse() as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(invoicePdfService.render).not.toHaveBeenCalled();
  });

  it('runs the ownership guard before rendering anything', async () => {
    const { controller, invoiceService, invoicePdfService } = build();
    invoiceService.getInvoicesForOrder.mockRejectedValue(
      new ForbiddenException('This order belongs to another account'),
    );

    await expect(
      controller.downloadOrderInvoicePdf(
        USER_ID,
        ORDER_ID,
        SELLER_ID,
        fakeResponse() as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(invoicePdfService.render).not.toHaveBeenCalled();
  });
});
