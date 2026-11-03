/**
 * Core translation query functionality for DeepLX API
 *
 * Speaks DeepL's free "oneshot" endpoint — the stateless REST call the official
 * iOS app uses for anonymous traffic — instead of the legacy LMT_handle_texts
 * JSON-RPC backend, which DeepL now answers with an "older version of DeepL"
 * notice instead of a translation (see const.ts).
 */

import { DEFAULT_RETRY_CONFIG, PAYLOAD_LIMITS, REQUEST_TIMEOUT } from "./config";
import {
  API_URL,
  IOS_APP_BUILD,
  IOS_APP_VERSION_FALLBACK,
  IOS_CFNETWORK_VERSION,
  IOS_DARWIN_VERSION,
  IOS_OS_VERSION,
  MAX_FREE_TEXT_LENGTH,
} from "./const";
import { resolveDeepLAppVersion } from "./appVersion";
import { createErrorResponse } from "./errorHandler";
import { selectProxy } from "./proxyManager";
import { checkCombinedRateLimit } from "./rateLimit";
import { isRetryableError, RetryOptions, retryWithBackoff } from "./retryLogic";
import {
  Config,
  createStandardResponse,
  OneshotResponseParams,
  RequestParams,
  ResponseParams,
} from "./types";

/**
 * Stable identifiers the iOS client sends with every request: one for the
 * install, one for the session. They live for the isolate's lifetime — a
 * rotating id per request is a stronger bot signal than reusing one.
 *
 * Created lazily: the Workers runtime forbids generating random values in
 * global scope, so they are seeded on first use inside a request handler.
 */
let instanceId: string | undefined;
let sessionId: string | undefined;

function getClientIds(): { instanceId: string; sessionId: string } {
  if (!instanceId) instanceId = crypto.randomUUID();
  if (!sessionId) sessionId = crypto.randomUUID();
  return { instanceId, sessionId };
}

/**
 * oneshot expects lowercase BCP-47-ish codes ("de", "en-US", "zh-Hans").
 *
 * EN and PT are no longer valid bare targets — DeepL deprecated them in favour
 * of the regional forms — so they resolve to the default region the DeepL apps
 * themselves use. Ported from OwO-Network/DLX translate.go.
 */
const TARGET_LANG_MAP: Record<string, string> = {
  AR: "ar",
  BG: "bg",
  CS: "cs",
  DA: "da",
  DE: "de",
  "DE-CH": "de-CH",
  EL: "el",
  "EN-GB": "en-GB",
  "EN-US": "en-US",
  ES: "es",
  "ES-419": "es-419",
  ET: "et",
  FI: "fi",
  FR: "fr",
  "FR-CA": "fr-CA",
  HE: "he",
  HU: "hu",
  ID: "id",
  IT: "it",
  JA: "ja",
  KO: "ko",
  LT: "lt",
  LV: "lv",
  NB: "nb",
  NL: "nl",
  PL: "pl",
  "PT-BR": "pt-BR",
  "PT-PT": "pt-PT",
  RO: "ro",
  RU: "ru",
  SK: "sk",
  SL: "sl",
  SV: "sv",
  TR: "tr",
  UK: "uk",
  VI: "vi",
  ZH: "zh-Hans",
  "ZH-HANS": "zh-Hans",
  "ZH-HANT": "zh-Hant",
  // Convenience aliases for legacy callers.
  EN: "en-US",
  PT: "pt-BR",
};

/**
 * Source codes are the generic language forms. The script variants
 * (zh-Hans/zh-Hant) are target-only: sent as a source hint they suppress
 * language detection for mixed-script text.
 */
const SOURCE_LANG_MAP: Record<string, string> = {
  ...TARGET_LANG_MAP,
  EN: "en",
  PT: "pt",
  ZH: "zh",
  "ZH-HANS": "zh",
  "ZH-HANT": "zh",
};

/**
 * Build an Error carrying an HTTP status, which createErrorResponse and
 * isRetryableError both understand.
 */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Normalize language code to ensure compatibility with DeepL API
 * Accepts both lowercase and uppercase input, always returns uppercase
 * @param langCode - Language code to normalize
 * @returns Normalized language code in uppercase format for DeepL API
 * @private
 */
function normalizeLanguageCode(langCode: string): string {
  if (!langCode || langCode.toLowerCase() === "auto") {
    return "auto";
  }

  const normalized = langCode.toLowerCase();

  // Map common language variations to DeepL-supported codes
  const languageMap: Record<string, string> = {
    chinese: "ZH",
    english: "EN",
    spanish: "ES",
    french: "FR",
    german: "DE",
    italian: "IT",
    japanese: "JA",
    portuguese: "PT",
    russian: "RU",
    dutch: "NL",
    polish: "PL",
    swedish: "SV",
    danish: "DA",
    norwegian: "NB",
    finnish: "FI",
    czech: "CS",
    slovak: "SK",
    slovenian: "SL",
    estonian: "ET",
    latvian: "LV",
    lithuanian: "LT",
    hungarian: "HU",
    romanian: "RO",
    bulgarian: "BG",
    greek: "EL",
    turkish: "TR",
    ukrainian: "UK",
    korean: "KO",
    indonesian: "ID",
  };

  // Check if it's a mapped language name
  if (languageMap[normalized]) {
    return languageMap[normalized];
  }

  // Convert to uppercase for DeepL API
  return normalized.toUpperCase();
}

/**
 * Resolve a user-supplied target language to the code oneshot expects.
 * Throws a 400-mapped error for codes DeepL does not translate into.
 */
function resolveTargetLang(code: string): string {
  const resolved = TARGET_LANG_MAP[(code || "").trim().toUpperCase()];
  if (!resolved) {
    throw httpError(400, `Unsupported target_lang "${code}"`);
  }
  return resolved;
}

/**
 * Resolve a user-supplied source language to the code oneshot expects.
 * Returns null for "auto" (and empty), which omits source_lang and lets the
 * server detect the language.
 */
function resolveSourceLang(code: string): string | null {
  const normalized = (code || "").trim();
  if (!normalized || normalized.toLowerCase() === "auto") {
    return null;
  }

  const resolved = SOURCE_LANG_MAP[normalized.toUpperCase()];
  if (!resolved) {
    throw httpError(400, `Unsupported source_lang "${code}"`);
  }
  return resolved;
}

/**
 * Build the oneshot request body.
 *
 * `appVersion` is injected so the caller can resolve the current App Store
 * release once per request and keep the User-Agent and app_information
 * consistent. It defaults to the pinned fallback for callers that only want
 * the shape (the debug endpoint).
 * @param data Request parameters containing text and languages
 * @param appVersion Advertised DeepL iOS version
 * @returns JSON string ready for API submission
 * @private
 */
function buildRequestBody(
  data: RequestParams,
  appVersion: string = IOS_APP_VERSION_FALLBACK
): string {
  // Validate input parameters
  if (!data || !data.text || typeof data.text !== "string") {
    throw httpError(
      400,
      "Invalid request parameters: text is required and must be a string"
    );
  }

  // Ensure text is not empty
  if (!data.text.trim()) {
    throw httpError(400, "Invalid request parameters: text cannot be empty");
  }

  // Apply conservative text length limits to prevent 413 errors
  const maxTextLength = PAYLOAD_LIMITS.MAX_TEXT_LENGTH;
  if (data.text.length > maxTextLength) {
    throw httpError(
      413,
      `Text too long. Maximum length is ${maxTextLength} characters to prevent payload size errors.`
    );
  }

  // Anonymous oneshot counts UTF-16 code units (String.length), and rejects
  // larger requests upstream — fail here with a precise number instead.
  if (data.text.length > MAX_FREE_TEXT_LENGTH) {
    throw httpError(
      413,
      `Text too long for DeepL's free endpoint: ${data.text.length} characters (limit is ${MAX_FREE_TEXT_LENGTH}).`
    );
  }

  const targetLang = resolveTargetLang(data.target_lang || "en");
  const sourceLang = resolveSourceLang(data.source_lang || "auto");
  const clientIds = getClientIds();

  const body: Record<string, unknown> = {
    text: [data.text],
    target_lang: targetLang,
    // Empty source = autodetect, so the field is omitted entirely.
    ...(sourceLang ? { source_lang: sourceLang } : {}),
    usage_type: "translate",
    app_information: {
      os: "iOS",
      os_version: IOS_OS_VERSION,
      app_version: appVersion,
      app_build: IOS_APP_BUILD,
      instance_id: clientIds.instanceId,
    },
  };

  const payloadSize = new TextEncoder().encode(JSON.stringify(body)).length;
  if (payloadSize > PAYLOAD_LIMITS.MAX_REQUEST_SIZE) {
    throw httpError(
      413,
      `Request payload too large (${payloadSize} bytes). Maximum allowed is ${PAYLOAD_LIMITS.MAX_REQUEST_SIZE} bytes. Please reduce text length.`
    );
  }

  return JSON.stringify(body);
}

/**
 * Validate an external JSON body as a oneshot translation response.
 */
function isOneshotResponse(value: unknown): value is OneshotResponseParams {
  if (!value || typeof value !== "object" || !("translations" in value)) {
    return false;
  }

  const translations = value.translations;
  if (!Array.isArray(translations)) return false;

  return translations.every(
    (translation: unknown) =>
      !!translation &&
      typeof translation === "object" &&
      "text" in translation &&
      typeof translation.text === "string"
  );
}

/**
 * Read the human-readable reason from a 403 body. DeepL collapses
 * "authentication failed", "outdated client" and "user blocked" into this
 * status; the title or message is the only way to tell them apart.
 */
async function forbiddenMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      if ("title" in body && typeof body.title === "string" && body.title) {
        return body.title;
      }
      if (
        "message" in body &&
        typeof body.message === "string" &&
        body.message
      ) {
        return body.message;
      }
    }
  } catch {
    // Fall through to the generic message.
  }

  return "request forbidden by DeepL (authentication failed, outdated client, or blocked)";
}

/**
 * Main translation query function
 * Handles the complete translation workflow with retry logic, rate limiting, and error handling
 * @param params Translation request parameters (text, source language, target language)
 * @param config Optional configuration including proxy settings and environment
 * @returns Promise<ResponseParams> - Standardized response with translation result
 */
async function query(
  params: RequestParams,
  config?: Config & { env?: Env }
): Promise<ResponseParams> {
  if (!params?.text) {
    return createStandardResponse(
      400,
      null,
      undefined,
      normalizeLanguageCode(params?.source_lang || "auto"),
      normalizeLanguageCode(params?.target_lang || "en")
    );
  }

  const retryOptions: RetryOptions = {
    ...DEFAULT_RETRY_CONFIG,
    isRetryable: isRetryableError,
  };

  try {
    // Resolved once per request so the User-Agent and body agree; the lookup
    // itself is cached for a day in the isolate (appVersion.ts).
    const appVersion = await resolveDeepLAppVersion();
    const requestBody = buildRequestBody(params, appVersion);

    return await retryWithBackoff(async () => {
      const proxy = config?.env ? await selectProxy(config.env) : null;
      const endpoint = config?.proxyEndpoint ?? proxy?.url ?? API_URL;

      // Use comprehensive rate limit check - includes client and proxy backend limits
      if (config?.env) {
        const clientIP = config?.clientIP || "unknown";
        const rateLimitResult = await checkCombinedRateLimit(
          clientIP,
          endpoint,
          config.env
        );
        if (!rateLimitResult.allowed) {
          throw httpError(
            429,
            rateLimitResult.reason || "Rate limit exceeded"
          );
        }
      }

      const makeRequest = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
          const clientIds = getClientIds();
          const response = await fetch(endpoint, {
            headers: {
              "Content-Type": "application/json",
              // LoginNone: the literal string is what the iOS client sends for
              // anonymous traffic; omitting the header selects a different
              // server-side auth branch.
              Authorization: "None",
              "User-Agent": `DeepL/${appVersion} CFNetwork/${IOS_CFNETWORK_VERSION} Darwin/${IOS_DARWIN_VERSION}`,
              "x-app-os-version": IOS_OS_VERSION,
              "x-app-instance-id": clientIds.instanceId,
              "x-app-session-id": clientIds.sessionId,
              Accept: "*/*",
              "Accept-Language": "en-US,en;q=0.9",
              ...config?.customHeader,
            },
            method: "POST",
            body: requestBody,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          // 429 means the IP (or the advertised profile) is temporarily
          // blocked upstream; surface it as a retryable rate-limit error.
          if (response.status === 429) {
            throw httpError(
              429,
              "Too many requests, your IP has been blocked by DeepL temporarily, please don't request it frequently in a short time"
            );
          }

          // 403 is DeepL refusing the client profile itself (auth failed,
          // outdated client, or blocked) — not worth retrying blindly.
          if (response.status === 403) {
            throw httpError(403, await forbiddenMessage(response));
          }

          if (!response.ok) {
            throw httpError(
              response.status,
              `Request failed with status code: ${response.status}`
            );
          }

          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          if (error instanceof Error && error.name === "AbortError") {
            throw httpError(
              408,
              `Request timeout after ${
                REQUEST_TIMEOUT / 1000
              } seconds to ${endpoint}`
            );
          }
          throw error;
        }
      };

      const response = await makeRequest();

      let result: unknown;
      try {
        result = await response.json();
      } catch (parseError) {
        throw httpError(
          502,
          `Failed to parse JSON response from ${endpoint}: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }`
        );
      }

      if (!isOneshotResponse(result)) {
        throw httpError(502, "Invalid response structure from DeepL API");
      }

      const translation = result.translations[0];
      if (!translation?.text) {
        throw httpError(502, "Invalid response structure from DeepL API");
      }

      return createStandardResponse(
        200,
        translation.text,
        // oneshot has no request id of its own; milliseconds keep responses
        // k-sortable like the old JSON-RPC ids were.
        Date.now(),
        (
          translation.detected_source_language ||
          normalizeLanguageCode(params.source_lang || "auto")
        ).toUpperCase(),
        normalizeLanguageCode(params.target_lang || "en")
      );
    }, retryOptions);
  } catch (error) {
    const errorDetails = createErrorResponse(error, {
      endpoint: config?.proxyEndpoint,
    });

    return createStandardResponse(
      errorDetails.httpStatus,
      null,
      undefined,
      normalizeLanguageCode(params.source_lang || "auto"),
      normalizeLanguageCode(params.target_lang || "en")
    );
  }
}

export { buildRequestBody, normalizeLanguageCode, query };
