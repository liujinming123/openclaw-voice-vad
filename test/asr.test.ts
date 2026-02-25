/**
 * ASR Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BaiduASR } from "../src/asr";

describe("BaiduASR", () => {
  let asr: BaiduASR;

  beforeEach(() => {
    asr = new BaiduASR({
      appId: "test-app-id",
      apiKey: "test-api-key",
      secretKey: "test-secret-key",
    });
  });

  describe("containsWakeWord", () => {
    it("should detect wake word", () => {
      expect(asr.containsWakeWord("你好")).toBe(true);
      expect(asr.containsWakeWord("你好世界")).toBe(true);
      expect(asr.containsWakeWord("你好吗")).toBe(true);
    });

    it("should not detect wake word when not present", () => {
      expect(asr.containsWakeWord("世界")).toBe(false);
      expect(asr.containsWakeWord("")).toBe(false);
    });

    it("should use custom wake word", () => {
      expect(asr.containsWakeWord("小助手", "小助手")).toBe(true);
      expect(asr.containsWakeWord("小助手你好", "小助手")).toBe(true);
    });
  });

  describe("extractCommand", () => {
    it("should extract command after wake word", () => {
      expect(asr.extractCommand("你好今天天气怎么样")).toBe("今天天气怎么样");
      expect(asr.extractCommand("你好 帮我查一下天气")).toBe("帮我查一下天气");
    });

    it("should return trimmed text when no wake word", () => {
      expect(asr.extractCommand("今天天气怎么样")).toBe("今天天气怎么样");
    });

    it("should handle edge cases", () => {
      expect(asr.extractCommand("你好")).toBe("");
      expect(asr.extractCommand("")).toBe("");
    });
  });
});
