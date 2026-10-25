import { describe, expect, test } from "bun:test";
import { hasConfiguredAiProvider } from "./ai-provider-config";

describe("hasConfiguredAiProvider", () => {
  test("does not treat an endpoint URL alone as an AI credential", () => {
    expect(hasConfiguredAiProvider({
      OMNIROUTE_URL: "https://omniroute.example/v1",
    })).toBe(false);
  });

  test("accepts a nonblank OmniRoute key without requiring a custom URL", () => {
    expect(hasConfiguredAiProvider({
      OMNIROUTE_API_KEY: " primary-key ",
    })).toBe(true);
  });

  test("accepts a configured OpenAI fallback", () => {
    expect(hasConfiguredAiProvider({
      OPENAI_API_KEY: " openai-key ",
    })).toBe(true);
  });

  test("requires both OpenRouter key and model", () => {
    expect(hasConfiguredAiProvider({ OPENROUTER_API_KEY: "router-key" })).toBe(false);
    expect(hasConfiguredAiProvider({ OPENROUTER_MODEL: "provider/model" })).toBe(false);
    expect(hasConfiguredAiProvider({
      OPENROUTER_API_KEY: " router-key ",
      OPENROUTER_MODEL: " provider/model ",
    })).toBe(true);
  });

  test("ignores whitespace-only credentials", () => {
    expect(hasConfiguredAiProvider({
      OMNIROUTE_API_KEY: "   ",
      OPENAI_API_KEY: " ",
      OPENROUTER_API_KEY: " ",
      OPENROUTER_MODEL: "provider/model",
    })).toBe(false);
  });
});
