import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const empty = fileURLToPath(new URL("./test/support/empty.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": empty,
      "client-only": empty,
    },
  },
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
