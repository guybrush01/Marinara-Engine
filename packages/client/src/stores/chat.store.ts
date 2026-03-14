// ──────────────────────────────────────────────
// Zustand Store: Chat Slice
// ──────────────────────────────────────────────
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { Chat, Message, ChatMode } from "@marinara-engine/shared";
import { useAgentStore } from "./agent.store";
import { useGameStateStore } from "./game-state.store";

const STORAGE_KEY = "marinara-active-chat-id";

interface ChatState {
  activeChatId: string | null;
  activeChat: Chat | null;
  messages: Message[];
  isStreaming: boolean;
  streamBuffer: string;
  /** Active AbortController for the current generation — call .abort() to stop. */
  abortController: AbortController | null;
  /** When regenerating, the ID of the message being regenerated (so streaming shows in-place). */
  regenerateMessageId: string | null;
  /** During group chat individual mode, the character currently streaming. */
  streamingCharacterId: string | null;
  swipeIndex: Map<string, number>; // messageId → active swipe index
  /** When true, ChatArea should open the settings drawer on next render. */
  shouldOpenSettings: boolean;
  /** When true, ChatArea should show the setup wizard for the newly created chat. */
  shouldOpenWizard: boolean;

  // Actions
  setActiveChat: (chat: Chat | null) => void;
  setActiveChatId: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateLastMessage: (content: string) => void;
  setStreaming: (streaming: boolean) => void;
  setAbortController: (controller: AbortController | null) => void;
  stopGeneration: () => void;
  appendStreamBuffer: (text: string) => void;
  setStreamBuffer: (text: string) => void;
  clearStreamBuffer: () => void;
  setRegenerateMessageId: (id: string | null) => void;
  setStreamingCharacterId: (id: string | null) => void;
  setSwipeIndex: (messageId: string, index: number) => void;
  setShouldOpenSettings: (v: boolean) => void;
  setShouldOpenWizard: (v: boolean) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>()(
  subscribeWithSelector((set) => ({
    activeChatId: (() => {
      try {
        return localStorage.getItem(STORAGE_KEY) || null;
      } catch {
        return null;
      }
    })(),
    activeChat: null,
    messages: [],
    isStreaming: false,
    streamBuffer: "",
    abortController: null,
    regenerateMessageId: null,
    streamingCharacterId: null,
    swipeIndex: new Map(),
    shouldOpenSettings: false,
    shouldOpenWizard: false,

    setActiveChat: (chat) => set({ activeChat: chat }),
    setActiveChatId: (id) => {
      set({ activeChatId: id, swipeIndex: new Map(), ...(!id && { activeChat: null }) });
      useAgentStore.getState().reset();
      useGameStateStore.getState().setGameState(null);
      try {
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
    setMessages: (messages) => set({ messages }),

    addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

    updateLastMessage: (content) =>
      set((state) => {
        const messages = [...state.messages];
        const last = messages[messages.length - 1];
        if (last) {
          messages[messages.length - 1] = { ...last, content };
        }
        return { messages };
      }),

    setStreaming: (streaming) => set({ isStreaming: streaming }),
    setAbortController: (controller) => set({ abortController: controller }),
    stopGeneration: () => {
      const { abortController } = useChatStore.getState();
      if (abortController) abortController.abort();
    },
    appendStreamBuffer: (text) => set((state) => ({ streamBuffer: state.streamBuffer + text })),
    setStreamBuffer: (text) => set({ streamBuffer: text }),
    clearStreamBuffer: () => set({ streamBuffer: "" }),

    setRegenerateMessageId: (id) => set({ regenerateMessageId: id }),

    setStreamingCharacterId: (id) => set({ streamingCharacterId: id }),

    setShouldOpenSettings: (v) => set({ shouldOpenSettings: v }),

    setShouldOpenWizard: (v) => set({ shouldOpenWizard: v }),

    setSwipeIndex: (messageId, index) =>
      set((state) => {
        const m = new Map(state.swipeIndex);
        m.set(messageId, index);
        return { swipeIndex: m };
      }),

    reset: () => {
      set({
        activeChatId: null,
        activeChat: null,
        messages: [],
        isStreaming: false,
        streamBuffer: "",
        abortController: null,
        streamingCharacterId: null,
        swipeIndex: new Map(),
      });
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  })),
);
