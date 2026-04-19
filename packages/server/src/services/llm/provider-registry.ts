// ──────────────────────────────────────────────
// LLM Provider — Registry & Factory
// ──────────────────────────────────────────────
import { OpenAIProvider } from "./providers/openai.provider.js";
import { AnthropicProvider } from "./providers/anthropic.provider.js";
import { GoogleProvider } from "./providers/google.provider.js";
import type { BaseLLMProvider } from "./base-provider.js";

/**
 * Factory that creates the correct LLM provider for a given provider type.
 */
export function createLLMProvider(
  provider: string,
  baseUrl: string,
  apiKey: string,
  maxContext?: number | null,
  openrouterProvider?: string | null,
): BaseLLMProvider {
  const normalizedMaxContext =
    typeof maxContext === "number" && Number.isFinite(maxContext) && maxContext > 0
      ? Math.floor(maxContext)
      : undefined;

  switch (provider) {
    case "openai":
    case "openrouter":
    case "nanogpt":
    case "mistral":
    case "cohere":
    case "custom":
      return new OpenAIProvider(baseUrl, apiKey, normalizedMaxContext, openrouterProvider);
    case "anthropic":
      return new AnthropicProvider(baseUrl, apiKey, normalizedMaxContext, openrouterProvider);
    case "google":
      return new GoogleProvider(baseUrl, apiKey, normalizedMaxContext, openrouterProvider);
    default:
      return new OpenAIProvider(baseUrl, apiKey, normalizedMaxContext, openrouterProvider);
  }
}
