import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role, TicketStatus } from '@prisma/client';
import { TicketsService } from './tickets.service';

/**
 * Either side may close a ticket: the buyer who raised it, once their problem
 * is solved, or support. The buyer's "Close ticket" button has existed all
 * along and called an endpoint that did not — these cover the endpoint it was
 * calling into thin air.
 */
describe('TicketsService.closeTicket', () => {
  const TICKET = '11111111-2222-3333-4444-555555555555';
  const OWNER = 'buyer-1';

  const build = (
    ticket: { userId: string; status: TicketStatus } | null = {
      userId: OWNER,
      status: TicketStatus.OPEN,
    },
  ) => {
    const prisma = {
      ticket: {
        findUnique: jest
          .fn()
          .mockResolvedValue(ticket ? { id: TICKET, ...ticket } : null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new TicketsService(prisma as never);
    // getTicketById re-reads and re-authorizes; stubbed so these tests are
    // about closing, not about the read it returns.
    jest
      .spyOn(service, 'getTicketById')
      .mockResolvedValue({ id: TICKET, status: 'CLOSED' } as never);
    return { service, prisma };
  };

  it('lets the buyer close their own ticket', async () => {
    const { service, prisma } = build();

    await service.closeTicket(OWNER, Role.BUYER, TICKET);

    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: TICKET },
      data: { status: TicketStatus.CLOSED },
    });
  });

  it('lets support close somebody else’s ticket', async () => {
    const { service, prisma } = build();

    await service.closeTicket('admin-1', Role.ADMIN, TICKET);

    expect(prisma.ticket.update).toHaveBeenCalled();
  });

  it('refuses another buyer', async () => {
    const { service, prisma } = build();

    await expect(
      service.closeTicket('someone-else', Role.BUYER, TICKET),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('404s on a ticket that does not exist', async () => {
    const { service } = build(null);

    await expect(
      service.closeTicket(OWNER, Role.BUYER, TICKET),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats closing an already-closed ticket as success, not an error', async () => {
    // The button can be pressed twice, and support and the buyer can close the
    // same ticket at the same moment.
    const { service, prisma } = build({ userId: OWNER, status: TicketStatus.CLOSED });

    await expect(
      service.closeTicket(OWNER, Role.BUYER, TICKET),
    ).resolves.toBeDefined();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });
});
