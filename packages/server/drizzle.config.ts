import { defineConfig } from "drizzle-kit";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? resolve(__dirname, "data");

export default defineConfig({
  schema: [
    "./src/db/schema/chats.ts",
    "./src/db/schema/characters.ts",
    "./src/db/schema/lorebooks.ts",
    "./src/db/schema/prompts.ts",
    "./src/db/schema/connections.ts",
    "./src/db/schema/assets.ts",
    "./src/db/schema/agents.ts",
    "./src/db/schema/custom-tools.ts",
    "./src/db/schema/game-state.ts",
    "./src/db/schema/regex-scripts.ts",
  ],
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? `file:${resolve(dataDir, "marinara-engine.db")}`,
  },
});
