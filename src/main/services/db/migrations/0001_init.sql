-- Crispin schema v1. Timestamps are unix epoch milliseconds. Ids are UUIDs.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT 'New chat',
  system_prompt   TEXT,
  head_message_id TEXT,
  default_tier    TEXT NOT NULL DEFAULT 'high',
  collection_id   TEXT,
  web_enabled     INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Messages form a tree: a branch is the path from the root to a head;
-- regenerate inserts a sibling (same parent_id) and moves the head.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id       TEXT,
  role            TEXT NOT NULL, -- system|user|assistant|tool
  parts           TEXT NOT NULL DEFAULT '[]', -- JSON: text|image|tool_call|tool_result|citation parts
  model_id        TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_parent ON messages(parent_id);

CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL, -- image|document
  path           TEXT NOT NULL,
  mime           TEXT,
  library_doc_id TEXT
);

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'library', -- library|notebook
  created_at INTEGER NOT NULL
);

CREATE TABLE library_docs (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title         TEXT,
  source        TEXT NOT NULL, -- file path or URL
  kind          TEXT NOT NULL, -- pdf|docx|pptx|md|html|url|txt
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|ingesting|ready|failed
  error         TEXT,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE research_runs (
  id          TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'standard', -- standard|heavy
  status      TEXT NOT NULL DEFAULT 'planning',
  plan        TEXT, -- JSON
  round       INTEGER NOT NULL DEFAULT 0,
  settings    TEXT, -- JSON
  report_path TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE research_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL, -- plan|search|select|visit|note|sufficiency|synthesis
  input       TEXT, -- JSON
  output      TEXT, -- JSON
  status      TEXT NOT NULL DEFAULT 'pending',
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX idx_research_steps_run ON research_steps(run_id);

CREATE TABLE research_sources (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  url     TEXT NOT NULL,
  title   TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  cited   INTEGER NOT NULL DEFAULT 0,
  note    TEXT
);

CREATE TABLE news_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'rss',
  url             TEXT NOT NULL UNIQUE,
  title           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,
  last_modified   TEXT,
  last_fetched_at INTEGER
);

CREATE TABLE news_items (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  guid           TEXT NOT NULL,
  url            TEXT,
  title          TEXT,
  published_at   INTEGER,
  extracted_text TEXT,
  summary        TEXT,
  status         TEXT NOT NULL DEFAULT 'new', -- new|extracting|pending_summary|summarized|failed
  read_at        INTEGER,
  created_at     INTEGER NOT NULL,
  UNIQUE(source_id, guid)
);
CREATE INDEX idx_news_items_status ON news_items(status);

CREATE TABLE model_downloads (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  job_id      TEXT,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued|downloading|done|failed|cancelled
  bytes_done  INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE TABLE agent_sessions (
  id                  TEXT PRIMARY KEY,
  opencode_session_id TEXT,
  tab                 TEXT NOT NULL, -- agent|code
  directory           TEXT NOT NULL,
  title               TEXT,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER
);

CREATE TABLE mcp_servers (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL DEFAULT 'stdio', -- stdio|http
  command   TEXT,
  args      TEXT, -- JSON array
  url       TEXT,
  env       TEXT, -- JSON object
  enabled   INTEGER NOT NULL DEFAULT 1,
  scope     TEXT NOT NULL DEFAULT 'both' -- chat|agent|both
);
