// ──────────────────────────────────────────────
// LLM Provider — OpenAI (& OAI-Compatible)
// ──────────────────────────────────────────────
import {
  BaseLLMProvider,
  type ChatMessage,
  type ChatOptions,
  type ChatCompletionResult,
  type LLMToolCall,
  type LLMUsage,
} from "../base-provider.js";

/**
 * Handles OpenAI, OpenRouter, Mistral, Cohere, and any OpenAI-compatible endpoint.
 */
export class OpenAIProvider extends BaseLLMProvider {
  /** Check if a model ID represents an OpenAI reasoning model */
  private isReasoningModel(model: string): boolean {
    const m = model.toLowerCase();
    return /^(o1|o3|o4)/.test(m) || m.startsWith("gpt-5");
  }

  private formatMessages(messages: ChatMessage[]) {
    return messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool" as const, content: m.content, tool_call_id: m.tool_call_id };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        return {
          role: "assistant" as const,
          content: m.content || null,
          tool_calls: m.tool_calls,
        };
      }
      // Multimodal: if message has images, use content array format
      if (m.images?.length) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const img of m.images) {
          parts.push({ type: "image_url", image_url: { url: img } });
        }
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content };
    });
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    const url = `${this.baseUrl}/chat/completions`;
    const reasoning = this.isReasoningModel(options.model);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.formatMessages(messages),
      stream: options.stream ?? true,
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...((options.stream ?? true) ? { stream_options: { include_usage: true } } : {}),
    };

    if (reasoning) {
      // Reasoning models use max_completion_tokens instead of max_tokens
      body.max_completion_tokens = options.maxTokens ?? 4096;
      // Reasoning models don't support temperature/top_p
    } else {
      body.temperature = options.temperature ?? 1;
      body.max_tokens = options.maxTokens ?? 4096;
      body.top_p = options.topP ?? 1;
    }

    // Send reasoning_effort if set (outside reasoning check so custom/OAI-compatible providers also get it)
    if (options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (!options.stream) {
      const json = (await response.json()) as {
        choices: Array<{ message: { content: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const msg = json.choices[0]?.message;
      if (msg?.reasoning_content && options.onThinking) {
        options.onThinking(msg.reasoning_content);
      }
      yield msg?.content ?? "";
      if (json.usage) {
        return {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        };
      }
      return;
    }

    // Stream SSE response
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let streamUsage: LLMUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          if (streamUsage) return streamUsage;
          return;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string; reasoning_content?: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          // Capture usage from the final chunk (OpenAI sends it with stream_options)
          if (parsed.usage) {
            streamUsage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            };
          }
          const delta = parsed.choices[0]?.delta;
          if (delta?.reasoning_content && options.onThinking) {
            options.onThinking(delta.reasoning_content);
          }
          if (delta?.content) yield delta.content;
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
    if (streamUsage) return streamUsage;
  }

  /** Non-streaming completion with tool-call support */
  async chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const reasoning = this.isReasoningModel(options.model);

    // Use streaming when an onToken callback is provided, so text arrives in real time
    const useStream = !!options.onToken;

    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.formatMessages(messages),
      stream: useStream,
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(useStream ? { stream_options: { include_usage: true } } : {}),
    };

    if (reasoning) {
      body.max_completion_tokens = options.maxTokens ?? 4096;
    } else {
      body.temperature = options.temperature ?? 1;
      body.max_tokens = options.maxTokens ?? 4096;
      body.top_p = options.topP ?? 1;
    }

    // Send reasoning_effort if set (outside reasoning check so custom/OAI-compatible providers also get it)
    if (options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (!useStream) {
      // Non-streaming path (no onToken callback)
      const json = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: LLMToolCall[];
            reasoning_content?: string;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const choice = json.choices[0];
      if ((choice?.message as any)?.reasoning_content && options.onThinking) {
        options.onThinking((choice?.message as any).reasoning_content);
      }
      const usage: LLMUsage | undefined = json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined;
      return {
        content: choice?.message?.content ?? null,
        toolCalls: choice?.message?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? "stop",
        usage,
      };
    }

    // ── Streaming path: stream text tokens via onToken, collect tool calls ──
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "stop";
    let streamUsage: LLMUsage | undefined;

    // Accumulate tool calls from deltas
    const toolCallsMap = new Map<
      number,
      { id: string; type: "function"; function: { name: string; arguments: string } }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{
              delta: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: "function";
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };

          if (parsed.usage) {
            streamUsage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            };
          }

          const choice = parsed.choices[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const delta = choice.delta;

          // Stream reasoning/thinking
          if (delta?.reasoning_content && options.onThinking) {
            options.onThinking(delta.reasoning_content);
          }

          // Stream text content
          if (delta?.content) {
            content += delta.content;
            options.onToken!(delta.content);
          }

          // Accumulate tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsMap.get(tc.index);
              if (!existing) {
                toolCallsMap.set(tc.index, {
                  id: tc.id ?? "",
                  type: "function",
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Collect tool calls in order
    const toolCalls: LLMToolCall[] = [];
    const sortedKeys = [...toolCallsMap.keys()].sort((a, b) => a - b);
    for (const key of sortedKeys) {
      toolCalls.push(toolCallsMap.get(key)!);
    }

    return {
      content: content || null,
      toolCalls,
      finishReason: finishReason === "tool_calls" ? "tool_calls" : finishReason,
      usage: streamUsage,
    };
  }
}
