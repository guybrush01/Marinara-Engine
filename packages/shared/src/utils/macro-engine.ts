// ──────────────────────────────────────────────
// Macro Engine — {{user}}, {{char}}, {{date}}, etc.
// ──────────────────────────────────────────────

export interface MacroContext {
  user: string;
  char: string;
  /** All characters in the chat */
  characters: string[];
  /** Custom variables from prompt toggle groups */
  variables: Record<string, string>;
  /** Last user input message (for {{input}}) */
  lastInput?: string;
  /** Chat ID (for {{chatId}}) */
  chatId?: string;
  /** Model name (for {{model}}) */
  model?: string;
  /** Agent data keyed by agent type (for {{agent::TYPE}}) */
  agentData?: Record<string, string>;
}

export interface SupportedMacroDefinition {
  category: string;
  syntax: string;
  description: string;
}

export const SUPPORTED_MACROS: readonly SupportedMacroDefinition[] = [
  { category: "Identity", syntax: "{{user}} / {{persona}}", description: "Current user or persona name" },
  { category: "Identity", syntax: "{{char}}", description: "Current character name" },
  { category: "Identity", syntax: "{{characters}}", description: "All character names, comma-separated" },
  { category: "Context", syntax: "{{input}}", description: "Most recent user message" },
  { category: "Context", syntax: "{{model}}", description: "Current model name" },
  { category: "Context", syntax: "{{chatId}}", description: "Current chat ID" },
  { category: "Context", syntax: "{{agent::TYPE}}", description: "Cached output for an agent or tracker type" },
  { category: "Time", syntax: "{{date}}", description: "Current real date in YYYY-MM-DD format" },
  { category: "Time", syntax: "{{time}}", description: "Current real time in HH:MM format" },
  { category: "Time", syntax: "{{datetime}} / {{isotime}}", description: "Current ISO timestamp" },
  { category: "Time", syntax: "{{weekday}}", description: "Current weekday name" },
  { category: "Random", syntax: "{{random}}", description: "Random number from 0 to 100" },
  { category: "Random", syntax: "{{random:X:Y}}", description: "Random number between X and Y" },
  { category: "Random", syntax: "{{roll:XdY}}", description: "Dice roll total such as 2d6" },
  { category: "Variables", syntax: "{{getvar::name}}", description: "Read a dynamic variable" },
  { category: "Variables", syntax: "{{setvar::name::value}}", description: "Set a dynamic variable" },
  { category: "Variables", syntax: "{{addvar::name::value}}", description: "Append to a dynamic variable" },
  {
    category: "Variables",
    syntax: "{{incvar::name}} / {{decvar::name}}",
    description: "Increment or decrement a numeric variable",
  },
  { category: "Variables", syntax: "{{NAME}}", description: "Resolve a preset variable named NAME" },
  { category: "Formatting", syntax: "{{newline}} / {{\\n}}", description: "Insert a literal newline" },
  { category: "Formatting", syntax: "{{trim}}", description: "Trim the final output" },
  {
    category: "Formatting",
    syntax: "{{trimStart}} / {{trimEnd}}",
    description: "Trim whitespace at one edge of the output",
  },
  {
    category: "Formatting",
    syntax: "{{uppercase}}...{{/uppercase}}",
    description: "Uppercase a wrapped block",
  },
  {
    category: "Formatting",
    syntax: "{{lowercase}}...{{/lowercase}}",
    description: "Lowercase a wrapped block",
  },
  { category: "Formatting", syntax: "{{noop}}", description: "No-op placeholder removed from output" },
  { category: "Formatting", syntax: "{{// comment}}", description: "Inline author comment removed from output" },
  {
    category: "Formatting",
    syntax: '{{banned "text"}}',
    description: "Accepted but currently stripped from output",
  },
];

/**
 * Replace macros in a prompt string with their values.
 *
 * Supported macros (SillyTavern-compatible):
 *  - {{user}} / {{persona}} — user's display name
 *  - {{char}} — current character name
 *  - {{characters}} — comma-separated list of all character names
 *  - {{date}} — current real date (YYYY-MM-DD)
 *  - {{time}} — current real time (HH:MM)
 *  - {{datetime}} — full ISO datetime string
 *  - {{weekday}} — current day name (Monday, etc.)
 *  - {{isotime}} — ISO timestamp
 *  - {{random}} — random number 0-100
 *  - {{random:X:Y}} — random number X-Y
 *  - {{roll:XdY}} — dice roll (e.g. {{roll:2d6}})
 *  - {{getvar::name}} — read a dynamic variable
 *  - {{setvar::name::value}} — set a variable
 *  - {{addvar::name::value}} — append to a variable
 *  - {{incvar::name}} — increment numeric variable by 1
 *  - {{decvar::name}} — decrement numeric variable by 1
 *  - {{input}} — last user message
 *  - {{model}} — current model name
 *  - {{chatId}} — current chat ID
 *  - {{// comment}} — removed (author comments)
 *  - {{trim}} — remove surrounding whitespace
 *  - {{trimStart}} / {{trimEnd}} — directional trim markers
 *  - {{newline}} / {{\n}} — literal newline
 *  - {{noop}} — no operation, removed
 *  - {{banned "text"}} — content filter (removed for now)
 *  - {{uppercase}}...{{/uppercase}} — convert to uppercase
 *  - {{lowercase}}...{{/lowercase}} — convert to lowercase
 */
export function resolveMacros(template: string, ctx: MacroContext): string {
  let result = template;

  // ── Comments — strip first so they don't interfere ──
  result = result.replace(/\{\{\/\/[^}]*\}\}/g, "");

  // ── No-op & banned ──
  result = result.replace(/\{\{noop\}\}/gi, "");
  result = result.replace(/\{\{banned\s+"[^"]*"\}\}/gi, "");

  // ── Static substitutions ──
  result = result.replace(/\{\{user\}\}/gi, ctx.user);
  result = result.replace(/\{\{persona\}\}/gi, ctx.user);
  result = result.replace(/\{\{char\}\}/gi, ctx.char);
  result = result.replace(/\{\{characters\}\}/gi, ctx.characters.join(", "));
  result = result.replace(/\{\{input\}\}/gi, ctx.lastInput ?? "");
  result = result.replace(/\{\{model\}\}/gi, ctx.model ?? "");
  result = result.replace(/\{\{chatId\}\}/gi, ctx.chatId ?? "");

  // ── Agent data ──
  result = result.replace(/\{\{agent::([\w-]+)\}\}/gi, (_, type) => {
    return ctx.agentData?.[type] ?? "";
  });

  // ── Date/time ──
  const now = new Date();
  result = result.replace(/\{\{date\}\}/gi, now.toISOString().slice(0, 10));
  result = result.replace(/\{\{time\}\}/gi, now.toTimeString().slice(0, 5));
  result = result.replace(/\{\{datetime\}\}/gi, now.toISOString());
  result = result.replace(/\{\{isotime\}\}/gi, now.toISOString());
  result = result.replace(/\{\{weekday\}\}/gi, now.toLocaleDateString("en-US", { weekday: "long" }));

  // ── Random numbers ──
  result = result.replace(/\{\{random\}\}/gi, () => String(Math.floor(Math.random() * 101)));
  result = result.replace(/\{\{random:(\d+):(\d+)\}\}/gi, (_, min, max) => {
    const lo = parseInt(min, 10);
    const hi = parseInt(max, 10);
    return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
  });

  // ── Dice rolls: {{roll:2d6}} ──
  result = result.replace(/\{\{roll:(\d+)d(\d+)\}\}/gi, (_, count, sides) => {
    const n = parseInt(count, 10);
    const s = parseInt(sides, 10);
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.floor(Math.random() * s) + 1;
    return String(total);
  });

  // ── Variable operations ──
  result = result.replace(/\{\{getvar::(\w+)\}\}/gi, (_, name) => {
    return ctx.variables[name] ?? "";
  });
  result = result.replace(/\{\{setvar::(\w+)::([^}]*)\}\}/gi, (_, name, val) => {
    ctx.variables[name] = val;
    return "";
  });
  result = result.replace(/\{\{addvar::(\w+)::([^}]*)\}\}/gi, (_, name, val) => {
    ctx.variables[name] = (ctx.variables[name] ?? "") + val;
    return "";
  });
  result = result.replace(/\{\{incvar::(\w+)\}\}/gi, (_, name) => {
    ctx.variables[name] = String((parseInt(ctx.variables[name] ?? "0", 10) || 0) + 1);
    return "";
  });
  result = result.replace(/\{\{decvar::(\w+)\}\}/gi, (_, name) => {
    ctx.variables[name] = String((parseInt(ctx.variables[name] ?? "0", 10) || 0) - 1);
    return "";
  });

  // ── Case transforms ──
  result = result.replace(/\{\{uppercase\}\}([\s\S]*?)\{\{\/uppercase\}\}/gi, (_, inner) =>
    (inner as string).toUpperCase(),
  );
  result = result.replace(/\{\{lowercase\}\}([\s\S]*?)\{\{\/lowercase\}\}/gi, (_, inner) =>
    (inner as string).toLowerCase(),
  );

  // ── Newlines ──
  result = result.replace(/\{\{newline\}\}/gi, "\n");
  result = result.replace(/\{\{\\n\}\}/g, "\n");

  // ── Trim markers (processed last) ──
  result = result.replace(/\{\{trimStart\}\}/gi, "\x00TRIM_START\x00");
  result = result.replace(/\{\{trimEnd\}\}/gi, "\x00TRIM_END\x00");
  result = result.replace(/\{\{trim\}\}/gi, "");

  // Apply directional trims
  if (result.includes("\x00TRIM_START\x00")) {
    result = result.replace(/\x00TRIM_START\x00\s*/g, "");
  }
  if (result.includes("\x00TRIM_END\x00")) {
    result = result.replace(/\s*\x00TRIM_END\x00/g, "");
  }

  // ── Catch-all: resolve any remaining {{name}} from variables ──
  // This allows preset variables like {{POV}} to resolve directly
  result = result.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const val = ctx.variables[name];
    return val !== undefined ? val : match; // leave unknown macros as-is
  });

  result = result.trim();

  return result;
}
