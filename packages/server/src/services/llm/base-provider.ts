// ──────────────────────────────────────────────
// LLM Provider — Abstract Base
// ──────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For tool result messages */
  tool_call_id?: string;
  /** For assistant messages with tool calls */
  tool_calls?: LLMToolCall[];
  /** Base64 data URLs for multimodal image inputs */
  images?: string[];
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  stop?: string[];
  /** Tool/function definitions for function calling */
  tools?: LLMToolDefinition[];
  /** Enable Anthropic prompt caching */
  enableCaching?: boolean;
  /** Callback for streaming thinking/reasoning content */
  onThinking?: (chunk: string) => void;
  /** Callback for streaming text tokens as they arrive (used in tool path) */
  onToken?: (chunk: string) => void;
  /** Enable extended thinking (reasoning models) */
  enableThinking?: boolean;
  /** Reasoning effort level for models that support it */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /** Output verbosity for GPT-5+ models */
  verbosity?: "low" | "medium" | "high";
  /** Abort signal — when triggered, the in-flight LLM request should be cancelled. */
  signal?: AbortSignal;
}

/** Token usage statistics returned by the model */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Result from a non-streaming chat call that may include tool calls */
export interface ChatCompletionResult {
  content: string | null;
  toolCalls: LLMToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | string;
  usage?: LLMUsage;
}

/**
 * Abstract base for all LLM providers.
 * Every provider must implement the `chat` method as an async generator.
 */
export abstract class BaseLLMProvider {
  constructor(
    protected baseUrl: string,
    protected apiKey: string,
  ) {}

  /**
   * Stream a chat completion. Yields text chunks, optionally returns usage on completion.
   */
  abstract chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown>;

  /**
   * Non-streaming chat completion with tool-use support.
   * Default implementation collects from the streaming generator.
   * If onToken is provided, streams text chunks in real time.
   */
  async chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    let content = "";
    const useStream = !!options.onToken;
    const gen = this.chat(messages, { ...options, stream: useStream });
    let result = await gen.next();
    while (!result.done) {
      content += result.value;
      if (options.onToken) {
        options.onToken(result.value);
      }
      result = await gen.next();
    }
    const usage = result.value || undefined;
    return { content, toolCalls: [], finishReason: "stop", usage };
  }
}
