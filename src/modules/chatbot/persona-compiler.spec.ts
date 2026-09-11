import {
  allowedTools,
  compileSystemInstruction,
  TOOL_NAMES,
  type PersonaConfig,
} from './persona-compiler';

const base: PersonaConfig = {
  assistantName: 'Yukizi Assistant',
  tagline: '',
  formality: 50,
  warmth: 50,
  detail: 50,
  emoji: 50,
  salesiness: 50,
  languages: ['English'],
  neverSay: [],
  alwaysDo: [],
  blockedTopics: [],
  canSearchProducts: true,
  canReadReviews: true,
  canReadBlogs: true,
  canCheckOrders: true,
  canAnswerOffTopic: true,
  canQuotePrices: true,
  extraInstructions: '',
};

const make = (over: Partial<PersonaConfig> = {}) => ({ ...base, ...over });

describe('compileSystemInstruction — voice dials', () => {
  it('turns a low detail dial into an instruction about length', () => {
    const out = compileSystemInstruction(make({ detail: 10 }));
    expect(out).toContain('one or two sentences');
  });

  it('turns a high detail dial into the opposite instruction', () => {
    const out = compileSystemInstruction(make({ detail: 90 }));
    expect(out).toContain('Explain thoroughly');
    expect(out).not.toContain('one or two sentences');
  });

  it('says nothing about formality when the dial was left in the middle', () => {
    // A prompt full of neutral statements dilutes the instructions that matter.
    const out = compileSystemInstruction(make({ formality: 50 }));
    expect(out).not.toContain('Speak casually');
    expect(out).not.toContain('Speak formally');
  });

  it('forbids emoji outright at zero rather than asking for restraint', () => {
    expect(compileSystemInstruction(make({ emoji: 0 }))).toContain('Never use emoji');
  });

  it('never leaks a raw dial number into the prompt', () => {
    const out = compileSystemInstruction(
      make({ formality: 80, warmth: 12, detail: 91, emoji: 3, salesiness: 77 }),
    );
    expect(out).not.toMatch(/\b(80|12|91|77)\b/);
  });
});

describe('compileSystemInstruction — access switches', () => {
  it('names the tool when a capability is on', () => {
    const out = compileSystemInstruction(make({ canSearchProducts: true }));
    expect(out).toContain(TOOL_NAMES.products);
  });

  it('tells it what to say instead when a capability is off', () => {
    const out = compileSystemInstruction(make({ canReadBlogs: false }));
    expect(out).toContain('cannot read the blog');
    expect(out).not.toContain(TOOL_NAMES.blogs);
  });

  it('forbids quoting prices even though the catalogue is still readable', () => {
    const out = compileSystemInstruction(make({ canQuotePrices: false }));
    expect(out).toContain('Never state a price');
    // The product tool stays available — it just may not read the price out.
    expect(out).toContain(TOOL_NAMES.products);
  });

  it('confines it to the store when off-topic answers are switched off', () => {
    expect(compileSystemInstruction(make({ canAnswerOffTopic: false }))).toContain(
      'Only discuss Yukizi',
    );
  });

  it('never asks a customer for a password or an OTP when checking orders', () => {
    expect(compileSystemInstruction(make({ canCheckOrders: true }))).toContain(
      'Never ask for a password, card details or an OTP',
    );
  });
});

describe('compileSystemInstruction — boundaries and taught rules', () => {
  it('lists every banned phrase', () => {
    const out = compileSystemInstruction(
      make({ neverSay: ['guaranteed delivery by tomorrow', 'this product cures anything'] }),
    );
    expect(out).toContain('guaranteed delivery by tomorrow');
    expect(out).toContain('this product cures anything');
  });

  it('drops blank entries instead of emitting empty bullets', () => {
    const out = compileSystemInstruction(make({ neverSay: ['   ', ''] }));
    expect(out).not.toContain('Never say any of the following');
  });

  it('presents CORE rules as outranking everything else', () => {
    const out = compileSystemInstruction(make(), [
      { trigger: 'asked about refunds', instruction: 'always mention the 7-day window', tier: 'CORE' },
      { trigger: 'asked about sizing', instruction: 'point to the size chart', tier: 'SURFACE' },
    ]);
    const core = out.indexOf('absolute and outrank');
    const surface = out.indexOf('whenever they fit');
    expect(core).toBeGreaterThan(-1);
    expect(core).toBeLessThan(surface);
  });

  it('ignores a half-written rule', () => {
    const out = compileSystemInstruction(make(), [{ trigger: 'asked about x', instruction: '  ' }]);
    expect(out).not.toContain('asked about x');
  });

  it('ends with the honesty clause, so it carries the most weight', () => {
    const out = compileSystemInstruction(make({ extraInstructions: 'Mention free shipping.' }));
    expect(out.trim().endsWith('even if asked directly.')).toBe(true);
    expect(out).toContain('Mention free shipping.');
  });

  it('refuses to discuss blocked subjects and offers a human instead', () => {
    const out = compileSystemInstruction(make({ blockedTopics: ['competitor pricing'] }));
    expect(out).toContain('competitor pricing');
    expect(out).toContain('pass them to a human');
  });
});

describe('compileSystemInstruction — language', () => {
  it('pins a single language', () => {
    expect(compileSystemInstruction(make({ languages: ['English'] }))).toContain(
      'Reply only in English',
    );
  });

  it('mirrors the customer when several are allowed', () => {
    const out = compileSystemInstruction(make({ languages: ['English', 'Hindi', 'Bengali'] }));
    expect(out).toContain('English, Hindi and Bengali');
  });

  it('omits the section entirely when no language was chosen', () => {
    expect(compileSystemInstruction(make({ languages: [] }))).not.toContain('LANGUAGE');
  });
});

describe('allowedTools', () => {
  it('hands over only what is switched on', () => {
    expect(
      allowedTools(make({ canReadBlogs: false, canCheckOrders: false })),
    ).toEqual([TOOL_NAMES.products, TOOL_NAMES.reviews]);
  });

  it('returns an empty list when everything is off — not a silent fallback to all', () => {
    expect(
      allowedTools(
        make({
          canSearchProducts: false,
          canReadReviews: false,
          canReadBlogs: false,
          canCheckOrders: false,
        }),
      ),
    ).toEqual([]);
  });
});
