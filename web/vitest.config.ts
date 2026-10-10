import { defineConfig } from "vitest/config";

// Unit tests (SPEC 9.0) run in node: they cover pure logic (URL parsing,
// cleanup rules) and database smoke tests over PGlite. Browser behavior is
// Playwright's job in web/e2e, so no jsdom here — and the explicit include
// list keeps those e2e specs out of the vitest run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "app/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
