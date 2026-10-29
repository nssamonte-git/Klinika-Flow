import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ test: { env: { META_REQUEST_PROFILE: "legacy", META_PROMPT_CACHE_RETENTION: "in_memory" }, include: ["backend/tests/**/*.test.ts"], fileParallelism: false }, resolve: { alias: { "@backend": fileURLToPath(new URL("./src", import.meta.url)), "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)) } } });
