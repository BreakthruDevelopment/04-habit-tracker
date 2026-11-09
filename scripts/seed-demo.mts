import { demoSeedConfig } from "../src/lib/demo-seed-config";

try {
  // Refuse before importing any database or auth code.
  demoSeedConfig();
  const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
  // A trusted local CLI capability, never accepted from an HTTP request.
  const result = await loadDemoWorkspace({ id: "demo-seed-cli", role: "admin" }, { mode: "cli" });
  console.log(`Loaded ${result.users} demo users, ${result.habits} habits, ${result.checkIns} check-ins and ${result.coachSummaries} coach summaries.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Demo seed failed.");
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
