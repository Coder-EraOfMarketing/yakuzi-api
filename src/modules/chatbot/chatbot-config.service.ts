import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { UpdateChatbotConfigDto } from './chatbot-config.dto';
import {
  allowedTools,
  compileSystemInstruction,
  type PersonaConfig,
} from './persona-compiler';

const SINGLETON_ID = 'singleton';

/** Counts every visitor's messages towards one bucket as well as their own. */
const GLOBAL_KEY = '__all__';

/**
 * Settings the assistant is read with. Used when the row does not exist yet, so
 * a fresh database behaves exactly like a configured one until someone opens
 * the Studio.
 */
export const DEFAULT_CONFIG = {
  id: SINGLETON_ID,
  assistantName: 'Yukizi Assistant',
  greeting:
    "Hi! I'm here to help with anything about Yukizi — products, orders, or anything else you're wondering.",
  tagline: '',
  formality: 40,
  warmth: 70,
  detail: 45,
  emoji: 15,
  salesiness: 35,
  languages: ['English', 'Hindi'],
  neverSay: [] as string[],
  alwaysDo: [] as string[],
  blockedTopics: [] as string[],
  canSearchProducts: true,
  canReadReviews: true,
  canReadBlogs: true,
  canCheckOrders: true,
  canAnswerOffTopic: true,
  canQuotePrices: true,
  maxMessagesPerVisitorPerDay: 40,
  maxMessagesPerDay: 3000,
  maxMessageLength: 2000,
  maxHistoryTurns: 12,
  thinkingBudgetCap: 2048,
  thinkingEnabled: true,
  limitReachedMessage:
    "You've reached today's chat limit. Please email support@yukizi.com and we'll pick this up with you.",
  unavailableMessage:
    'Our assistant is taking a short break. Please email support@yukizi.com and a human will help you.',
  isEnabled: true,
  extraInstructions: '',
  updatedAt: new Date(0),
  updatedBy: null as string | null,
};

export type ChatbotConfigShape = typeof DEFAULT_CONFIG;

export type ChatDecision =
  | { allowed: true; config: ChatbotConfigShape }
  | { allowed: false; reason: 'disabled' | 'site_limit' | 'visitor_limit'; message: string };

@Injectable()
export class ChatbotConfigService {
  private readonly logger = new Logger(ChatbotConfigService.name);

  /**
   * The settings are read on every single chat message, and they change a few
   * times a week at most. A short cache keeps that off the database without an
   * admin having to wait long to see their change take effect.
   */
  private cached: { at: number; value: ChatbotConfigShape } | null = null;
  private static readonly CACHE_MS = 15_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Admin read — always fresh, never the cache. */
  async get(): Promise<ChatbotConfigShape> {
    const row = await this.prisma.chatbotConfig.findUnique({
      where: { id: SINGLETON_ID },
    });
    return (row as ChatbotConfigShape) ?? { ...DEFAULT_CONFIG };
  }

  /** Runtime read, cached briefly. Falls back to defaults if the table is empty. */
  async getCached(): Promise<ChatbotConfigShape> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < ChatbotConfigService.CACHE_MS) {
      return this.cached.value;
    }
    try {
      const value = await this.get();
      this.cached = { at: now, value };
      return value;
    } catch (err) {
      // The assistant must not fall over because a settings read failed.
      this.logger.warn(
        `Could not read chatbot config, using defaults: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return { ...DEFAULT_CONFIG };
    }
  }

  async update(dto: UpdateChatbotConfigDto, updatedBy?: string) {
    const data = { ...dto, updatedBy: updatedBy ?? null };
    const saved = await this.prisma.chatbotConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    this.cached = null; // an admin who saves should see the effect immediately
    return saved;
  }

  /** Everything the model needs, assembled: instruction text plus tool list. */
  async buildRuntime(config?: ChatbotConfigShape) {
    const cfg = config ?? (await this.getCached());
    const rules = await this.prisma.chatbotRule
      .findMany({
        where: { isActive: true },
        orderBy: [{ tier: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
        take: 100,
        select: { trigger: true, instruction: true, tier: true },
      })
      .catch(() => []);

    return {
      systemInstruction: compileSystemInstruction(cfg as PersonaConfig, rules),
      tools: allowedTools(cfg as PersonaConfig),
      thinkingEnabled: cfg.thinkingEnabled,
      thinkingBudget: cfg.thinkingBudgetCap,
      maxHistoryTurns: cfg.maxHistoryTurns,
    };
  }

  /**
   * Today, in the timezone the store is run from. Limits reset at local
   * midnight, which is what "per day" means to the person setting it.
   */
  static today(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /**
   * Decides whether this message may be answered, and counts it if so.
   *
   * The count happens here rather than after the model replies, on purpose: a
   * request that reaches the model costs money whether or not the answer makes
   * it back to the browser.
   */
  async authorizeMessage(visitorKey: string): Promise<ChatDecision> {
    const config = await this.getCached();

    if (!config.isEnabled) {
      return { allowed: false, reason: 'disabled', message: config.unavailableMessage };
    }

    const day = ChatbotConfigService.today();

    try {
      const [siteCount, visitorCount] = await Promise.all([
        this.countFor(day, GLOBAL_KEY),
        this.countFor(day, visitorKey),
      ]);

      if (config.maxMessagesPerDay > 0 && siteCount >= config.maxMessagesPerDay) {
        return { allowed: false, reason: 'site_limit', message: config.unavailableMessage };
      }
      if (
        config.maxMessagesPerVisitorPerDay > 0 &&
        visitorCount >= config.maxMessagesPerVisitorPerDay
      ) {
        return { allowed: false, reason: 'visitor_limit', message: config.limitReachedMessage };
      }

      await Promise.all([this.increment(day, GLOBAL_KEY), this.increment(day, visitorKey)]);
    } catch (err) {
      // Fail OPEN. These limits exist to cap spend, not to guard anything — a
      // database hiccup must not take the assistant off the storefront.
      this.logger.warn(
        `Chat limit check failed, allowing the message: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    return { allowed: true, config };
  }

  private async countFor(day: string, visitorKey: string): Promise<number> {
    const row = await this.prisma.chatbotUsageDay.findUnique({
      where: { day_visitorKey: { day, visitorKey } },
      select: { count: true },
    });
    return row?.count ?? 0;
  }

  private increment(day: string, visitorKey: string) {
    return this.prisma.chatbotUsageDay.upsert({
      where: { day_visitorKey: { day, visitorKey } },
      create: { day, visitorKey, count: 1 },
      update: { count: { increment: 1 } },
    });
  }

  /** What the Studio's usage panel shows. */
  async usageSummary() {
    const day = ChatbotConfigService.today();
    const [config, site, visitors] = await Promise.all([
      this.get(),
      this.countFor(day, GLOBAL_KEY),
      this.prisma.chatbotUsageDay.count({
        where: { day, visitorKey: { not: GLOBAL_KEY } },
      }),
    ]);

    const busiest = await this.prisma.chatbotUsageDay.findMany({
      where: { day, visitorKey: { not: GLOBAL_KEY } },
      orderBy: { count: 'desc' },
      take: 5,
      select: { visitorKey: true, count: true },
    });

    return {
      day,
      messagesToday: site,
      visitorsToday: visitors,
      dailyCap: config.maxMessagesPerDay,
      perVisitorCap: config.maxMessagesPerVisitorPerDay,
      capUsedPercent:
        config.maxMessagesPerDay > 0
          ? Math.min(100, Math.round((site / config.maxMessagesPerDay) * 100))
          : 0,
      // Truncated: enough to spot one visitor burning the budget, not enough to
      // follow a person around.
      busiestVisitors: busiest.map((b) => ({
        visitor: b.visitorKey.slice(0, 8),
        messages: b.count,
      })),
    };
  }
}
