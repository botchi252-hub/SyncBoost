import { defineConfig } from "vitest/config";

// Plain Node environment for the logic tests (the app's vite.config.ts loads the Cloudflare plugin).
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
