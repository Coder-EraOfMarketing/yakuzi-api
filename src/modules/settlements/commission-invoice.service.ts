import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  buildCommissionInvoice,
  type CommissionInvoice,
  type IssuerDetails,
} from './commission-invoice';

/**
 * Loads a settlement and turns it into a commission invoice.
 *
 * One place, used by BOTH the admin preview and the email that goes to the
 * seller on payout — so what an admin checks before paying is by construction
 * the same document the seller receives, not a second rendering of it that
 * could drift.
 *
 * Read-only. Nothing here writes, sends, or changes a settlement's status.
 */

/** Yukizi's own registered details, from platform settings. */
export const ISSUER_SETTING_KEYS = {
  legalName: 'companyLegalName',
  gstin: 'companyGstin',
  address: 'companyAddress',
  state: 'companyState',
  email: 'companyEmail',
} as const;

@Injectable()
export class CommissionInvoiceService {
  private readonly logger = new Logger(CommissionInvoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Null when there is no such settlement — callers decide what that means. */
  async forSettlement(settlementId: string): Promise<CommissionInvoice | null> {
    const settlement = await this.prisma.sellerSettlement.findUnique({
      where: { id: settlementId },
      include: {
        seller: true,
        orderItem: { select: { orderId: true } },
      },
    });
    if (!settlement) return null;

    return buildCommissionInvoice(settlement, await this.issuer());
  }

  /** The seller's own email, for callers that need to send them something. */
  async recipientFor(settlementId: string): Promise<string | null> {
    const settlement = await this.prisma.sellerSettlement.findUnique({
      where: { id: settlementId },
      select: { seller: { select: { email: true } } },
    });
    return settlement?.seller?.email?.trim() || null;
  }

  /** Platform settings; anything missing degrades the document, never fails it. */
  private async issuer(): Promise<IssuerDetails> {
    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: { key: { in: Object.values(ISSUER_SETTING_KEYS) } },
      });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return {
        legalName: byKey.get(ISSUER_SETTING_KEYS.legalName),
        gstin: byKey.get(ISSUER_SETTING_KEYS.gstin),
        address: byKey.get(ISSUER_SETTING_KEYS.address),
        state: byKey.get(ISSUER_SETTING_KEYS.state),
        email: byKey.get(ISSUER_SETTING_KEYS.email),
      };
    } catch (error) {
      this.logger.warn(
        `Could not read company details: ${(error as Error)?.message}`,
      );
      return {};
    }
  }
}
