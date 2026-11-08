import { type SQL, and, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Ownership, once. Habits, check-ins, settings, devices and summaries are private to their owner,
 * admin included, so the template's `can()` (admin passes everything) is deliberately not used for
 * them. Every select, update and delete of those tables goes through this fragment; zero rows
 * means 404. Tables key the owner as `ownerId` (habit, check_in) or `userId` (the per-user tables).
 */
export function ownedBy(
  table: { ownerId: PgColumn } | { userId: PgColumn },
  actor: { id: string },
  ...and_: (SQL | undefined)[]
): SQL {
  const column = "ownerId" in table ? table.ownerId : table.userId;
  return and(eq(column, actor.id), ...and_) as SQL;
}
