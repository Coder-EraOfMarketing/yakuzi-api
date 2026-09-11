import { ChatbotConfigService, DEFAULT_CONFIG } from './chatbot-config.service';

/**
 * The daily limits are the only thing standing between a public chat box and an
 * unbounded AI bill, so they are covered at the boundaries: the message that is
 * allowed, the one that is not, and what happens when the database is unwell.
 */
describe('ChatbotConfigService.authorizeMessage', () => {
  const VISITOR = 'v:abc123';

  const build = (
    config: Partial<typeof DEFAULT_CONFIG> = {},
    counts: Record<string, number> = {},
  ) => {
    const upserts: Array<{ day: string; visitorKey: string }> = [];
    const prisma = {
      chatbotConfig: {
        findUnique: jest.fn().mockResolvedValue({ ...DEFAULT_CONFIG, ...config }),
      },
      chatbotUsageDay: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve({ count: counts[where.day_visitorKey.visitorKey] ?? 0 }),
        ),
        upsert: jest.fn(({ where }: any) => {
          upserts.push(where.day_visitorKey);
          return Promise.resolve({});
        }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      chatbotRule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { service: new ChatbotConfigService(prisma as never), prisma, upserts };
  };

  it('allows a message when both caps have room, and counts it', async () => {
    const { service, upserts } = build();

    const decision = await service.authorizeMessage(VISITOR);

    expect(decision.allowed).toBe(true);
    // The visitor's own bucket and the site-wide one both move.
    expect(upserts.map((u) => u.visitorKey).sort()).toEqual(['__all__', VISITOR]);
  });

  it('stops a visitor who has used their allowance, in the assistant’s own words', async () => {
    const { service } = build(
      { maxMessagesPerVisitorPerDay: 5, limitReachedMessage: 'Come back tomorrow.' },
      { [VISITOR]: 5 },
    );

    const decision = await service.authorizeMessage(VISITOR);

    expect(decision).toMatchObject({ allowed: false, reason: 'visitor_limit', message: 'Come back tomorrow.' });
  });

  it('stops everyone once the site-wide ceiling is reached', async () => {
    const { service } = build({ maxMessagesPerDay: 100 }, { __all__: 100 });

    const decision = await service.authorizeMessage('v:someone-new');

    expect(decision).toMatchObject({ allowed: false, reason: 'site_limit' });
  });

  it('does not count a message it refused', async () => {
    const { service, upserts } = build({ maxMessagesPerDay: 10 }, { __all__: 10 });

    await service.authorizeMessage(VISITOR);

    expect(upserts).toHaveLength(0);
  });

  it('treats 0 as unlimited rather than as "block everything"', async () => {
    const { service } = build(
      { maxMessagesPerVisitorPerDay: 0, maxMessagesPerDay: 0 },
      { [VISITOR]: 9999, __all__: 999999 },
    );

    expect((await service.authorizeMessage(VISITOR)).allowed).toBe(true);
  });

  it('refuses everything while the assistant is switched off, without touching the counters', async () => {
    const { service, upserts, prisma } = build({
      isEnabled: false,
      unavailableMessage: 'We are away.',
    });

    const decision = await service.authorizeMessage(VISITOR);

    expect(decision).toMatchObject({ allowed: false, reason: 'disabled', message: 'We are away.' });
    expect(upserts).toHaveLength(0);
    expect(prisma.chatbotUsageDay.findUnique).not.toHaveBeenCalled();
  });

  it('fails OPEN when the counter cannot be read — a limit is a budget, not a lock', async () => {
    const { service, prisma } = build();
    prisma.chatbotUsageDay.findUnique.mockRejectedValue(new Error('db down'));

    expect((await service.authorizeMessage(VISITOR)).allowed).toBe(true);
  });

  it('falls back to defaults when nobody has opened the Studio yet', async () => {
    const { service, prisma } = build();
    prisma.chatbotConfig.findUnique.mockResolvedValue(null);

    const decision = await service.authorizeMessage(VISITOR);

    expect(decision.allowed).toBe(true);
    expect((decision as { config: typeof DEFAULT_CONFIG }).config.assistantName).toBe(
      'Yukizi Assistant',
    );
  });
});

describe('ChatbotConfigService.today', () => {
  it('rolls over at midnight in India, not at midnight UTC', () => {
    // 18:45 UTC on the 10th is 00:15 on the 11th in Kolkata: a limit set by
    // someone running the store should reset on their day boundary.
    expect(ChatbotConfigService.today(new Date('2026-09-10T18:45:00Z'))).toBe('2026-09-11');
    expect(ChatbotConfigService.today(new Date('2026-09-10T18:15:00Z'))).toBe('2026-09-10');
  });
});

describe('ChatbotConfigService.buildRuntime', () => {
  it('hands the model the compiled instructions and only the permitted tools', async () => {
    const prisma = {
      chatbotConfig: {
        findUnique: jest.fn().mockResolvedValue({
          ...DEFAULT_CONFIG,
          assistantName: 'Yuki',
          canReadBlogs: false,
          canCheckOrders: false,
        }),
      },
      chatbotRule: {
        findMany: jest.fn().mockResolvedValue([
          { trigger: 'asked about returns', instruction: 'mention the 7-day window', tier: 'CORE' },
        ]),
      },
      chatbotUsageDay: { findUnique: jest.fn(), upsert: jest.fn() },
    };
    const service = new ChatbotConfigService(prisma as never);

    const runtime = await service.buildRuntime();

    expect(runtime.systemInstruction).toContain('You are Yuki');
    expect(runtime.systemInstruction).toContain('mention the 7-day window');
    expect(runtime.tools).toEqual(['search_products', 'get_product_reviews']);
  });

  it('still answers when the taught rules cannot be read', async () => {
    const prisma = {
      chatbotConfig: { findUnique: jest.fn().mockResolvedValue({ ...DEFAULT_CONFIG }) },
      chatbotRule: { findMany: jest.fn().mockRejectedValue(new Error('db down')) },
      chatbotUsageDay: { findUnique: jest.fn(), upsert: jest.fn() },
    };
    const service = new ChatbotConfigService(prisma as never);

    await expect(service.buildRuntime()).resolves.toHaveProperty('systemInstruction');
  });
});
