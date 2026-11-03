/**
 * App constants for DeepLX translation service
 * Contains API endpoints, language definitions, and other immutable values
 */

/**
 * DeepL's free "oneshot" translate endpoint — the stateless REST call the
 * official iOS app, the Chrome extension and deepl.com use for anonymous
 * traffic.
 *
 * Not the legacy JSON-RPC backend (www2.deepl.com/jsonrpc, LMT_handle_texts):
 * DeepL now answers that with its "older version of DeepL" notice (HTTP 200,
 * translation-shaped body) instead of a translation. OwO-Network/DLX migrated
 * to oneshot for the same reason (DLX PR #217).
 */
export const API_URL = "https://oneshot-free.www.deepl.com/v1/translate";

/**
 * iOS client profile advertised to oneshot.
 *
 * oneshot expects the story of a real DeepL iOS client: a matching
 * User-Agent, the x-app-* headers and app_information in the body. DeepL
 * rate-limits clients whose profile is inconsistent (for example a stale app
 * version), so the version is resolved at runtime from the App Store — see
 * appVersion.ts. The constants below are the fallback and the fixed fields.
 */
export const IOS_APP_VERSION_FALLBACK = "26.52";
export const IOS_APP_BUILD = "5443737";
export const IOS_OS_VERSION = "26.0";
export const IOS_CFNETWORK_VERSION = "3826.600.41";
export const IOS_DARWIN_VERSION = "25.0.0";

/**
 * Apple's key-less lookup for the current DeepL iOS release.
 *
 * A pinned version goes stale whenever DeepL ships an app update, and oneshot
 * then answers every request with 429 (OwO-Network/DLX issue #236). Resolving
 * it from the App Store keeps the advertised profile coherent without a
 * rebuild.
 */
export const APP_STORE_TRACK_ID = 1552407475;
export const APP_STORE_BUNDLE_ID = "com.linguee.DeepLMobileTranslator";
export const APP_STORE_SELLER = "DeepL SE";
export const APP_STORE_LOOKUP_URL = `https://itunes.apple.com/lookup?id=${APP_STORE_TRACK_ID}&country=us`;
export const APP_VERSION_CACHE_TTL = 24 * 60 * 60 * 1000;
export const APP_VERSION_RETRY_BACKOFF = 15 * 60 * 1000;
export const APP_VERSION_LOOKUP_TIMEOUT = 3000;

/**
 * Anonymous oneshot limit: 1500 UTF-16 code units across the text array.
 * JavaScript's String.length reports exactly that unit, so the cap can be
 * enforced with a plain length comparison.
 */
export const MAX_FREE_TEXT_LENGTH = 1500;

/**
 * DeepL Write session endpoint.
 *
 * Not the documented /v2/write/rephrase API, which needs a Pro key: this is
 * the free backend the deepl.com/write app itself uses. A session is opened
 * here, then driven over a WebSocket on the same host.
 */
export const REPHRASE_SESSION_URL =
  "https://ita-free.www.deepl.com/v2/startSession";

/**
 * Origin the free Write backend expects. It refuses requests that do not look
 * like they came from the web app.
 */
export const REPHRASE_SOCKET_ORIGIN = "https://www.deepl.com";

/**
 * Target languages the free Write backend advertises when a session opens.
 * Far narrower than the translation language set, so it is checked rather
 * than passed through.
 */
export const REPHRASE_TARGET_LANGS = [
  "de",
  "en-GB",
  "en-US",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "pt-BR",
  "pt-PT",
  "zh-Hans",
] as const;
