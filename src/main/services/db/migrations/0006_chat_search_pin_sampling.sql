-- 0.21 chat: favorite/pin flag, per-conversation sampling override, per-message
-- generation timing, and an FTS5 index over titles + message bodies for search.
-- (pinned is a NEW favorite flag — distinct from 0002's tier_pinned.)
ALTER TABLE conversations ADD COLUMN pinned   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN sampling TEXT;            -- JSON {temperature,topP,topK} | NULL

ALTER TABLE messages ADD COLUMN ttft_ms INTEGER;              -- time-to-first-token, ms
ALTER TABLE messages ADD COLUMN gen_ms  INTEGER;              -- decode wall-time, ms

-- Standalone FTS5 (messages.parts is JSON, so no external-content mapping). The
-- repo maintains it: one body row per message + one title row per conversation
-- (message_id IS NULL). Diacritic folding verified in node:sqlite.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
  conversation_id UNINDEXED,
  message_id      UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
