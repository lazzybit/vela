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
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    testTimeout: 20_000,
  },
});
