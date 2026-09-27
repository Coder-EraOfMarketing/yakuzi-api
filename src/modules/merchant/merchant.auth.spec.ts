/**
 * Merchant Center auth previously required a downloaded service-account key in
 * GOOGLE_MERCHANT_CREDENTIALS, which meant the daily sync silently skipped
 * until someone SSH'd into the server and pasted a private key into .env.
 * The API already runs on a GCP VM that has a service account attached, so
 * Application Default Credentials can do the same job with no key to create,
 * store or rotate.
 *
 * These cover the decision itself — which identity gets used, and what the
 * admin is told when none is available — because every branch either changes
 * who Google thinks we are, or changes whether the daily sync runs at all.
 *
 * The GoogleAuth client is mocked: a real one would reach for the GCP metadata
 * server, which is absent in CI and would make these hang rather than fail.
 */
import { MerchantAuthService } from './merchant.auth';
import type { MerchantConfig } from './merchant.config';

const getCredentials = jest.fn();
const getAccessToken = jest.fn();
const getClient = jest.fn();

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getCredentials: (...a: unknown[]) => getCredentials(...a),
    getClient: (...a: unknown[]) => getClient(...a),
  })),
  JWT: jest.fn().mockImplementation((opts: { email: string }) => ({
    email: opts.email,
    getAccessToken: (...a: unknown[]) => getAccessToken(...a),
  })),
}));

const baseConfig = (over: Partial<MerchantConfig> = {}): MerchantConfig => ({
  enabled: true,
  accountId: '5858711343',
  dataSourceId: '10749411022',
  credentials: null,
  siteUrl: 'https://yukizi.com',
  ...over,
});

const KEY = {
  client_email: 'feed-writer@yukizi-prod.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----\n',
};

describe('MerchantAuthService.identity', () => {
  let svc: MerchantAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new MerchantAuthService();
  });

  it('prefers an explicit key and does not touch the metadata server', async () => {
    // An explicit key must win: the Merchant Center account may belong to a
    // different Google project than the VM.
    const id = await svc.identity(baseConfig({ credentials: KEY }));

    expect(id.mode).toBe('key');
    expect(id.email).toBe(KEY.client_email);
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('falls back to the VM service account when no key is configured', async () => {
    getCredentials.mockResolvedValue({
      client_email: '1234-compute@developer.gserviceaccount.com',
    });

    const id = await svc.identity(baseConfig());

    expect(id.mode).toBe('adc');
    expect(id.email).toBe('1234-compute@developer.gserviceaccount.com');
  });

  it('reports mode none with actionable guidance when not on GCP', async () => {
    getCredentials.mockRejectedValue(new Error('metadata server unavailable'));

    const id = await svc.identity(baseConfig());

    expect(id.mode).toBe('none');
    expect(id.email).toBeNull();
    // The admin has to be told both ways out, not just the env var.
    expect(id.reason).toMatch(/GCP VM/);
    expect(id.reason).toMatch(/GOOGLE_MERCHANT_CREDENTIALS/);
  });

  it('reports none rather than adc when ADC resolves without an email', async () => {
    // Some credential types carry no client_email; claiming 'adc' there would
    // tell the admin to authorise an account we cannot name.
    getCredentials.mockResolvedValue({});

    const id = await svc.identity(baseConfig());

    expect(id.mode).toBe('none');
    expect(id.email).toBeNull();
  });

  it('never throws, and times out instead of hanging the admin request', async () => {
    // identity() runs inside "Check status". Off GCP the metadata lookup can
    // hang indefinitely, which would hang the admin panel rather than answer.
    getCredentials.mockImplementation(() => new Promise(() => {}));

    const id = await svc.identity(baseConfig());

    expect(id.mode).toBe('none');
    expect(id.reason).toBeDefined();
  }, 10000);
});

describe('MerchantAuthService.token', () => {
  let svc: MerchantAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new MerchantAuthService();
  });

  it('mints a JWT token from an explicit key', async () => {
    getAccessToken.mockResolvedValue({ token: 'key-token' });

    await expect(svc.token(baseConfig({ credentials: KEY }))).resolves.toBe('key-token');
  });

  it('mints a token from ADC when no key is configured', async () => {
    getClient.mockResolvedValue({
      getAccessToken: () => Promise.resolve({ token: 'adc-token' }),
    });

    await expect(svc.token(baseConfig())).resolves.toBe('adc-token');
  });

  it('throws a named error when ADC yields no token', async () => {
    getClient.mockResolvedValue({ getAccessToken: () => Promise.resolve({ token: null }) });

    await expect(svc.token(baseConfig())).rejects.toThrow(/Application Default Credentials/);
  });

  it('reuses the JWT across calls for the same key', async () => {
    getAccessToken.mockResolvedValue({ token: 't' });
    const cfg = baseConfig({ credentials: KEY });

    await svc.token(cfg);
    await svc.token(cfg);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JWT } = require('google-auth-library');
    expect(JWT).toHaveBeenCalledTimes(1);
  });
});
