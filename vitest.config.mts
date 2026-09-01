import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests only: they cover the pure logic - validation, normalisation,
 * distance, CSV, configuration and provider selection - so no DOM environment
 * or React plugin is needed. The alias mirrors the `@/*` path in tsconfig.json.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
