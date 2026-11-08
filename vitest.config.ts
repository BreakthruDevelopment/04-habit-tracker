import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside a React Server Component build; it's a no-op under test.
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    // Integration files share one database and run migrations; keep them from racing.
    fileParallelism: false,
    globalSetup: ["test/global-setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/lib/**"] },
  },
});
