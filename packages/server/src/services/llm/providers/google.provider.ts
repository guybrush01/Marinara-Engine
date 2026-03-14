// ──────────────────────────────────────────────
// LLM Provider — Google Gemini
// ──────────────────────────────────────────────
import { BaseLLMProvider, type ChatMessage, type ChatOptions, type LLMUsage } from "../base-provider.js";

/**
 * Handles Google Gemini API (generateContent / streamGenerateContent).
 */
export class GoogleProvider extends BaseLLMProvider {
  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    const model = options.model || "gemini-2.0-flash";
    const endpoint = options.stream ? "streamGenerateContent" : "generateContent";
    const url = `${this.baseUrl}/models/${model}:${endpoint}?key=${this.apiKey}${options.stream ? "&alt=sse" : ""}`;

    // Convert to Gemini format
    const systemMessages = messages.filter((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const contents = chatMessages.map((m) => {
      const parts: Array<Record<string, unknown>> = [];
      if (m.images?.length) {
        for (const img of m.images) {
          const match = img.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
          }
        }
      }
      parts.push({ text: m.content });
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 1,
        maxOutputTokens: options.maxTokens ?? 4096,
        topP: options.topP ?? 1,
      },
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (!options.stream) {
      const json = (await response.json()) as {
        candidates: Array<{
          content: { parts: Array<{ text?: string; thought?: boolean }> };
        }>;
        usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
      };
      const parts = json.candidates[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.thought && part.text && options.onThinking) {
          options.onThinking(part.text);
        } else if (part.text && !part.thought) {
          yield part.text;
        }
      }
      if (json.usageMetadata) {
        return {
          promptTokens: json.usageMetadata.promptTokenCount,
          completionTokens: json.usageMetadata.candidatesTokenCount,
          totalTokens: json.usageMetadata.totalTokenCount,
        };
      }
      return;
    }

    // Stream SSE
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

        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; thought?: boolean }> };
            }>;
            usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
          };
          if (parsed.usageMetadata) {
            streamUsage = {
              promptTokens: parsed.usageMetadata.promptTokenCount,
              completionTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
            };
          }
          const parts = parsed.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.thought && part.text && options.onThinking) {
              options.onThinking(part.text);
            } else if (part.text && !part.thought) {
              yield part.text;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    if (streamUsage) return streamUsage;
  }
}
