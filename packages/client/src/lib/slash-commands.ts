// ──────────────────────────────────────────────
// Slash Commands — SillyTavern-style / commands
// ──────────────────────────────────────────────
import { api } from "./api-client";
import type { Message } from "@marinara-engine/shared";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  /** If true, command is executed locally and doesn't send to the LLM */
  local?: boolean;
  /** Execute the command. Returns a string result, or null if it dispatches an action elsewhere. */
  execute: (args: string, ctx: SlashCommandContext) => Promise<SlashCommandResult>;
}

export interface SlashCommandContext {
  chatId: string;
  /** Trigger an LLM generation (with optional user message) */
  generate: (params: {
    chatId: string;
    connectionId: string | null;
    userMessage?: string;
    impersonate?: boolean;
  }) => Promise<void>;
  /** Insert a message directly into the chat (no LLM) */
  createMessage: (data: { role: string; content: string; characterId?: string | null }) => void;
  /** Invalidate chat queries to refresh the UI */
  invalidate: () => void;
  /** Character names in the current chat */
  characterNames: string[];
}

export interface SlashCommandResult {
  /** If true, don't send to the LLM / don't do normal send */
  handled: boolean;
  /** Optional feedback to show (ephemeral, not persisted) */
  feedback?: string;
}

// ── Dice roller ────────────────

function parseDice(notation: string): { count: number; sides: number; modifier: number } | null {
  const match = notation.match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  return {
    count: parseInt(match[1] || "1", 10),
    sides: parseInt(match[2]!, 10),
    modifier: match[3] ? parseInt(match[3], 10) : 0,
  };
}

function rollDice(count: number, sides: number): number[] {
  const results: number[] = [];
  for (let i = 0; i < count; i++) {
    results.push(Math.floor(Math.random() * sides) + 1);
  }
  return results;
}

// ── Command definitions ────────────────

const COMMANDS: SlashCommand[] = [
  {
    name: "roll",
    aliases: ["r", "dice"],
    description: "Roll dice (e.g. 2d6, 1d20+5)",
    usage: "/roll <notation>",
    local: true,
    async execute(args, ctx) {
      const notation = args.trim() || "1d20";
      const parsed = parseDice(notation);
      if (!parsed) return { handled: true, feedback: `Invalid dice notation: ${notation}` };
      const rolls = rollDice(parsed.count, parsed.sides);
      const sum = rolls.reduce((a, b) => a + b, 0) + parsed.modifier;
      const modStr = parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier < 0 ? `${parsed.modifier}` : "";
      const detail = parsed.count > 1 ? ` [${rolls.join(", ")}]${modStr}` : modStr ? ` (${rolls[0]}${modStr})` : "";
      const text = `🎲 **${notation}** → **${sum}**${detail}`;
      ctx.createMessage({ role: "narrator", content: text });
      return { handled: true };
    },
  },
  {
    name: "sys",
    aliases: ["system"],
    description: "Insert a system message",
    usage: "/sys <message>",
    local: true,
    async execute(args, ctx) {
      if (!args.trim()) return { handled: true, feedback: "Usage: /sys <message text>" };
      ctx.createMessage({ role: "system", content: args.trim() });
      return { handled: true };
    },
  },
  {
    name: "narrator",
    aliases: ["narrate", "nar"],
    description: "Insert a narrator message",
    usage: "/narrator <message>",
    local: true,
    async execute(args, ctx) {
      if (!args.trim()) return { handled: true, feedback: "Usage: /narrator <message text>" };
      ctx.createMessage({ role: "narrator", content: args.trim() });
      return { handled: true };
    },
  },
  {
    name: "continue",
    aliases: ["cont"],
    description: "Continue the AI response without sending a message",
    usage: "/continue",
    async execute(_args, ctx) {
      await ctx.generate({ chatId: ctx.chatId, connectionId: null });
      return { handled: true };
    },
  },
  {
    name: "as",
    aliases: ["respond"],
    description: "Generate a response as a specific character",
    usage: "/as <character name>",
    async execute(args, ctx) {
      const name = args.trim();
      if (!name) return { handled: true, feedback: "Usage: /as <character name>" };
      const match = ctx.characterNames.find((n) => n.toLowerCase() === name.toLowerCase());
      if (!match) {
        return {
          handled: true,
          feedback: `Character "${name}" not found. Available: ${ctx.characterNames.join(", ")}`,
        };
      }
      // Inject instruction to respond as the specific character
      await ctx.generate({
        chatId: ctx.chatId,
        connectionId: null,
        userMessage: `[Respond as ${match}]`,
      });
      return { handled: true };
    },
  },
  {
    name: "impersonate",
    aliases: ["imp"],
    description: "Generate a response as your character ({{user}})",
    usage: "/impersonate",
    async execute(_args, ctx) {
      await ctx.generate({
        chatId: ctx.chatId,
        connectionId: null,
        impersonate: true,
      });
      return { handled: true };
    },
  },
  {
    name: "help",
    description: "Show available slash commands",
    usage: "/help",
    local: true,
    async execute(_args, _ctx) {
      const lines = COMMANDS.map((c) => `${c.usage} — ${c.description}`);
      return { handled: true, feedback: `Available Commands:\n${lines.join("\n")}` };
    },
  },
];

/** Find a matching command for the given input. */
export function matchSlashCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith("/")) return null;
  const spaceIdx = input.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1);

  for (const cmd of COMMANDS) {
    if (cmd.name === cmdName || cmd.aliases?.includes(cmdName)) {
      return { command: cmd, args };
    }
  }
  return null;
}

/** Get all commands that match a partial prefix (for autocomplete). */
export function getSlashCompletions(partial: string): SlashCommand[] {
  if (!partial.startsWith("/")) return [];
  const prefix = partial.slice(1).toLowerCase();
  if (!prefix) return COMMANDS;
  return COMMANDS.filter((c) => c.name.startsWith(prefix) || c.aliases?.some((a) => a.startsWith(prefix)));
}

export { COMMANDS as SLASH_COMMANDS };
