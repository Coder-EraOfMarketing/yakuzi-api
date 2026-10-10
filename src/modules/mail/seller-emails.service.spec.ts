import { SellerEmailsService } from './seller-emails.service';

const UNIQUE_VIOLATION = Object.assign(new Error('unique'), { code: 'P2002' });

const buildPrisma = () => ({
  emailDispatch: {
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  order: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn() },
  sellerOffer: { findUnique: jest.fn() },
});

const build = (mailOver: Record<string, unknown> = {}) => {
  const prisma = buildPrisma();
  const mail = {
    isConfigured: jest.fn().mockReturnValue(true),
    sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }),
    ...mailOver,
  };
  const service = new SellerEmailsService(prisma as never, mail as never);
  return { service, prisma, mail };
};

const offer = (name: string) => ({
  id: 'offer-1',
  name,
  slug: null,
  catalogProduct: { id: 'cat-1', name, slug: 'x', images: [] },
});

const sellerItem = (sellerId: string, company: string, email: string | null, name = 'Gojo Figure') => ({
  quantity: 1,
  totalPrice: 3999,
  sellerId,
  seller: { id: sellerId, companyName: company, user: { email } },
  sellerOffer: offer(name),
});

describe('SellerEmailsService', () => {
  describe('sendOrderCancelled', () => {
    it('tells the seller in the clearest possible terms not to ship', async () => {
      const { service, prisma, mail } = build();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1234',
        cancellationReason: 'Buyer changed their mind',
        items: [sellerItem('seller-1', 'Acme Collectibles', 'acme@example.com')],
      });

      await service.sendOrderCancelled('order-1234');

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('acme@example.com');
      expect(sent.subject.toLowerCase()).toContain('do not ship');
      expect(sent.html).toContain('Buyer changed their mind');
      expect(sent.text).toContain('DO NOT SHIP');
    });

    it('emails each seller separately, and only about their own items', async () => {
      const { service, prisma, mail } = build();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1234',
        cancellationReason: null,
        items: [
          sellerItem('seller-1', 'Acme', 'acme@example.com', 'Gojo Figure'),
          sellerItem('seller-2', 'Beta', 'beta@example.com', 'Nezuko Figure'),
        ],
      });

      await service.sendOrderCancelled('order-1234');

      expect(mail.sendMail).toHaveBeenCalledTimes(2);
      const [first, second] = mail.sendMail.mock.calls.map((c: any[]) => c[0]);
      expect(first.html).toContain('Gojo Figure');
      expect(first.html).not.toContain('Nezuko Figure');
      expect(second.html).toContain('Nezuko Figure');
      expect(second.html).not.toContain('Gojo Figure');
    });

    it('claims per seller, so one seller already told does not silence the other', async () => {
      const { service, prisma, mail } = build();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1234',
        cancellationReason: null,
        items: [
          sellerItem('seller-1', 'Acme', 'acme@example.com'),
          sellerItem('seller-2', 'Beta', 'beta@example.com'),
        ],
      });
      prisma.emailDispatch.create.mockRejectedValueOnce(UNIQUE_VIOLATION);

      await service.sendOrderCancelled('order-1234');

      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      expect(mail.sendMail.mock.calls[0][0].to).toBe('beta@example.com');
    });

    it('skips a seller with no email rather than failing the rest', async () => {
      const { service, prisma, mail } = build();
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1234',
        cancellationReason: null,
        items: [
          sellerItem('seller-1', 'Acme', null),
          sellerItem('seller-2', 'Beta', 'beta@example.com'),
        ],
      });

      await service.sendOrderCancelled('order-1234');

      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      expect(mail.sendMail.mock.calls[0][0].to).toBe('beta@example.com');
    });

    it('never throws', async () => {
      const { service, prisma } = build();
      prisma.order.findUnique.mockRejectedValue(new Error('db down'));
      await expect(service.sendOrderCancelled('order-1234')).resolves.toBeUndefined();
    });
  });

  describe('sendStockAlert', () => {
    const listing = (over: Record<string, unknown> = {}) => ({
      id: 'offer-1',
      name: 'Gojo Figure',
      slug: null,
      isActive: true,
      deletedAt: null,
      sellerId: 'seller-1',
      seller: { companyName: 'Acme', user: { email: 'acme@example.com' } },
      catalogProduct: { id: 'cat-1', name: 'Gojo Figure', slug: 'gojo', images: [] },
      ...over,
    });

    it('says sold out when the stock is zero', async () => {
      const { service, prisma, mail } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(listing());

      await service.sendStockAlert('offer-1', 0, 10);

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.subject).toContain('Out of stock');
      expect(sent.html).toContain('sold out');
    });

    it('says how many are left when it is merely low', async () => {
      const { service, prisma, mail } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(listing());

      await service.sendStockAlert('offer-1', 3, 10);

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.subject).toContain('3 left');
      expect(sent.html).toContain('Only 3 left');
    });

    it('keys the claim to the product, the state and the day', async () => {
      const { service, prisma } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(listing());

      await service.sendStockAlert('offer-1', 3, 10);

      const key = prisma.emailDispatch.create.mock.calls[0][0].data.dedupeKey;
      expect(key).toMatch(/^offer-1:low:\d{4}-\d{2}-\d{2}$/);
    });

    it('stays quiet about a delisted or deleted product', async () => {
      const { service, prisma, mail } = build();

      prisma.sellerOffer.findUnique.mockResolvedValue(listing({ isActive: false }));
      await service.sendStockAlert('offer-1', 0, 10);

      prisma.sellerOffer.findUnique.mockResolvedValue(
        listing({ deletedAt: new Date() }),
      );
      await service.sendStockAlert('offer-1', 0, 10);

      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('stays quiet about a pre-order at stock 0 — it never had stock to sell out', async () => {
      const { service, prisma, mail } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(
        listing({ preOrderDeliveryDate: new Date('2026-12-01') }),
      );

      await service.sendStockAlert('offer-1', 0, 10);

      expect(mail.sendMail).not.toHaveBeenCalled();
      expect(prisma.emailDispatch.create).not.toHaveBeenCalled();
    });

    it('still says sold out for an ordinary offer at stock 0 (no regression)', async () => {
      const { service, prisma, mail } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(listing());

      await service.sendStockAlert('offer-1', 0, 10);

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.subject).toContain('Out of stock');
      expect(sent.html).toContain('sold out');
    });

    it('still warns an ordinary offer at low-but-nonzero stock (no regression)', async () => {
      const { service, prisma, mail } = build();
      prisma.sellerOffer.findUnique.mockResolvedValue(listing());

      await service.sendStockAlert('offer-1', 3, 10);

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.subject).toContain('3 left');
      expect(sent.html).toContain('Only 3 left');
    });
  });

  describe('sendTicketRaised', () => {
    it('forwards what the buyer said, and makes clear support owns it', async () => {
      const { service, prisma, mail } = build();
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        subject: 'Box arrived crushed',
        orderId: 'order-1234',
        messages: [{ message: 'The outer box was crushed on one corner.' }],
        order: {
          id: 'order-1234',
          items: [sellerItem('seller-1', 'Acme', 'acme@example.com')],
        },
      });

      await service.sendTicketRaised('ticket-1');

      const sent = mail.sendMail.mock.calls[0][0];
      expect(sent.html).toContain('Box arrived crushed');
      expect(sent.html).toContain('The outer box was crushed on one corner.');
      expect(sent.html).toContain('support is handling this');
    });

    it('says nothing when the ticket is not about a particular order', async () => {
      const { service, prisma, mail } = build();
      prisma.ticket.findUnique.mockResolvedValue({
        id: 'ticket-1',
        subject: 'General question',
        orderId: null,
        messages: [{ message: 'Do you ship to Nepal?' }],
        order: null,
      });

      await service.sendTicketRaised('ticket-1');

      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  it('sends and claims nothing at all when SMTP is unconfigured', async () => {
    const { service, prisma, mail } = build({
      isConfigured: jest.fn().mockReturnValue(false),
    });

    await service.sendOrderCancelled('order-1234');

    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(prisma.emailDispatch.create).not.toHaveBeenCalled();
  });
});
