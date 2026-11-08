import { defineConfig } from "vitest/config";

// Unit tests (SPEC 9.0) run in node: they cover pure logic (URL parsing,
// cleanup rules) and database smoke tests over PGlite. Browser behavior is
// Playwright's job in web/e2e, so no jsdom here, and the include list only
// reaches the node-safe MSW fixture tests in e2e/mocks, never the Playwright
// *.spec.ts files.
export default defineConfig({
  test: {
    environment: "node",
    // PGlite boots its WASM engine and applies the schema per test run; on a
    // loaded machine that pushes individual boot tests past vitest's 5s
    // default (observed ~4-5s idle, longer under parallel workers).
    // On a Windows PC with little free memory, a full run with every worker
    // busy pushed single boots past 20s, so tests and the beforeAll/beforeEach
    // hooks that boot PGlite both get 60s. CI finishes far below that.
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["tests/**/*.test.ts", "app/**/*.test.ts", "lib/**/*.test.ts", "*.test.ts", "e2e/mocks/**/*.test.ts"],
  },
});
