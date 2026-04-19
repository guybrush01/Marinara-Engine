// ──────────────────────────────────────────────
// Sidecar Local Model — Inference Service
//
// Talks to a spawned llama-server subprocess via
// its OpenAI-compatible localhost HTTP API.
// ──────────────────────────────────────────────

import type { SceneAnalysis } from "@marinara-engine/shared";
import { sanitizeApiError } from "../llm/base-provider.js";
import { sidecarModelService } from "./sidecar-model.service.js";
import { sidecarProcessService } from "./sidecar-process.service.js";

let activeRequests = 0;

function withRequestTracking<T>(fn: () => Promise<T>): Promise<T> {
  activeRequests += 1;
  return fn().finally(() => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
}

export function isInferenceBusy(): boolean {
  return activeRequests > 0;
}

const MAX_OUTPUT_TOKENS = 8192;
const SCENE_ANALYSIS_MAX_TOKENS = 4096;

type SidecarMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    let text = "";
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
    return text;
  }

  return "";
}

function extractJsonPayload<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      return JSON.parse(fenced) as T;
    }
    throw new Error("Sidecar returned invalid JSON");
  }
}

async function streamChatCompletion(options: {
  messages: SidecarMessage[];
  maxTokens: number;
  responseFormat?: Record<string, unknown>;
}): Promise<string> {
  const baseUrl = await sidecarProcessService.ensureReady();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "local-sidecar",
      stream: true,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`llama-server error ${response.status}: ${sanitizeApiError(errorText || response.statusText)}`);
  }

  if (!response.body) {
    throw new Error("llama-server returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

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
        return content;
      }

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }>;
        };

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content !== undefined) {
          content += extractContentText(choice.delta.content);
        } else if (choice.message?.content !== undefined) {
          content += extractContentText(choice.message.content);
        }
      } catch {
        // Ignore malformed chunks and keep streaming.
      }
    }
  }

  if (buffer.trim().startsWith("data: ")) {
    const trailing = buffer.trim().slice(6);
    if (trailing !== "[DONE]") {
      try {
        const parsed = JSON.parse(trailing) as {
          choices?: Array<{
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }>;
        };
        const choice = parsed.choices?.[0];
        if (choice?.delta?.content !== undefined) {
          content += extractContentText(choice.delta.content);
        } else if (choice?.message?.content !== undefined) {
          content += extractContentText(choice.message.content);
        }
      } catch {
        // Ignore malformed trailing chunk.
      }
    }
  }

  return content;
}

export async function unloadModel(): Promise<void> {
  await sidecarProcessService.stop();
}

const SCENE_WIDGET_UPDATE_SCHEMA = {
  type: "object" as const,
  properties: {
    widgetId: { type: "string" as const },
    value: { type: ["number", "string"] as const },
    count: { type: "number" as const },
    add: { type: "string" as const },
    remove: { type: "string" as const },
    running: { type: "boolean" as const },
    seconds: { type: "number" as const },
    statName: { type: "string" as const },
  },
  required: ["widgetId"] as const,
  additionalProperties: false as const,
};

const SCENE_ANALYSIS_SCHEMA = {
  type: "object" as const,
  properties: {
    background: { type: ["string", "null"] as const },
    music: { type: ["string", "null"] as const },
    ambient: { type: ["string", "null"] as const },
    weather: { type: ["string", "null"] as const },
    timeOfDay: { type: ["string", "null"] as const },
    reputationChanges: {
      type: "array" as const,
      maxItems: 5,
      items: {
        type: "object" as const,
        properties: {
          npcName: { type: "string" as const },
          action: { type: "string" as const },
        },
        required: ["npcName", "action"] as const,
        additionalProperties: false as const,
      },
    },
    widgetUpdates: {
      type: "array" as const,
      maxItems: 20,
      items: SCENE_WIDGET_UPDATE_SCHEMA,
    },
    segmentEffects: {
      type: "array" as const,
      maxItems: 20,
      items: {
        type: "object" as const,
        properties: {
          segment: { type: "number" as const },
          background: { type: ["string", "null"] as const },
          music: { type: ["string", "null"] as const },
          ambient: { type: ["string", "null"] as const },
          sfx: {
            type: "array" as const,
            items: { type: "string" as const },
            maxItems: 3,
          },
          expressions: {
            type: "object" as const,
            additionalProperties: { type: "string" as const },
          },
          widgetUpdates: {
            type: "array" as const,
            items: SCENE_WIDGET_UPDATE_SCHEMA,
            maxItems: 10,
          },
        },
        required: ["segment"] as const,
        additionalProperties: false as const,
      },
    },
  },
  additionalProperties: false as const,
  required: [
    "background",
    "music",
    "ambient",
    "weather",
    "timeOfDay",
    "reputationChanges",
    "widgetUpdates",
    "segmentEffects",
  ] as const,
};

export async function analyzeScene(systemPrompt: string, userPrompt: string): Promise<SceneAnalysis> {
  return withRequestTracking(async () => {
    const raw = await streamChatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: SCENE_ANALYSIS_MAX_TOKENS,
      responseFormat: {
        type: "json_schema",
        schema: SCENE_ANALYSIS_SCHEMA,
      },
    });

    return extractJsonPayload<SceneAnalysis>(raw);
  });
}

export async function runTrackerPrompt(systemPrompt: string, userPrompt: string): Promise<string> {
  return withRequestTracking(async () => {
    return await streamChatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  });
}

export async function isInferenceAvailable(): Promise<boolean> {
  if (!sidecarModelService.getModelFilePath() || !sidecarModelService.isEnabled()) {
    return false;
  }

  try {
    await sidecarProcessService.syncForCurrentConfig();
  } catch {
    return false;
  }

  return sidecarProcessService.isReady();
}
