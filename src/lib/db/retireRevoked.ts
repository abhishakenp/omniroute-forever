/**
 * Retire credentials that have failed authentication so many consecutive times
 * that "temporarily broken" is no longer a possible explanation.
 *
 * `markFailed` handles this going forward — a 401/403 that pushes
 * `backoff_level` to AUTH_DEAD_AFTER_LEVEL is written as `revoked` at the
 * moment it happens. This module exists for the rows that were already past
 * that line when the rule was introduced: 355 connections on the machine this
 * was written for, 215 of them mistral, several at `backoff_level` 30, every
 * one of them still `is_active = 1` and still being handed to live requests.
 *
 * Deliberately auth-only, and deliberately reversible:
 *
 *  - `credits_exhausted` is untouched. A free tier's quota resets on a clock,
 *    and killing those rows is precisely the mistake that collapsed this pool
 *    once already (see the comment on QUOTA_STATUSES in targetIterator.ts).
 *  - `revive()` puts a retired row back with a clean slate, because a key that
 *    was genuinely rotated upstream should not need a database editor to come
 *    home.
 */
import { AUTH_DEAD_AFTER_LEVEL } from "./targetIterator.ts";

/** The narrow slice of a database handle this module needs. */
export interface RetireDb {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes?: number };
    all: (...args: unknown[]) => unknown[];
  };
}

export interface RetirementCandidate {
  id: string;
  provider: string;
  backoff_level: number | null;
  last_error: string | null;
  last_error_at: string | null;
}

/**
 * The predicate, written once so the dry run and the real run cannot disagree
 * about what would happen — the property that makes a dry run worth reading.
 *
 * `test_status = 'error'` is what markFailed writes for a 401/403, but it is
 * also what an unrelated soft failure writes, so the error text has to be
 * checked too: only a row whose most recent failure was an auth rejection is
 * eligible. A row that failed auth ten times and then failed with a 500 has a
 * `last_error` of `HTTP 500` and is left alone, which is correct — the last
 * thing we know about it is not an auth verdict.
 */
const CANDIDATE_SQL = `
  SELECT id, provider, backoff_level, last_error, last_error_at
    FROM provider_connections
   WHERE test_status = 'error'
     AND COALESCE(backoff_level, 0) >= ?
     AND (last_error LIKE '%401%' OR last_error LIKE '%403%')`;

/** What `retire()` would do, without doing it. */
export function candidates(db: RetireDb, threshold = AUTH_DEAD_AFTER_LEVEL): RetirementCandidate[] {
  return db.prepare(CANDIDATE_SQL).all(threshold) as RetirementCandidate[];
}

/**
 * Mark every candidate `revoked`.
 *
 * `rate_limited_until` is cleared on the way out. Leaving a cooldown on a
 * terminal row is harmless to the iterator (a terminal status is excluded
 * before the cooldown is even consulted) but it reads as "will retry at 4am"
 * to a person looking at the table, and a field that lies to the operator is
 * worth one extra clause to remove.
 */
export function retire(db: RetireDb, threshold = AUTH_DEAD_AFTER_LEVEL): number {
  const result = db
    .prepare(
      `UPDATE provider_connections
          SET test_status = 'revoked',
              rate_limited_until = NULL,
              last_error = COALESCE(last_error, '') || ' — retired: ' ||
                           COALESCE(backoff_level, 0) || ' consecutive auth failures'
        WHERE id IN (SELECT id FROM (${CANDIDATE_SQL}))`
    )
    .run(threshold);
  return result?.changes ?? 0;
}

/**
 * Put retired rows back into service with a clean slate.
 *
 * `backoff_level` returns to 0 rather than being left where it was: reviving a
 * key and leaving it one failure away from retirement would give the operator
 * a single attempt and then silently bury it again.
 */
export function revive(db: RetireDb, provider?: string): number {
  const where = provider ? `WHERE test_status = 'revoked' AND provider = ?` : `WHERE test_status = 'revoked'`;
  const result = db
    .prepare(
      `UPDATE provider_connections
          SET test_status = NULL,
              backoff_level = 0,
              rate_limited_until = NULL
        ${where}`
    )
    .run(...(provider ? [provider] : []));
  return result?.changes ?? 0;
}
