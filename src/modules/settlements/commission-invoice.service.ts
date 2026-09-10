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

/**
 * Yukizi's own registered details, from GST registration certificate
 * 27AACCY1892P1ZJ (Form GST REG-06, issued 30/07/2026, Regular registration,
 * jurisdictional office Mumbai).
 *
 * Hardcoded as the FALLBACK, with the platform settings above overriding any
 * field — the same config-first-with-a-default convention TEST_BUYER_PHONES
 * uses. The alternative was leaving them blank until somebody remembered to
 * type them in, and a commission invoice without the issuer's GSTIN is not a
 * tax invoice at all: the seller cannot claim input credit against it.
 *
 * These are transcribed from the certificate, not guessed. If the company
 * moves or re-registers, set the platform settings — do not let this drift.
 */
const REGISTERED_DETAILS = {
  legalName: 'Yukizi Market Services Private Limited',
  gstin: '27AACCY1892P1ZJ',
  // Principal place of business, as on the certificate.
  address:
    'Flat No. 103, Phase 2 Laxmi Narayan Residency, Devdaya Nagar, ' +
    'Off Pokhran Road, Thane, Maharashtra 400606',
  // Drives CGST + SGST against a Maharashtra seller, IGST against the rest.
  state: 'Maharashtra',
  email: 'support@yukizi.com',
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
      // A setting wins only when it actually holds something: a blank row must
      // not wipe a registered detail off a tax invoice.
      const setting = (key: string) => byKey.get(key)?.trim() || undefined;

      return {
        legalName: setting(ISSUER_SETTING_KEYS.legalName) ?? REGISTERED_DETAILS.legalName,
        gstin: setting(ISSUER_SETTING_KEYS.gstin) ?? REGISTERED_DETAILS.gstin,
        address: setting(ISSUER_SETTING_KEYS.address) ?? REGISTERED_DETAILS.address,
        state: setting(ISSUER_SETTING_KEYS.state) ?? REGISTERED_DETAILS.state,
        email: setting(ISSUER_SETTING_KEYS.email) ?? REGISTERED_DETAILS.email,
      };
    } catch (error) {
      // Even with the settings table unreachable the registered details are
      // known, so the document is still a valid tax invoice.
      this.logger.warn(
        `Could not read company details, using the registered ones: ${(error as Error)?.message}`,
      );
      return { ...REGISTERED_DETAILS };
    }
  }
}
