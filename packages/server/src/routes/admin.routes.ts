// ──────────────────────────────────────────────
// Routes: Admin (clear data, maintenance)
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { existsSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/data-dir.js";

function clearDirectory(dirPath: string) {
  if (!existsSync(dirPath)) return 0;
  const files = readdirSync(dirPath);
  let count = 0;
  for (const f of files) {
    const full = join(dirPath, f);
    try {
      rmSync(full, { recursive: true, force: true });
      count++;
    } catch {
      // skip
    }
  }
  return count;
}

export async function adminRoutes(app: FastifyInstance) {
  // Clear all data — nuclear option
  app.post<{ Body: { confirm: boolean } }>("/clear-all", async (req, reply) => {
    const { confirm } = req.body as { confirm?: boolean };
    if (!confirm) {
      return reply.status(400).send({ error: "Must send { confirm: true } to proceed" });
    }

    const db = app.db;

    // Delete from all tables in dependency order
    const tables = [
      "message_swipes",
      "messages",
      "chats",
      "lorebook_entries",
      "lorebooks",
      "prompt_sections",
      "prompt_groups",
      "choice_blocks",
      "prompt_presets",
      "agent_memory",
      "agent_runs",
      "agent_configs",
      "game_state_snapshots",
      "assets",
      "character_groups",
      "personas",
      "characters",
      "api_connections",
    ];

    const deleted: Record<string, number> = {};
    for (const table of tables) {
      try {
        const result = await db.run(sql.raw(`DELETE FROM ${table}`));
        deleted[table] = (result as any)?.changes ?? 0;
      } catch {
        // Table might not exist, skip
        deleted[table] = 0;
      }
    }

    // Clear file-based data
    const filesDeleted = {
      backgrounds: clearDirectory(join(DATA_DIR, "backgrounds")),
      avatars: clearDirectory(join(DATA_DIR, "avatars")),
      sprites: clearDirectory(join(DATA_DIR, "sprites")),
    };

    return {
      success: true,
      tablesCleared: deleted,
      filesDeleted,
    };
  });
}
