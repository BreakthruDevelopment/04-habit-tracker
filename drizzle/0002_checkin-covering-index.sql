-- Drizzle can't express INCLUDE. Week, heatmap and streak queries read (owner_id, local_date) and need
-- only habit_id, done and value, so this covering index lets them run as index-only scans.
CREATE INDEX "check_in_owner_date_covering_idx" ON "check_in" USING btree ("owner_id","local_date") INCLUDE ("habit_id","done","value");
