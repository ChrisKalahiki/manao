import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "dashboard/test/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [["dashboard/**", "happy-dom"]],
  },
});
