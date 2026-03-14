// ──────────────────────────────────────────────
// Data Directory — single source of truth
//
// Resolves the runtime data directory (DB, gallery, avatars, sprites, …)
// independently of process.cwd() so the path is stable regardless of
// how the server is started (start.sh, Docker, pnpm start, dev mode).
//
//  Priority:
//    1. DATA_DIR environment variable  (explicit override)
//    2. <server-package-root>/data     (deterministic default)
// ──────────────────────────────────────────────
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up from utils/ → src|dist → package root
const SERVER_ROOT = resolve(__dirname, "../..");

/**
 * Absolute path to the runtime data directory.
 * Contains: DB, gallery images, avatars, backgrounds, sprites, fonts, knowledge-sources.
 */
export const DATA_DIR = process.env.DATA_DIR ?? resolve(SERVER_ROOT, "data");
