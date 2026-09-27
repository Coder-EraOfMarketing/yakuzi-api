/**
 * The Merchant Center settings panel showed only "Could not read Merchant
 * Center status", for every admin, with the endpoint deployed and healthy.
 *
 * This API has no global response-transform interceptor, so whatever a
 * controller returns is exactly what reaches the browser. Every other
 * controller returns `{ message, data }` and the admin client unwraps
 * `data.data` — but this one returned its payload bare, so the client read
 * `undefined` and threw while rendering. Both endpoints were affected: Dry run
 * and Sync now failed the same way.
 *
 * These assert the envelope itself rather than the payload, because the
 * envelope is the part that broke and the part nothing else would catch: the
 * bare version type-checked, built and returned HTTP 200.
 */
import { MerchantController } from './merchant.controller';
import type { MerchantSyncService } from './merchant-sync.service';
import type { MerchantConfigService } from './merchant.config';

describe('MerchantController response envelope', () => {
  const lastRun = { ran: true, pushed: 4, failed: 0, skipped: [] };

  const identity = { mode: 'adc' as const, email: 'vm@project.iam.gserviceaccount.com' };

  function build(problems: string[]) {
    const config = {
      problems: jest.fn().mockResolvedValue(problems),
      identity: jest.fn().mockResolvedValue(identity),
    };
    const sync = {
      lastRun: jest.fn().mockResolvedValue(lastRun),
      syncAll: jest.fn().mockResolvedValue({ ...lastRun, dryRun: true }),
    };
    const controller = new MerchantController(
      sync as unknown as MerchantSyncService,
      config as unknown as MerchantConfigService,
    );
    return { controller, sync, config };
  }

  it('wraps status in { message, data } so the admin client can unwrap it', async () => {
    const { controller } = build([]);
    const res = await controller.status();

    // The exact shape the admin client reads: `response.data.data`.
    expect(res).toHaveProperty('message');
    expect(res).toHaveProperty('data');
    expect(res.data).toBeDefined();
  });

  it('reports ready with no problems', async () => {
    const { controller } = build([]);
    const { data } = await controller.status();

    expect(data.ready).toBe(true);
    expect(data.problems).toEqual([]);
    expect(data.lastSync).toEqual(lastRun);
    // The panel needs this to tell the admin which account to authorise in
    // Merchant Center — with ADC there is no key file to read it from.
    expect(data.identity).toEqual(identity);
  });

  it('reports not ready and passes the problems through verbatim', async () => {
    const problems = [
      'Merchant Center account id is not set.',
      'GOOGLE_MERCHANT_CREDENTIALS (the service-account key) is not set on the server.',
    ];
    const { controller } = build(problems);
    const { data } = await controller.status();

    expect(data.ready).toBe(false);
    expect(data.problems).toEqual(problems);
  });

  it('does not put status fields at the top level, where the client cannot see them', async () => {
    // Guards the exact regression: a bare `{ ready, problems, lastSync }`
    // return would satisfy every other assertion a payload test might make.
    const { controller } = build([]);
    const res = await controller.status() as Record<string, unknown>;

    expect(res.ready).toBeUndefined();
    expect(res.problems).toBeUndefined();
    expect(res.lastSync).toBeUndefined();
  });

  it('wraps the sync result too, and forwards the dryRun flag', async () => {
    const { controller, sync } = build([]);
    const res = await controller.runSync({ dryRun: true });

    expect(sync.syncAll).toHaveBeenCalledWith({ dryRun: true });
    expect(res).toHaveProperty('message');
    expect(res.data).toBeDefined();
    expect((res.data as { ran: boolean }).ran).toBe(true);
  });

  it('treats a missing body as a live run, not a dry run', async () => {
    const { controller, sync } = build([]);
    await controller.runSync();

    expect(sync.syncAll).toHaveBeenCalledWith({ dryRun: false });
  });
});
