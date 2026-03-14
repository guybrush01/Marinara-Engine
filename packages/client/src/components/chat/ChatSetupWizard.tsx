// ──────────────────────────────────────────────
// Chat Setup Wizard — step-by-step new chat configuration
// ──────────────────────────────────────────────
import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Plug, Sliders, Users, BookOpen, Sparkles, Check, Plus, Search, X, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { useConnections } from "../../hooks/use-connections";
import { usePresets } from "../../hooks/use-presets";
import { useCharacters, usePersonas } from "../../hooks/use-characters";
import { useLorebooks } from "../../hooks/use-lorebooks";
import { useUpdateChat, useUpdateChatMetadata, useCreateMessage } from "../../hooks/use-chats";
import { useUIStore } from "../../stores/ui.store";
import { api } from "../../lib/api-client";
import type { Chat } from "@marinara-engine/shared";

// ─── Step definitions ─────────────────────────

interface WizardStep {
  key: string;
  title: string;
  body: string;
  sprite: string;
  spriteFlip?: boolean;
}

const STEPS: WizardStep[] = [
  {
    key: "connection",
    title: "Choose a Connection",
    body: "Which AI provider should this chat use? If you haven't set one up yet, you can do that from the Connections panel.",
    sprite: "/sprites/mari/Mari_explaining.png",
  },
  {
    key: "preset",
    title: "Pick a Preset",
    body: "Presets control the system prompt structure and generation parameters. The default preset works great for most chats!",
    sprite: "/sprites/mari/Mari_thinking.png",
  },
  {
    key: "persona",
    title: "Select Your Persona",
    body: "Your persona tells the AI who you are. Pick one or skip to stay anonymous.",
    sprite: "/sprites/mari/Mari_greet.png",
  },
  {
    key: "characters",
    title: "Add Characters",
    body: "Characters bring your chat to life! Add one or more characters for the AI to roleplay as.",
    sprite: "/sprites/mari/Mari_point_middle_left.png",
  },
  {
    key: "lorebooks",
    title: "Attach Lorebooks",
    body: "Lorebooks inject world info and lore into the AI's context when relevant keywords appear. Optional but great for rich worlds!",
    sprite: "/sprites/mari/Mari_point_up_left.png",
    spriteFlip: true,
  },
];

// ─── Main component ───────────────────────────

interface ChatSetupWizardProps {
  chat: Chat;
  onFinish: () => void;
}

export function ChatSetupWizard({ chat, onFinish }: ChatSetupWizardProps) {
  const [step, setStep] = useState(0);
  const currentStep = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  const updateChat = useUpdateChat();
  const updateMeta = useUpdateChatMetadata();
  const createMessage = useCreateMessage(chat.id);
  const openRightPanel = useUIStore((s) => s.openRightPanel);

  const { data: connections } = useConnections();
  const { data: presets } = usePresets();
  const { data: allPersonas } = usePersonas();
  const { data: allCharacters } = useCharacters();
  const { data: lorebooks } = useLorebooks();

  const personas = (allPersonas ?? []) as Array<{ id: string; name: string; avatarPath: string | null }>;
  const characters = (allCharacters ?? []) as Array<{ id: string; data: string; avatarPath: string | null }>;

  const metadata = useMemo(() => {
    const raw = (chat as unknown as { metadata?: string | Record<string, unknown> }).metadata;
    return typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
  }, [chat]);

  const chatCharIds: string[] = useMemo(() => {
    return typeof chat.characterIds === "string" ? JSON.parse(chat.characterIds) : (chat.characterIds ?? []);
  }, [chat.characterIds]);

  const activeLorebookIds: string[] = metadata.activeLorebookIds ?? [];

  // Character name helper
  const charNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of characters) {
      try {
        const p = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
        map.set(c.id, (p as { name?: string }).name ?? "Unknown");
      } catch {
        map.set(c.id, "Unknown");
      }
    }
    return map;
  }, [characters]);

  const charName = useCallback(
    (c: { id?: string; data: string }) => {
      if (c.id && charNameMap.has(c.id)) return charNameMap.get(c.id)!;
      try {
        const p = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
        return (p as { name?: string }).name ?? "Unknown";
      } catch {
        return "Unknown";
      }
    },
    [charNameMap],
  );

  // ── Mutations ──
  const setConnection = useCallback(
    (connectionId: string | null) => {
      updateChat.mutate({ id: chat.id, connectionId });
    },
    [chat.id, updateChat],
  );

  const setPreset = useCallback(
    (presetId: string | null) => {
      updateChat.mutate({ id: chat.id, promptPresetId: presetId });
    },
    [chat.id, updateChat],
  );

  const setPersona = useCallback(
    (personaId: string | null) => {
      updateChat.mutate({ id: chat.id, personaId });
    },
    [chat.id, updateChat],
  );

  const toggleCharacter = useCallback(
    (charId: string) => {
      const current = [...chatCharIds];
      const idx = current.indexOf(charId);
      if (idx >= 0) {
        current.splice(idx, 1);
        updateChat.mutate({ id: chat.id, characterIds: current });
      } else {
        current.push(charId);
        updateChat.mutate(
          { id: chat.id, characterIds: current },
          {
            onSuccess: () => {
              const char = characters.find((c) => c.id === charId);
              if (!char) return;
              try {
                const parsed = typeof char.data === "string" ? JSON.parse(char.data) : char.data;
                const firstMes = (parsed as { first_mes?: string }).first_mes;
                const altGreetings = (parsed as { alternate_greetings?: string[] }).alternate_greetings ?? [];
                if (firstMes) {
                  createMessage
                    .mutateAsync({ role: "assistant", content: firstMes, characterId: charId })
                    .then((msg) => {
                      if (msg?.id && altGreetings.length > 0) {
                        for (const greeting of altGreetings) {
                          if (greeting.trim()) {
                            api.post(`/chats/${chat.id}/messages/${msg.id}/swipes`, { content: greeting });
                          }
                        }
                      }
                    });
                }
              } catch {
                /* ignore */
              }
            },
          },
        );
      }
    },
    [chat.id, chatCharIds, characters, createMessage, updateChat],
  );

  const toggleLorebook = useCallback(
    (lbId: string) => {
      const current = [...activeLorebookIds];
      const idx = current.indexOf(lbId);
      if (idx >= 0) current.splice(idx, 1);
      else current.push(lbId);
      updateMeta.mutate({ id: chat.id, activeLorebookIds: current });
    },
    [chat.id, activeLorebookIds, updateMeta],
  );

  // Search state for character & lorebook pickers
  const [charSearch, setCharSearch] = useState("");
  const [lbSearch, setLbSearch] = useState("");

  const next = useCallback(() => {
    if (isLast) {
      onFinish();
    } else {
      setStep((s) => s + 1);
      setCharSearch("");
      setLbSearch("");
    }
  }, [isLast, onFinish]);

  // ─── Step content renderers ───────────────────

  function renderConnection() {
    return (
      <div className="space-y-2">
        <select
          value={chat.connectionId ?? ""}
          onChange={(e) => setConnection(e.target.value || null)}
          className="w-full rounded-lg bg-[var(--secondary)] px-3 py-2.5 text-xs outline-none ring-1 ring-transparent transition-shadow focus:ring-[var(--primary)]/40"
        >
          <option value="">None</option>
          <option value="random">🎲 Random</option>
          {((connections ?? []) as Array<{ id: string; name: string }>).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {((connections ?? []) as Array<unknown>).length === 0 && (
          <button
            onClick={() => {
              openRightPanel("connections");
              onFinish();
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-3 py-2 text-xs font-medium text-[var(--primary)] transition-all hover:bg-[var(--primary)]/20"
          >
            <Plug size={13} />
            Set Up a Connection
          </button>
        )}
      </div>
    );
  }

  function renderPreset() {
    return (
      <select
        value={chat.promptPresetId ?? ""}
        onChange={(e) => setPreset(e.target.value || null)}
        className="w-full rounded-lg bg-[var(--secondary)] px-3 py-2.5 text-xs outline-none ring-1 ring-transparent transition-shadow focus:ring-[var(--primary)]/40"
      >
        <option value="">None</option>
        {((presets ?? []) as Array<{ id: string; name: string; isDefault?: boolean | string }>).map((p) => (
          <option key={p.id} value={p.id}>
            {p.isDefault === true || p.isDefault === "true" ? "Default" : p.name}
          </option>
        ))}
      </select>
    );
  }

  function renderPersona() {
    return (
      <select
        value={chat.personaId ?? ""}
        onChange={(e) => setPersona(e.target.value || null)}
        className="w-full rounded-lg bg-[var(--secondary)] px-3 py-2.5 text-xs outline-none ring-1 ring-transparent transition-shadow focus:ring-[var(--primary)]/40"
      >
        <option value="">None</option>
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );
  }

  function renderCharacters() {
    const available = characters.filter(
      (c) => !chatCharIds.includes(c.id) && charName(c).toLowerCase().includes(charSearch.toLowerCase()),
    );

    return (
      <div className="space-y-2">
        {/* Added characters */}
        {chatCharIds.length > 0 && (
          <div className="flex flex-col gap-1">
            {chatCharIds.map((cid) => {
              const c = characters.find((ch) => ch.id === cid);
              if (!c) return null;
              const name = charName(c);
              return (
                <div
                  key={cid}
                  className="flex items-center gap-2.5 rounded-lg bg-[var(--primary)]/10 px-3 py-2 ring-1 ring-[var(--primary)]/30"
                >
                  {c.avatarPath ? (
                    <img src={c.avatarPath} alt={name} className="h-6 w-6 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[9px] font-bold">
                      {name[0]}
                    </div>
                  )}
                  <span className="flex-1 truncate text-xs">{name}</span>
                  <button
                    onClick={() => toggleCharacter(cid)}
                    className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
                    title="Remove"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Search + add */}
        <div className="rounded-lg ring-1 ring-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Search size={12} className="text-[var(--muted-foreground)]" />
            <input
              value={charSearch}
              onChange={(e) => setCharSearch(e.target.value)}
              placeholder="Search characters…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="max-h-32 overflow-y-auto">
            {available.map((c) => {
              const name = charName(c);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleCharacter(c.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--accent)]"
                >
                  {c.avatarPath ? (
                    <img src={c.avatarPath} alt={name} className="h-6 w-6 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[9px] font-bold">
                      {name[0]}
                    </div>
                  )}
                  <span className="flex-1 truncate text-xs">{name}</span>
                  <Plus size={12} className="text-[var(--muted-foreground)]" />
                </button>
              );
            })}
            {available.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
                {characters.filter((c) => !chatCharIds.includes(c.id)).length === 0
                  ? "All characters already added."
                  : "No matches."}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderLorebooks() {
    const available = ((lorebooks ?? []) as Array<{ id: string; name: string }>).filter(
      (lb) => !activeLorebookIds.includes(lb.id) && lb.name.toLowerCase().includes(lbSearch.toLowerCase()),
    );

    return (
      <div className="space-y-2">
        {/* Active lorebooks */}
        {activeLorebookIds.length > 0 && (
          <div className="flex flex-col gap-1">
            {activeLorebookIds.map((lbId) => {
              const lb = ((lorebooks ?? []) as Array<{ id: string; name: string }>).find((l) => l.id === lbId);
              if (!lb) return null;
              return (
                <div
                  key={lb.id}
                  className="flex items-center gap-2.5 rounded-lg bg-[var(--primary)]/10 px-3 py-2 ring-1 ring-[var(--primary)]/30"
                >
                  <BookOpen size={14} className="text-[var(--primary)]" />
                  <span className="flex-1 truncate text-xs">{lb.name}</span>
                  <button
                    onClick={() => toggleLorebook(lb.id)}
                    className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
                    title="Remove"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Search + add */}
        <div className="rounded-lg ring-1 ring-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Search size={12} className="text-[var(--muted-foreground)]" />
            <input
              value={lbSearch}
              onChange={(e) => setLbSearch(e.target.value)}
              placeholder="Search lorebooks…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="max-h-32 overflow-y-auto">
            {available.map((lb) => (
              <button
                key={lb.id}
                onClick={() => toggleLorebook(lb.id)}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--accent)]"
              >
                <BookOpen size={14} className="text-[var(--muted-foreground)]" />
                <span className="flex-1 truncate text-xs">{lb.name}</span>
                <Plus size={12} className="text-[var(--muted-foreground)]" />
              </button>
            ))}
            {available.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
                {((lorebooks ?? []) as Array<{ id: string }>).filter((lb) => !activeLorebookIds.includes(lb.id))
                  .length === 0
                  ? "All lorebooks already added."
                  : "No matches."}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const stepRenderers: Record<string, () => React.ReactNode> = {
    connection: renderConnection,
    preset: renderPreset,
    persona: renderPersona,
    characters: renderCharacters,
    lorebooks: renderLorebooks,
  };

  return (
    <>
      {/* Backdrop */}
      <div className="absolute inset-0 z-40 bg-black/40 backdrop-blur-[3px]" onClick={onFinish} />

      {/* Wizard card — centered */}
      <div className="absolute inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.97 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="pointer-events-auto w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl"
          >
            {/* Sprite */}
            <div className="mb-3 flex justify-center">
              <img
                src={currentStep.sprite}
                alt="Professor Mari"
                className="h-28 w-auto object-contain drop-shadow-lg"
                style={currentStep.spriteFlip ? { transform: "scaleX(-1)" } : undefined}
                draggable={false}
              />
            </div>

            {/* Title */}
            <h3 className="mb-1 text-center text-sm font-semibold text-[var(--foreground)]">{currentStep.title}</h3>

            {/* Body */}
            <p className="mb-4 text-center text-xs leading-relaxed text-[var(--muted-foreground)]">
              {currentStep.body}
            </p>

            {/* Step content */}
            <div className="mb-4">{stepRenderers[currentStep.key]?.()}</div>

            {/* Progress dots */}
            <div className="mb-3 flex items-center justify-center gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-300",
                    i === step
                      ? "w-4 bg-[var(--primary)]"
                      : i < step
                        ? "w-1.5 bg-[var(--primary)]/40"
                        : "w-1.5 bg-[var(--muted-foreground)]/20",
                  )}
                />
              ))}
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-between">
              <button
                onClick={onFinish}
                className="rounded-lg px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              >
                Skip
              </button>
              <button
                onClick={next}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-foreground)] shadow-sm transition-all hover:opacity-90 active:scale-95"
              >
                {isLast ? "Done" : "Next"}
                {isLast ? <Check size={12} /> : <ChevronRight size={12} />}
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  );
}
