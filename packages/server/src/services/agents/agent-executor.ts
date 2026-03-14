// ──────────────────────────────────────────────
// Agent Executor — Single & Batched LLM execution
// ──────────────────────────────────────────────
import type { BaseLLMProvider, ChatMessage, LLMToolDefinition, LLMToolCall } from "../llm/base-provider.js";
import type { AgentResult, AgentContext, AgentResultType } from "@marinara-engine/shared";
import { getDefaultAgentPrompt } from "@marinara-engine/shared";

/** Minimal agent config needed for execution. */
export interface AgentExecConfig {
  id: string;
  type: string;
  name: string;
  phase: string;
  promptTemplate: string;
  connectionId: string | null;
  settings: Record<string, unknown>;
}

/** Optional tool context for agents that need function calling. */
export interface AgentToolContext {
  tools: LLMToolDefinition[];
  executeToolCall: (call: LLMToolCall) => Promise<string>;
}

/**
 * Execute a single agent: build prompt → call LLM → parse response.
 * If toolContext is provided, the agent can make tool calls in a loop.
 */
export async function executeAgent(
  config: AgentExecConfig,
  context: AgentContext,
  provider: BaseLLMProvider,
  model: string,
  toolContext?: AgentToolContext,
): Promise<AgentResult> {
  const startTime = Date.now();

  try {
    // Build the agent's system prompt
    const template = config.promptTemplate || getDefaultAgentPrompt(config.type);
    if (!template) {
      return makeError(config, "No prompt template configured", startTime);
    }

    // Build context block for the agent
    const contextBlock = buildContextBlock(context, config.type);

    const messages: ChatMessage[] = [
      { role: "system", content: template },
      { role: "user", content: contextBlock },
    ];

    // Agents use lower temperature for reliability
    const temperature = (config.settings.temperature as number) ?? 0.3;
    const maxTokens = (config.settings.maxTokens as number) ?? 2048;

    // If tools are available, use the tool call loop
    if (toolContext && toolContext.tools.length > 0) {
      return executeAgentWithTools(
        config,
        messages,
        provider,
        model,
        temperature,
        maxTokens,
        toolContext,
        startTime,
        context.signal,
      );
    }

    // Call LLM (non-streaming, no tools)
    const result = await provider.chatComplete(messages, {
      model,
      temperature,
      maxTokens,
      signal: context.signal,
    });

    const responseText = result.content?.trim() ?? "";
    const durationMs = Date.now() - startTime;

    // Parse the result based on agent type
    const parsed = parseAgentResponse(config.type, responseText);

    return {
      agentId: config.id,
      agentType: config.type,
      type: parsed.type,
      data: parsed.data,
      tokensUsed: result.usage?.totalTokens ?? 0,
      durationMs,
      success: true,
      error: null,
    };
  } catch (err) {
    return makeError(config, extractErrorMessage(err), startTime);
  }
}

/**
 * Execute an agent with tool-calling support.
 * Loops: call LLM → handle tool calls → feed results back → repeat until final response.
 */
async function executeAgentWithTools(
  config: AgentExecConfig,
  initialMessages: ChatMessage[],
  provider: BaseLLMProvider,
  model: string,
  temperature: number,
  maxTokens: number,
  toolContext: AgentToolContext,
  startTime: number,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const MAX_TOOL_ROUNDS = 5;
  const loopMessages = [...initialMessages];
  let totalTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await provider.chatComplete(loopMessages, {
      model,
      temperature,
      maxTokens,
      tools: toolContext.tools,
      signal,
    });

    totalTokens += result.usage?.totalTokens ?? 0;

    // No tool calls → final response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      const responseText = result.content?.trim() ?? "";
      const parsed = parseAgentResponse(config.type, responseText);
      return {
        agentId: config.id,
        agentType: config.type,
        type: parsed.type,
        data: parsed.data,
        tokensUsed: totalTokens,
        durationMs: Date.now() - startTime,
        success: true,
        error: null,
      };
    }

    // Append assistant message with tool calls
    loopMessages.push({
      role: "assistant",
      content: result.content ?? "",
      tool_calls: result.toolCalls,
    });

    // Execute each tool call and append results
    for (const tc of result.toolCalls) {
      const toolResult = await toolContext.executeToolCall(tc);
      loopMessages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  // Exhausted tool rounds — make one final call without tools to get JSON response
  const finalResult = await provider.chatComplete(loopMessages, { model, temperature, maxTokens, signal });
  totalTokens += finalResult.usage?.totalTokens ?? 0;
  const responseText = finalResult.content?.trim() ?? "";
  const parsed = parseAgentResponse(config.type, responseText);
  return {
    agentId: config.id,
    agentType: config.type,
    type: parsed.type,
    data: parsed.data,
    tokensUsed: totalTokens,
    durationMs: Date.now() - startTime,
    success: true,
    error: null,
  };
}

// ──────────────────────────────────────────────
// Batched Execution — Multiple agents in one LLM call
// ──────────────────────────────────────────────

/**
 * Execute multiple agents in a single LLM call.
 * Combines all agent prompts into one request using XML-delimited sections,
 * then parses the combined response back into individual AgentResults.
 *
 * All agents in the batch MUST share the same provider+model.
 * Falls back to individual calls if the batch response can't be parsed.
 */
export async function executeAgentBatch(
  configs: AgentExecConfig[],
  context: AgentContext,
  provider: BaseLLMProvider,
  model: string,
): Promise<AgentResult[]> {
  if (configs.length === 0) return [];
  if (configs.length === 1) {
    return [await executeAgent(configs[0]!, context, provider, model)];
  }

  const startTime = Date.now();

  try {
    // Build merged system prompt
    const systemPrompt = buildBatchSystemPrompt(configs);
    const contextBlock = buildContextBlock(context, "__batch__");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: contextBlock },
    ];

    // Use conservative settings for batch calls
    const maxTokensPerAgent = Math.max(...configs.map((c) => (c.settings.maxTokens as number) ?? 2048));
    const temperature = Math.min(...configs.map((c) => (c.settings.temperature as number) ?? 0.3));

    const result = await provider.chatComplete(messages, {
      model,
      temperature,
      maxTokens: Math.min(maxTokensPerAgent * configs.length, 16384),
      signal: context.signal,
    });

    const responseText = result.content?.trim() ?? "";
    const durationMs = Date.now() - startTime;
    const totalTokens = result.usage?.totalTokens ?? 0;

    // Parse the batched response into individual results
    const { parsed, failed } = parseBatchResponse(configs, responseText, durationMs, totalTokens);

    // Retry failed agents individually (batch fallback)
    if (failed.length > 0) {
      const retries = await Promise.all(failed.map((config) => executeAgent(config, context, provider, model)));
      return [...parsed, ...retries];
    }

    return parsed;
  } catch (err) {
    // On failure, return errors for all agents in the batch
    const errMsg = err instanceof Error ? err.message : "Batch execution failed";
    return configs.map((c) => makeError(c, errMsg, startTime));
  }
}

/**
 * Build a combined system prompt that instructs the model to produce
 * output for all agents in clearly delimited sections.
 */
function buildBatchSystemPrompt(configs: AgentExecConfig[]): string {
  const parts: string[] = [];

  parts.push(
    `You are a multi-agent analysis system. You will execute ${configs.length} agent tasks in a SINGLE response.`,
    ``,
    `For EACH agent below, produce your output inside the corresponding XML result tags.`,
    `You MUST output a <result> block for every agent — do not skip any.`,
    ``,
    `─── AGENTS ───`,
  );

  for (const config of configs) {
    const template = config.promptTemplate || getDefaultAgentPrompt(config.type);
    parts.push(``, `<agent_task id="${config.type}" name="${config.name}">`, template, `</agent_task>`);
  }

  parts.push(``, `─── OUTPUT FORMAT ───`, `Respond with one <result> block per agent, in order:`, ``);

  for (const config of configs) {
    const isJson = JSON_AGENTS.has(config.type);
    parts.push(
      `<result agent="${config.type}">`,
      isJson ? `{...your JSON output...}` : `...your text output...`,
      `</result>`,
      ``,
    );
  }

  parts.push(
    `IMPORTANT:`,
    `- Output ALL <result> blocks, one per agent.`,
    `- Use the exact agent IDs shown above.`,
    `- JSON agents must output valid JSON (no markdown fences inside the tags).`,
    `- Text agents output plain text.`,
  );

  return parts.join("\n");
}

/**
 * Parse a batched LLM response into individual AgentResults.
 * Looks for <result agent="type">...</result> blocks.
 */
function parseBatchResponse(
  configs: AgentExecConfig[],
  responseText: string,
  totalDurationMs: number,
  totalTokens: number = 0,
): { parsed: AgentResult[]; failed: AgentExecConfig[] } {
  const perAgentDuration = Math.round(totalDurationMs / configs.length);
  const perAgentTokens = Math.round(totalTokens / configs.length);
  const parsed: AgentResult[] = [];
  const failed: AgentExecConfig[] = [];

  for (const config of configs) {
    // Try to extract <result agent="type">...</result>
    const pattern = new RegExp(`<result\\s+agent=["']${escapeRegex(config.type)}["']>([\\s\\S]*?)</result>`, "i");
    const match = responseText.match(pattern);

    if (match) {
      const agentOutput = match[1]!.trim();
      const parsedResult = parseAgentResponse(config.type, agentOutput);
      parsed.push({
        agentId: config.id,
        agentType: config.type,
        type: parsedResult.type,
        data: parsedResult.data,
        tokensUsed: perAgentTokens,
        durationMs: perAgentDuration,
        success: true,
        error: null,
      });
    } else {
      // Could not find this agent's output — mark for individual retry
      failed.push(config);
    }
  }

  return { parsed, failed };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Helpers ──

function makeError(config: AgentExecConfig, error: string, startTime: number): AgentResult {
  return {
    agentId: config.id,
    agentType: config.type,
    type: AGENT_RESULT_TYPE_MAP[config.type] ?? "context_injection",
    data: null,
    tokensUsed: 0,
    durationMs: Date.now() - startTime,
    success: false,
    error,
  };
}

/** Extract a useful message from fetch/network errors (preserves err.cause). */
export function extractErrorMessage(err: unknown, fallback = "Agent execution failed"): string {
  if (!(err instanceof Error)) return fallback;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return `${err.message}: ${cause.message}`;
  }
  return err.message || fallback;
}

/**
 * Build a context block that gets sent as the user message to the agent.
 * Provides structured context about the current chat state.
 */
function buildContextBlock(context: AgentContext, agentType: string): string {
  const parts: string[] = [];

  // Chat info
  parts.push(`<chat_info>`);
  parts.push(`Chat ID: ${context.chatId}`);
  parts.push(`Mode: ${context.chatMode}`);
  parts.push(`</chat_info>`);

  // Characters
  if (context.characters.length > 0) {
    parts.push(`\n<characters>`);
    for (const char of context.characters) {
      parts.push(`- ${char.name}: ${char.description.slice(0, 2000)}`);
    }
    parts.push(`</characters>`);
  }

  // Persona
  if (context.persona) {
    parts.push(`\n<user_persona>`);
    parts.push(`Name: ${context.persona.name}`);
    if (context.persona.description) parts.push(context.persona.description.slice(0, 2000));
    if (context.persona.personaStats?.enabled && context.persona.personaStats.bars.length > 0) {
      parts.push(`\nConfigured persona stat bars:`);
      for (const bar of context.persona.personaStats.bars) {
        parts.push(`- ${bar.name}: ${bar.value}/${bar.max} (color: ${bar.color})`);
      }
    }
    parts.push(`</user_persona>`);
  }

  // Game state
  if (context.gameState) {
    parts.push(`\n<current_game_state>`);
    parts.push(JSON.stringify(context.gameState, null, 2));
    parts.push(`</current_game_state>`);
  }

  // Recent messages (last N for context)
  if (context.recentMessages.length > 0) {
    parts.push(`\n<recent_messages>`);
    for (const msg of context.recentMessages) {
      const speaker = msg.characterId ?? msg.role;
      parts.push(`[${speaker}]: ${msg.content.slice(0, 2000)}`);
    }
    parts.push(`</recent_messages>`);
  }

  // Main response (for post-processing agents)
  if (context.mainResponse) {
    parts.push(`\n<assistant_response>`);
    parts.push(context.mainResponse);
    parts.push(`</assistant_response>`);
  }

  // Agent persistent memory
  if (Object.keys(context.memory).length > 0) {
    parts.push(`\n<agent_memory>`);
    parts.push(JSON.stringify(context.memory, null, 2));
    parts.push(`</agent_memory>`);
  }

  // Activated lorebook entries
  if (context.activatedLorebookEntries && context.activatedLorebookEntries.length > 0) {
    parts.push(`\n<lorebook_entries>`);
    for (const entry of context.activatedLorebookEntries) {
      parts.push(`[${entry.tag}] ${entry.name}: ${entry.content}`);
    }
    parts.push(`</lorebook_entries>`);
  }

  // Available sprites (for the expression agent)
  if (context.memory._availableSprites) {
    const sprites = context.memory._availableSprites as Array<{
      characterId: string;
      characterName: string;
      expressions: string[];
    }>;
    parts.push(`\n<available_sprites>`);
    for (const char of sprites) {
      parts.push(`${char.characterName} (${char.characterId}): ${char.expressions.join(", ")}`);
    }
    parts.push(`</available_sprites>`);
  }

  // Available backgrounds (for the background agent)
  if (agentType === "background" && context.memory._availableBackgrounds) {
    const bgs = context.memory._availableBackgrounds as Array<{
      filename: string;
      originalName?: string | null;
      tags: string[];
    }>;
    parts.push(`\n<available_backgrounds>`);
    for (const bg of bgs) {
      const label = bg.originalName ? `${bg.filename} (${bg.originalName})` : bg.filename;
      const tagStr = bg.tags.length > 0 ? ` [tags: ${bg.tags.join(", ")}]` : "";
      parts.push(`- ${label}${tagStr}`);
    }
    parts.push(`</available_backgrounds>`);
    if (context.memory._currentBackground) {
      parts.push(`\n<current_background>${context.memory._currentBackground}</current_background>`);
    }
  }

  // Agent results summary (for the editor agent)
  if (context.memory._agentResults) {
    parts.push(`\n<agent_results>`);
    parts.push(JSON.stringify(context.memory._agentResults, null, 2));
    parts.push(`</agent_results>`);
  }

  // Source material for knowledge-retrieval agent
  if (context.memory._sourceMaterial) {
    const material = context.memory._sourceMaterial as string;
    parts.push(`\n<source_material>`);
    parts.push(material);
    parts.push(`</source_material>`);
  }

  // Chunk info for multi-pass knowledge-retrieval scanning
  if (context.memory._chunkInfo) {
    const info = context.memory._chunkInfo as { current: number; total: number };
    parts.push(
      `\n<chunk_info>Chunk ${info.current} of ${info.total} — extract relevant information from this chunk.</chunk_info>`,
    );
  }

  // Previous chunk extractions for consolidation pass
  if (context.memory._previousExtractions) {
    const extractions = context.memory._previousExtractions as string[];
    parts.push(`\n<previous_extractions>`);
    parts.push(
      `The following relevant excerpts were extracted from prior chunks of the same source material. Consolidate them into a single, coherent summary along with any new relevant information from the current chunk.`,
    );
    for (let i = 0; i < extractions.length; i++) {
      parts.push(`\n--- Chunk ${i + 1} ---`);
      parts.push(extractions[i]!);
    }
    parts.push(`</previous_extractions>`);
  }

  return parts.join("\n");
}

/** Map agent type → its primary result type. */
const AGENT_RESULT_TYPE_MAP: Record<string, AgentResultType> = {
  "world-state": "game_state_update",
  "prose-guardian": "context_injection",
  continuity: "continuity_check",
  expression: "sprite_change",
  "echo-chamber": "echo_message",
  director: "director_event",
  quest: "quest_update",
  illustrator: "image_prompt",
  "lorebook-keeper": "lorebook_update",
  "prompt-reviewer": "prompt_review",
  combat: "game_state_update",
  background: "background_change",
  "character-tracker": "character_tracker_update",
  "persona-stats": "persona_stats_update",
  "chat-summary": "chat_summary",
  spotify: "spotify_control",
  editor: "text_rewrite",
  "knowledge-retrieval": "context_injection",
};

/** Agents that return structured JSON. */
const JSON_AGENTS = new Set([
  "world-state",
  "continuity",
  "expression",
  "echo-chamber",
  "quest",
  "illustrator",
  "lorebook-keeper",
  "prompt-reviewer",
  "combat",
  "background",
  "character-tracker",
  "persona-stats",
  "chat-summary",
  "spotify",
  "editor",
]);

/**
 * Parse the raw LLM response into a typed result.
 */
function parseAgentResponse(agentType: string, responseText: string): { type: AgentResultType; data: unknown } {
  const resultType = AGENT_RESULT_TYPE_MAP[agentType] ?? "context_injection";

  if (JSON_AGENTS.has(agentType)) {
    try {
      const jsonStr = extractJson(responseText);
      const data = JSON.parse(jsonStr);
      return { type: resultType, data };
    } catch {
      return { type: resultType, data: { raw: responseText, parseError: true } };
    }
  }

  // Text-based agents (prose-guardian, director)
  return { type: resultType, data: { text: responseText } };
}

/** Extract JSON from a response that may contain markdown fences. */
function extractJson(text: string): string {
  // Try markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1]!.trim();

  // Try to find a bare JSON object or array
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) return jsonMatch[1]!;

  return text;
}
