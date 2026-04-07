// ──────────────────────────────────────────────
// Hook: Translation — multi-provider message translation
// ──────────────────────────────────────────────
import { create } from "zustand";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "../lib/api-client";

// ── Translation config (set from chat metadata) ──
export interface TranslationConfig {
  provider: "ai" | "deeplx" | "deepl" | "google";
  targetLanguage: string;
  connectionId?: string;
  deeplApiKey?: string;
  deeplxUrl?: string;
}

// ── Zustand store for translation cache ──
interface TranslationStore {
  /** Config for the currently active chat */
  config: TranslationConfig;
  setConfig: (config: TranslationConfig) => void;
  /** messageId -> translated text */
  translations: Record<string, string>;
  /** messageId -> currently translating */
  translating: Record<string, boolean>;
  setTranslation: (id: string, text: string) => void;
  removeTranslation: (id: string) => void;
  setTranslating: (id: string, val: boolean) => void;
  /** Clear all translations (e.g. on chat switch) */
  clearAll: () => void;
  /** Seed translations from message extras (e.g. on chat load) */
  seedFromMessages: (messages: Array<{ id: string; extra?: string | Record<string, unknown> | null }>) => void;
}

export const useTranslationStore = create<TranslationStore>((set) => ({
  config: { provider: "google", targetLanguage: "en" },
  setConfig: (config) => set({ config }),
  translations: {},
  translating: {},
  setTranslation: (id, text) => set((s) => ({ translations: { ...s.translations, [id]: text } })),
  removeTranslation: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.translations;
      return { translations: rest };
    }),
  setTranslating: (id, val) => set((s) => ({ translating: { ...s.translating, [id]: val } })),
  clearAll: () => set({ translations: {}, translating: {} }),
  seedFromMessages: (messages) =>
    set((s) => {
      const seeded: Record<string, string> = {};
      for (const msg of messages) {
        if (!msg.extra) continue;
        try {
          const extra = typeof msg.extra === "string" ? JSON.parse(msg.extra) : msg.extra;
          if (extra.translation && typeof extra.translation === "string") {
            seeded[msg.id] = extra.translation;
          }
        } catch {
          // Skip messages with malformed extra JSON
        }
      }
      // Merge with existing (in-flight translations win over seeded)
      return { translations: { ...seeded, ...s.translations } };
    }),
}));

// ── Hook ──
export function useTranslate() {
  const translations = useTranslationStore((s) => s.translations);
  const translating = useTranslationStore((s) => s.translating);
  const config = useTranslationStore((s) => s.config);

  const translate = useCallback(async (messageId: string, text: string, chatId?: string) => {
    const store = useTranslationStore.getState();

    // Toggle off if already translated (visual-only — keeps persisted translation)
    if (store.translations[messageId]) {
      store.removeTranslation(messageId);
      return;
    }

    // Skip if already in-flight
    if (store.translating[messageId]) return;

    store.setTranslating(messageId, true);
    try {
      const result = await api.post<{ translatedText: string }>("/translate", {
        text,
        provider: store.config.provider,
        targetLanguage: store.config.targetLanguage,
        connectionId: store.config.connectionId,
        deeplApiKey: store.config.deeplApiKey,
        deeplxUrl: store.config.deeplxUrl,
      });
      store.setTranslation(messageId, result.translatedText);
      // Persist to message extra so translation survives refresh/chat switch
      if (chatId) {
        api
          .patch(`/chats/${chatId}/messages/${messageId}/extra`, { translation: result.translatedText })
          .catch(() => {});
      }
    } catch (err) {
      console.error("Translation failed:", err);
      toast.error(err instanceof Error ? err.message : "Translation failed");
    } finally {
      store.setTranslating(messageId, false);
    }
  }, []);

  return {
    translate,
    translations,
    translating,
    config,
  };
}

// ── Standalone translate helper (for input translation / auto-translate) ──
export async function translateText(text: string): Promise<string> {
  const store = useTranslationStore.getState();
  const result = await api.post<{ translatedText: string }>("/translate", {
    text,
    provider: store.config.provider,
    targetLanguage: store.config.targetLanguage,
    connectionId: store.config.connectionId,
    deeplApiKey: store.config.deeplApiKey,
    deeplxUrl: store.config.deeplxUrl,
  });
  return result.translatedText;
}
