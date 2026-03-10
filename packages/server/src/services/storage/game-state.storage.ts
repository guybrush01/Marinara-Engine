// ──────────────────────────────────────────────
// Storage: Game State Snapshots
// ──────────────────────────────────────────────
import { eq, and, ne, desc } from "drizzle-orm";
import type { DB } from "../../db/connection.js";
import { gameStateSnapshots } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import type { GameState } from "@marinara-engine/shared";

export function createGameStateStorage(db: DB) {
  return {
    async getLatest(chatId: string) {
      const rows = await db
        .select()
        .from(gameStateSnapshots)
        .where(eq(gameStateSnapshots.chatId, chatId))
        .orderBy(desc(gameStateSnapshots.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    /** Get the latest committed game state — the one the user "accepted" by sending their next message. */
    async getLatestCommitted(chatId: string) {
      const rows = await db
        .select()
        .from(gameStateSnapshots)
        .where(and(eq(gameStateSnapshots.chatId, chatId), eq(gameStateSnapshots.committed, 1)))
        .orderBy(desc(gameStateSnapshots.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    /** Get latest game state excluding snapshots tied to a specific message (for regen/swipes). */
    async getLatestExcludingMessage(chatId: string, excludeMessageId: string) {
      const rows = await db
        .select()
        .from(gameStateSnapshots)
        .where(and(eq(gameStateSnapshots.chatId, chatId), ne(gameStateSnapshots.messageId, excludeMessageId)))
        .orderBy(desc(gameStateSnapshots.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async getByMessage(messageId: string, swipeIndex: number = 0) {
      const rows = await db
        .select()
        .from(gameStateSnapshots)
        .where(and(eq(gameStateSnapshots.messageId, messageId), eq(gameStateSnapshots.swipeIndex, swipeIndex)));
      return rows[0] ?? null;
    },

    /** Mark a specific snapshot as committed. */
    async commit(id: string) {
      await db.update(gameStateSnapshots).set({ committed: 1 }).where(eq(gameStateSnapshots.id, id));
    },

    async create(state: Omit<GameState, "id" | "createdAt">, manualOverrides?: Record<string, string> | null) {
      const id = newId();
      await db.insert(gameStateSnapshots).values({
        id,
        chatId: state.chatId,
        messageId: state.messageId,
        swipeIndex: state.swipeIndex,
        date: state.date,
        time: state.time,
        location: state.location,
        weather: state.weather,
        temperature: state.temperature,
        presentCharacters: JSON.stringify(state.presentCharacters),
        recentEvents: JSON.stringify(state.recentEvents),
        playerStats: state.playerStats ? JSON.stringify(state.playerStats) : null,
        personaStats: state.personaStats ? JSON.stringify(state.personaStats) : null,
        manualOverrides: manualOverrides ? JSON.stringify(manualOverrides) : null,
        createdAt: now(),
      });
      return id;
    },

    async updateLatest(
      chatId: string,
      fields: Partial<
        Pick<
          GameState,
          | "date"
          | "time"
          | "location"
          | "weather"
          | "temperature"
          | "presentCharacters"
          | "playerStats"
          | "personaStats"
        >
      >,
      /** When true, the edited fields are also recorded as manual overrides. */
      manual?: boolean,
    ) {
      const latest = await this.getLatest(chatId);
      if (!latest) return null;
      const updates: Record<string, unknown> = {};
      if (fields.date !== undefined) updates.date = fields.date;
      if (fields.time !== undefined) updates.time = fields.time;
      if (fields.location !== undefined) updates.location = fields.location;
      if (fields.weather !== undefined) updates.weather = fields.weather;
      if (fields.temperature !== undefined) updates.temperature = fields.temperature;
      if (fields.presentCharacters !== undefined) updates.presentCharacters = JSON.stringify(fields.presentCharacters);
      if (fields.playerStats !== undefined)
        updates.playerStats = fields.playerStats ? JSON.stringify(fields.playerStats) : null;
      if (fields.personaStats !== undefined)
        updates.personaStats = fields.personaStats ? JSON.stringify(fields.personaStats) : null;
      if (Object.keys(updates).length === 0) return latest;

      // Merge manual override tracking
      if (manual) {
        const TRACKABLE = ["date", "time", "location", "weather", "temperature"] as const;
        const existing: Record<string, string> = latest.manualOverrides
          ? JSON.parse(latest.manualOverrides as string)
          : {};
        for (const key of TRACKABLE) {
          if (fields[key] !== undefined) existing[key] = fields[key] as string;
        }
        updates.manualOverrides = JSON.stringify(existing);
      }

      await db.update(gameStateSnapshots).set(updates).where(eq(gameStateSnapshots.id, latest.id));
      return { ...latest, ...updates };
    },

    async deleteForChat(chatId: string) {
      await db.delete(gameStateSnapshots).where(eq(gameStateSnapshots.chatId, chatId));
    },
  };
}
