/**
 * Tests for query module - core translation functionality
 */

import {
  buildRequestBody,
  normalizeLanguageCode,
  query,
} from "../../src/lib/query";
import { MAX_FREE_TEXT_LENGTH } from "../../src/lib/const";
import type { RequestParams } from "../../src/lib/types";

// The version lookup is network I/O with its own tests (appVersion.test.ts);
// keep this suite focused on the translation request itself.
jest.mock("../../src/lib/appVersion", () => ({
  resolveDeepLAppVersion: jest.fn().mockResolvedValue("26.52"),
  invalidateDeepLAppVersion: jest.fn(),
}));

/**
 * Minimal stand-in for a fetch Response, carrying only what query() reads.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("Query Module", () => {
  let mockEnv: Env;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("normalizeLanguageCode", () => {
    it("should normalize language codes to uppercase", () => {
      expect(normalizeLanguageCode("en")).toBe("EN");
      expect(normalizeLanguageCode("zh")).toBe("ZH");
      expect(normalizeLanguageCode("auto")).toBe("auto");
    });

    it("should handle language name mappings", () => {
      expect(normalizeLanguageCode("english")).toBe("EN");
      expect(normalizeLanguageCode("chinese")).toBe("ZH");
      expect(normalizeLanguageCode("spanish")).toBe("ES");
    });

    it("should handle edge cases", () => {
      expect(normalizeLanguageCode("")).toBe("auto");
      expect(normalizeLanguageCode("AUTO")).toBe("auto");
      expect(normalizeLanguageCode("unknown")).toBe("UNKNOWN");
    });
  });

  describe("buildRequestBody", () => {
    it("should build a valid oneshot request body", () => {
      const params = {
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      };

      const body = buildRequestBody(params, "26.52");
      const parsed = JSON.parse(body);

      expect(parsed.text).toEqual(["Hello world"]);
      expect(parsed.target_lang).toBe("zh-Hans");
      expect(parsed.source_lang).toBe("en");
      expect(parsed.usage_type).toBe("translate");
      expect(parsed.app_information).toMatchObject({
        os: "iOS",
        os_version: "26.0",
        app_version: "26.52",
        app_build: "5443737",
      });
      expect(parsed.app_information.instance_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("should resolve legacy EN and PT targets to regional defaults", () => {
      const en = JSON.parse(
        buildRequestBody({ text: "Hello", source_lang: "auto", target_lang: "en" })
      );
      const pt = JSON.parse(
        buildRequestBody({ text: "Hello", source_lang: "auto", target_lang: "pt" })
      );

      expect(en.target_lang).toBe("en-US");
      expect(pt.target_lang).toBe("pt-BR");
    });

    it("should omit source_lang when auto-detecting", () => {
      const parsed = JSON.parse(
        buildRequestBody({ text: "Hello", source_lang: "auto", target_lang: "de" })
      );

      expect(parsed).not.toHaveProperty("source_lang");
      expect(parsed.target_lang).toBe("de");
    });

    it("should reject unsupported target languages", () => {
      expect(() =>
        buildRequestBody({ text: "Hello", source_lang: "en", target_lang: "xx" })
      ).toThrow(/Unsupported target_lang/);
    });

    it("should throw error for invalid parameters", () => {
      expect(() => buildRequestBody({} as RequestParams)).toThrow();
      expect(() => buildRequestBody({ text: "" } as RequestParams)).toThrow();
      expect(() => buildRequestBody({ text: "   " } as RequestParams)).toThrow();
    });

    it("should enforce the free-tier text length cap", () => {
      const text = "a".repeat(MAX_FREE_TEXT_LENGTH + 1);

      expect(() =>
        buildRequestBody({ text, source_lang: "en", target_lang: "de" })
      ).toThrow(/limit is 1500/);
    });

    it("should handle text length limits", () => {
      const longText = "a".repeat(10000);
      expect(() =>
        buildRequestBody({
          text: longText,
          source_lang: "en",
          target_lang: "zh",
        })
      ).toThrow(/Text too long/);
    });
  });

  describe("query function", () => {
    it("should return error for missing text", async () => {
      const result = await query({} as RequestParams);
      expect(result).toBeValidErrorResponse();
      expect(result.code).toBe(400);
    });

    it("should handle successful translation", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          translations: [
            { text: "你好世界", detected_source_language: "en" },
          ],
        })
      );

      const result = await query({
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      });

      expect(result).toBeValidTranslationResponse();
      expect(result.code).toBe(200);
      expect(result.data).toBe("你好世界");
      expect(result.source_lang).toBe("EN");
      expect(result.target_lang).toBe("ZH");
    });

    it("should send the iOS oneshot profile", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ translations: [{ text: "Hallo" }] })
      );

      await query({
        text: "Hello",
        source_lang: "en",
        target_lang: "de",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [endpoint, init] = mockFetch.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;

      expect(endpoint).toBe("https://oneshot-free.www.deepl.com/v1/translate");
      expect(headers.Authorization).toBe("None");
      expect(headers["User-Agent"]).toMatch(/^DeepL\/.+ CFNetwork\/.+ Darwin\//);
      expect(headers["x-app-os-version"]).toBe("26.0");
      expect(headers["x-app-instance-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers["x-app-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("should return 400 for unsupported target languages without calling upstream", async () => {
      const result = await query({
        text: "Hello",
        source_lang: "en",
        target_lang: "xx",
      });

      expect(result.code).toBe(400);
      expect(result.data).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should surface a 403 refusal without retrying", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ title: "OutdatedClient" }, 403)
      );

      const result = await query({
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      });

      expect(result.code).toBe(403);
      expect(result.data).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should reject an invalid response structure", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ translations: [] }, 200));

      const result = await query({
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      });

      expect(result).toBeValidErrorResponse();
      expect(result.code).toBeGreaterThanOrEqual(400);
    });

    it("should map DeepL's outdated-client notice to 502", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          translations: [
            {
              text: "You're using an older version of DeepL. To continue using the app, please update to the latest version.",
            },
          ],
        })
      );

      const result = await query({
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      });

      expect(result.code).toBe(502);
      expect(result.data).toBeNull();
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await query({
        text: "Hello world",
        source_lang: "en",
        target_lang: "zh",
      });

      expect(result).toBeValidErrorResponse();
    });

    it("should use proxy when provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          translations: [{ text: "你好世界", detected_source_language: "zh" }],
        })
      );

      await query(
        {
          text: "Hello world",
          source_lang: "en",
          target_lang: "zh",
        },
        {
          proxyEndpoint: "https://custom-proxy.com/api",
        }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom-proxy.com/api",
        expect.any(Object)
      );
    });
  });
});
