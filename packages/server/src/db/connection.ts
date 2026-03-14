// ──────────────────────────────────────────────
// Database Connection
// ──────────────────────────────────────────────
import * as schema from "./schema/index.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../utils/data-dir.js";

type DrizzleDB = ReturnType<typeof import("drizzle-orm/libsql").drizzle<typeof schema>>;

let dbPromise: Promise<DrizzleDB> | null = null;

async function createWithLibsql(dbPath: string): Promise<DrizzleDB> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");

  const client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA synchronous=NORMAL");
  await client.execute("PRAGMA busy_timeout=5000");

  return drizzle(client, { schema });
}

async function createWithBetterSqlite3(dbPath: string): Promise<DrizzleDB> {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  // Cast is safe — both Drizzle SQLite drivers share the same query API
  return drizzle(sqlite, { schema }) as unknown as DrizzleDB;
}

async function createDB(dbPath: string): Promise<DrizzleDB> {
  mkdirSync(dirname(dbPath), { recursive: true });

  // If explicitly requested (e.g. Termux), skip libsql entirely
  if (process.env.DATABASE_DRIVER === "better-sqlite3") {
    return createWithBetterSqlite3(dbPath);
  }

  // Default: try libsql, fall back to better-sqlite3
  try {
    return await createWithLibsql(dbPath);
  } catch {
    return createWithBetterSqlite3(dbPath);
  }
}

export async function getDB() {
  if (!dbPromise) {
    const dbUrl = process.env.DATABASE_URL ?? `file:${join(DATA_DIR, "marinara-engine.db")}`;
    const dbPath = dbUrl.replace(/^file:/, "");
    dbPromise = createDB(dbPath);
  }
  return dbPromise;
}

export type DB = DrizzleDB;
