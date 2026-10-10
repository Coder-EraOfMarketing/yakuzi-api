import { isPreOrder } from './pre-order.util';

describe('isPreOrder', () => {
  it('is true for a listing with a date', () => {
    expect(isPreOrder({ preOrderDeliveryDate: new Date('2026-12-15') })).toBe(true);
  });

  it('is true for a date that has already passed', () => {
    // A past date is a legitimate state: nothing unpublishes a listing
    // automatically, so the listing is still a pre-order and must still be
    // exempt from every stock rule.
    expect(isPreOrder({ preOrderDeliveryDate: new Date('2020-01-01') })).toBe(true);
  });

  it('accepts an ISO string, which is what arrives over HTTP', () => {
    expect(isPreOrder({ preOrderDeliveryDate: '2026-12-15T00:00:00.000Z' })).toBe(true);
  });

  it('is false for null', () => {
    expect(isPreOrder({ preOrderDeliveryDate: null })).toBe(false);
  });

  it('is false when the field is absent', () => {
    expect(isPreOrder({})).toBe(false);
  });

  it('is false for null or undefined input', () => {
    expect(isPreOrder(null)).toBe(false);
    expect(isPreOrder(undefined)).toBe(false);
  });
});
