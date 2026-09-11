-- Chatbot Studio: one settings row for the assistant, plus daily usage counters.
--
-- Additive only. Nothing reads these tables until the Studio is deployed, and
-- the API falls back to built-in defaults when the row is absent, so applying
-- this ahead of the code changes nothing.

CREATE TABLE IF NOT EXISTS "chatbot_config" (
  "id"                          TEXT NOT NULL DEFAULT 'singleton',
  "assistantName"               TEXT NOT NULL DEFAULT 'Yukizi Assistant',
  "greeting"                    TEXT NOT NULL DEFAULT 'Hi! I''m here to help with anything about Yukizi — products, orders, or anything else you''re wondering.',
  "tagline"                     TEXT NOT NULL DEFAULT '',
  "formality"                   INTEGER NOT NULL DEFAULT 40,
  "warmth"                      INTEGER NOT NULL DEFAULT 70,
  "detail"                      INTEGER NOT NULL DEFAULT 45,
  "emoji"                       INTEGER NOT NULL DEFAULT 15,
  "salesiness"                  INTEGER NOT NULL DEFAULT 35,
  "languages"                   TEXT[] NOT NULL DEFAULT ARRAY['English','Hindi']::TEXT[],
  "neverSay"                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "alwaysDo"                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "blockedTopics"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "canSearchProducts"           BOOLEAN NOT NULL DEFAULT true,
  "canReadReviews"              BOOLEAN NOT NULL DEFAULT true,
  "canReadBlogs"                BOOLEAN NOT NULL DEFAULT true,
  "canCheckOrders"              BOOLEAN NOT NULL DEFAULT true,
  "canAnswerOffTopic"           BOOLEAN NOT NULL DEFAULT true,
  "canQuotePrices"              BOOLEAN NOT NULL DEFAULT true,
  "maxMessagesPerVisitorPerDay" INTEGER NOT NULL DEFAULT 40,
  "maxMessagesPerDay"           INTEGER NOT NULL DEFAULT 3000,
  "maxMessageLength"            INTEGER NOT NULL DEFAULT 2000,
  "maxHistoryTurns"             INTEGER NOT NULL DEFAULT 12,
  "thinkingBudgetCap"           INTEGER NOT NULL DEFAULT 2048,
  "thinkingEnabled"             BOOLEAN NOT NULL DEFAULT true,
  "limitReachedMessage"         TEXT NOT NULL DEFAULT 'You''ve reached today''s chat limit. Please email support@yukizi.com and we''ll pick this up with you.',
  "unavailableMessage"          TEXT NOT NULL DEFAULT 'Our assistant is taking a short break. Please email support@yukizi.com and a human will help you.',
  "isEnabled"                   BOOLEAN NOT NULL DEFAULT true,
  "extraInstructions"           TEXT NOT NULL DEFAULT '',
  "updatedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"                   TEXT,
  CONSTRAINT "chatbot_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "chatbot_usage_days" (
  "id"         TEXT NOT NULL,
  "day"        TEXT NOT NULL,
  "visitorKey" TEXT NOT NULL,
  "count"      INTEGER NOT NULL DEFAULT 0,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chatbot_usage_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_usage_days_day_visitorKey_key"
  ON "chatbot_usage_days"("day", "visitorKey");
CREATE INDEX IF NOT EXISTS "chatbot_usage_days_day_idx"
  ON "chatbot_usage_days"("day");
