import { SettlementsService } from './settlements.service';
import { payoutOfferSelect } from './payout-calculator';
import { FULFILLMENT_MODE_SHIPROCKET } from '../../common/utils/shipping.util';

/**
 * The three projection surfaces — the seller's settlement list, the seller
 * summary and the admin settlement list — each load an order item and hand it
 * to the payout engine. All three used a hand-rolled
 * `sellerOffer: { include: { catalogProduct: true } }`, which reaches the
 * catalogue product by ONE of its two routes and fetches none of the taxonomy
 * rates. A variant-linked offer therefore projected 0% commission in silence,
 * exactly the failure #189 fixed in the settlement WRITERS.
 *
 * These tests are only meaningful because the prisma stand-in below honours
 * the query's selection the way the database does.
 */

const isRelation = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !(value instanceof Date);

/** A relation fetched with `true` arrives with its scalars and none of ITS relations. */
const scalars = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => !isRelation(v)));

/**
 * Project a stored row through a prisma selection.
 *
 * This is the whole point of the fixture: a relation the query did not ask for
 * comes back ABSENT, not populated. A mock that returned the full row whatever
 * was selected could not tell a correct include from the broken one — it would
 * pass either way, which is how this bug survived three release cycles.
 */
function project(row: any, selection: any): any {
  if (row == null) return row;
  if (selection === true) return isRelation(row) ? scalars(row) : row;

  if (selection.select) {
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(selection.select)) {
      out[key] = project(row[key], sub);
    }
    return out;
  }

  if (selection.include) {
    const out = scalars(row);
    for (const [key, sub] of Object.entries(selection.include)) {
      out[key] = project(row[key], sub);
    }
    return out;
  }

  return scalars(row);
}

/** 15% commission, 18% GST, configured on the catalogue product itself. */
const CATALOG_PRODUCT = {
  id: 'cp-1',
  name: 'Vitamin C Serum',
  commissionPercent: 15,
  commissionGstPercent: 18,
  subCategory: null,
  category: null,
};

/**
 * The client's real order, stored as the database holds it: ₹11 product,
 * ₹6 shipping, platform-shipped, and an offer that reaches its master ONLY
 * through its variant (catalogProductId is genuinely null on the offer).
 */
const STORED_ITEM = {
  id: 'item-1',
  sellerId: 'seller-1',
  orderId: 'order-1',
  quantity: 1,
  unitPrice: 11,
  totalPrice: 17,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  order: { fulfillmentMode: FULFILLMENT_MODE_SHIPROCKET },
  seller: { id: 'seller-1', companyName: 'Acme Labs', userId: 'user-1' },
  sellerOffer: {
    id: 'offer-1',
    name: 'Vitamin C Serum 30ml',
    mrp: 11,
    finalShippingPrice: 6,
    shippingCharges: 6,
    // Not linked directly — only through the variant.
    catalogProduct: null,
    variant: { catalogProduct: CATALOG_PRODUCT },
  },
};

function makePrisma() {
  const orderItemFindMany = jest.fn(async (args: any) => [
    project(STORED_ITEM, { include: args.include }),
  ]);

  return {
    orderItemFindMany,
    prisma: {
      sellerProfile: {
        findUnique: jest.fn(async () => ({ id: 'seller-1', userId: 'user-1' })),
      },
      sellerSettlement: {
        findMany: jest.fn(async () => []),
      },
      orderItem: { findMany: orderItemFindMany },
    },
  };
}

describe('SettlementsService — projected commission on a variant-linked offer', () => {
  // 15% of the ₹11 product, never of the ₹17 total. 0 is the bug.
  const EXPECTED_COMMISSION = 1.65;
  const EXPECTED_GST = 0.3;

  it('the seller settlement list projects the real rate, not 0%', async () => {
    const { prisma, orderItemFindMany } = makePrisma();
    const service = new SettlementsService(prisma as never);

    const rows = await service.getSellerSettlements('user-1');
    const projected = rows.find((r: any) => r.payoutStatus === 'PROJECTED');

    expect(Number(projected.commission)).toBe(EXPECTED_COMMISSION);
    expect(Number(projected.commissionGst)).toBe(EXPECTED_GST);
    expect(Number(projected.grossAmount)).toBe(17);
    // Pinned so the include cannot drift back to a hand-rolled one.
    expect(orderItemFindMany.mock.calls[0][0].include.sellerOffer).toEqual({
      select: payoutOfferSelect,
    });
  });

  it('the seller summary counts the real rate into pendingPayouts, not 0%', async () => {
    const { prisma, orderItemFindMany } = makePrisma();
    const service = new SettlementsService(prisma as never);

    const summary = await service.getSellerSummary('user-1');

    // 17 - (1.65 + 0.30 + 6 withheld) = 9.05. The bug paid out 11.00, having
    // charged no commission and no GST at all.
    expect(summary.pendingPayouts).toBe(9.05);
    expect(orderItemFindMany.mock.calls[0][0].include.sellerOffer).toEqual({
      select: payoutOfferSelect,
    });
  });

  it('the admin settlement list projects the real rate, not 0%', async () => {
    const { prisma, orderItemFindMany } = makePrisma();
    const service = new SettlementsService(prisma as never);

    const rows = (await service.getAllSettlements('PROJECTED')) as any[];
    const projected = rows.find((r: any) => r.payoutStatus === 'PROJECTED');

    expect(Number(projected.commission)).toBe(EXPECTED_COMMISSION);
    expect(Number(projected.commissionGst)).toBe(EXPECTED_GST);
    expect(orderItemFindMany.mock.calls[0][0].include.sellerOffer).toEqual({
      select: payoutOfferSelect,
    });
  });

  /**
   * Guards the fixture itself. If `project` ever stopped honouring the
   * selection, the three tests above would pass against a broken include and
   * silently stop testing anything.
   */
  it('the fixture really does withhold an unselected relation', () => {
    const hand = project(STORED_ITEM, {
      include: { sellerOffer: { include: { catalogProduct: true } } },
    });

    expect(hand.sellerOffer.catalogProduct).toBeNull();
    expect(hand.sellerOffer.variant).toBeUndefined();

    const correct = project(STORED_ITEM, {
      include: { sellerOffer: { select: payoutOfferSelect } },
    });

    expect(correct.sellerOffer.variant.catalogProduct.commissionPercent).toBe(15);
  });
});
