import { OrdersService } from './orders.service';

/**
 * A Yukizi sale reduces stock, and the seller's connected sales channels have
 * to be told — otherwise the same unit stays purchasable on Shopify,
 * WooCommerce and Amazon until the next hourly sweep, which is long enough to
 * sell it twice.
 *
 * The private helper is exercised directly: driving a full checkout through
 * this service would need the whole cart/payment/address graph mocked, and
 * what matters here is the contract with the integrations layer.
 */
const build = () => {
  const inventoryService = { getTotalStock: jest.fn().mockResolvedValue(4) };
  const integrationEvents = {
    fanOutYukiziChange: jest.fn().mockResolvedValue(1),
  };

  const service = new OrdersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    inventoryService as never,
    integrationEvents as never,
  );

  const notify = (offers: { sellerId: string; sellerOfferId: string }[]) =>
    (service as unknown as {
      notifyChannelsOfStockChange: (
        o: { sellerId: string; sellerOfferId: string }[],
      ) => Promise<void>;
    }).notifyChannelsOfStockChange(offers);

  return { service, notify, inventoryService, integrationEvents };
};

describe('OrdersService — telling channels a Yukizi sale moved stock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fans out the post-sale quantity for each listing sold', async () => {
    const { notify, integrationEvents } = build();

    await notify([{ sellerId: 'seller-1', sellerOfferId: 'offer-1' }]);

    // The absolute remaining quantity, not a delta — channels are set, not
    // decremented, so a retry cannot compound.
    expect(integrationEvents.fanOutYukiziChange).toHaveBeenCalledWith(
      'seller-1',
      'offer-1',
      4,
    );
  });

  it('notifies once per listing even when it appears on several order lines', async () => {
    const { notify, integrationEvents } = build();

    await notify([
      { sellerId: 'seller-1', sellerOfferId: 'offer-1' },
      { sellerId: 'seller-1', sellerOfferId: 'offer-1' },
      { sellerId: 'seller-2', sellerOfferId: 'offer-2' },
    ]);

    expect(integrationEvents.fanOutYukiziChange).toHaveBeenCalledTimes(2);
  });

  it('does no work when the checkout touched nothing', async () => {
    const { notify, inventoryService, integrationEvents } = build();

    await notify([]);

    expect(inventoryService.getTotalStock).not.toHaveBeenCalled();
    expect(integrationEvents.fanOutYukiziChange).not.toHaveBeenCalled();
  });

  it('stays silent when the integrations layer is absent, so checkout is unaffected', async () => {
    const service = new OrdersService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined as never,
      undefined as never,
    );

    await expect(
      (service as unknown as {
        notifyChannelsOfStockChange: (
          o: { sellerId: string; sellerOfferId: string }[],
        ) => Promise<void>;
      }).notifyChannelsOfStockChange([
        { sellerId: 'seller-1', sellerOfferId: 'offer-1' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('surfaces a failure to the caller, which swallows it — an order must never fail over this', async () => {
    const { notify, integrationEvents } = build();
    integrationEvents.fanOutYukiziChange.mockRejectedValue(
      new Error('channel unreachable'),
    );

    // checkout() wraps this in .catch(); the rejection must be a normal one.
    await expect(
      notify([{ sellerId: 'seller-1', sellerOfferId: 'offer-1' }]),
    ).rejects.toThrow('channel unreachable');
  });
});
