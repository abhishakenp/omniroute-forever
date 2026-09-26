-- 143_reserved_for.sql
-- Reserve a connection for one consumer.
--
-- provider_connections.reserved_for: NULL means the connection belongs to the
--   general pool and is available to every request. A non-NULL value is a
--   consumer tag (e.g. 'iris/always') and the row is then invisible to every
--   request that did not ask for that exact tag — a reserved key is never
--   spent by general traffic. A request that DOES carry the tag sees its
--   reserved rows first and falls back to the general pool afterwards.
--
-- Idempotent: the runner treats a "duplicate column name" as already-applied
-- (see migrationRunner.ts), and the index is IF NOT EXISTS.
--
-- NOTE: on a live boot the column healer (ensureProviderConnectionsColumns in
-- schemaColumns.ts) runs BEFORE runMigrations, so the ALTER below already
-- duplicates and the whole migration transaction is rolled back before the
-- CREATE INDEX. The index is therefore ALSO created by that healer — this file
-- is the record for any path that reaches the migration first.

ALTER TABLE provider_connections ADD COLUMN reserved_for TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_connections_reserved_for
  ON provider_connections(reserved_for);
