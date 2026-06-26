-- Per-session model family pin (mirrors 0005's nullable tier). NULL = follow the
-- global default family. The Agent/Code composers restore it on session switch.
ALTER TABLE agent_sessions ADD COLUMN family TEXT;
