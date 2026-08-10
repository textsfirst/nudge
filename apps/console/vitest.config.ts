import { defineConfig } from "vitest/config";

// Standalone config: vite.config.ts roots the SPA at src/web, which would
// otherwise hide the server tests in test/.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
