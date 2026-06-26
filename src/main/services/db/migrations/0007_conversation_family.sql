-- Per-conversation model FAMILY pin. NULL = follow the global default family
-- (settings.models.defaultFamily, 'gemma'). Additive; existing rows stay NULL.
ALTER TABLE conversations ADD COLUMN family TEXT;
