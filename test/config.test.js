import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { validateEnvironment, getConfig } from "../reviewer/config.js";

describe("config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("validateEnvironment", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.OPENAI_MODEL = "test-model";
      process.env.OPENAI_MAX_INPUT_TOKENS = "4000";
    });

    it("does not throw when all required variables are set", () => {
      expect(() => validateEnvironment()).not.toThrow();
    });

    it("throws when OPENAI_API_KEY is missing", () => {
      delete process.env.OPENAI_API_KEY;
      expect(() => validateEnvironment()).toThrow("OPENAI_API_KEY");
    });

    it("throws when OPENAI_MODEL is missing", () => {
      delete process.env.OPENAI_MODEL;
      expect(() => validateEnvironment()).toThrow("OPENAI_MODEL");
    });

    it("throws when OPENAI_MAX_INPUT_TOKENS is missing", () => {
      delete process.env.OPENAI_MAX_INPUT_TOKENS;
      expect(() => validateEnvironment()).toThrow("OPENAI_MAX_INPUT_TOKENS");
    });

    it("throws with all missing variable names when none are set", () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_MAX_INPUT_TOKENS;
      expect(() => validateEnvironment()).toThrow(
        "OPENAI_API_KEY, OPENAI_MODEL, OPENAI_MAX_INPUT_TOKENS"
      );
    });
  });

  describe("getConfig", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "my-api-key";
      process.env.OPENAI_MODEL = "gpt-4";
      process.env.OPENAI_MAX_INPUT_TOKENS = "8000";
    });

    it("returns correct values from env", () => {
      const config = getConfig();
      expect(config).toEqual({
        apiKey: "my-api-key",
        baseURL: null,
        model: "gpt-4",
        maxInputTokens: 8000,
      });
    });

    it("includes baseURL when OPENAI_BASE_URL is set", () => {
      process.env.OPENAI_BASE_URL = "https://custom.api.com";
      const config = getConfig();
      expect(config.baseURL).toBe("https://custom.api.com");
    });

    it("defaults baseURL to null when not set", () => {
      delete process.env.OPENAI_BASE_URL;
      const config = getConfig();
      expect(config.baseURL).toBeNull();
    });

    it("defaults maxInputTokens to 4000 when invalid", () => {
      process.env.OPENAI_MAX_INPUT_TOKENS = "not-a-number";
      const config = getConfig();
      expect(config.maxInputTokens).toBe(4000);
    });

    it("defaults maxInputTokens to 4000 when empty", () => {
      process.env.OPENAI_MAX_INPUT_TOKENS = "";
      const config = getConfig();
      expect(config.maxInputTokens).toBe(4000);
    });
  });
});
