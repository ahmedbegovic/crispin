-- P2-6: conversations snapshot default_tier at creation and never follow the
-- chat feature default. tier_pinned=0 conversations resolve their tier live
-- from featureDefaults.chat; picking a tier in the composer pins them.
-- Existing rows stay pinned (no behavior change).
ALTER TABLE conversations ADD COLUMN tier_pinned INTEGER NOT NULL DEFAULT 1;
