/**
 * Runtime resolution of the DeepL iOS app version advertised to oneshot.
 *
 * DeepL answers every oneshot request with 429 once the advertised app version
 * goes stale (OwO-Network/DLX issue #236), so the version cannot live only in
 * the build. It is read once a day from Apple's key-less lookup API and cached
 * in the isolate. Failures fall back to the last resolved version — or to the
 * pinned constant when nothing was ever resolved — and are retried only after
 * APP_VERSION_RETRY_BACKOFF, so an unreachable App Store cannot delay every
 * translation.
 *
 * Ported from OwO-Network/DLX translate/appversion.go.
 */

import {
  APP_STORE_BUNDLE_ID,
  APP_STORE_LOOKUP_URL,
  APP_STORE_SELLER,
  APP_STORE_TRACK_ID,
  APP_VERSION_CACHE_TTL,
  APP_VERSION_LOOKUP_TIMEOUT,
  APP_VERSION_RETRY_BACKOFF,
  IOS_APP_VERSION_FALLBACK,
} from "./const";

/**
 * Isolate-lifetime cache. Workers reuse an isolate across requests, so this
 * behaves like a process-wide cache.
 */
const state = {
  version: null as string | null,
  fetchedAt: 0,
  attemptedAt: 0,
};

/**
 * Resolve the DeepL iOS marketing version to advertise in both the User-Agent
 * and app_information. Never throws.
 */
export async function resolveDeepLAppVersion(): Promise<string> {
  const now = Date.now();

  if (state.version && now - state.fetchedAt < APP_VERSION_CACHE_TTL) {
    return state.version;
  }

  if (state.attemptedAt && now - state.attemptedAt < APP_VERSION_RETRY_BACKOFF) {
    return state.version ?? IOS_APP_VERSION_FALLBACK;
  }

  state.attemptedAt = now;

  try {
    const version = await fetchLatestVersion();
    state.version = version;
    state.fetchedAt = now;
    return version;
  } catch (error) {
    const fallback = state.version ?? IOS_APP_VERSION_FALLBACK;
    console.warn(
      "DeepL iOS app version lookup failed; advertising",
      fallback,
      error instanceof Error ? error.message : String(error)
    );
    return fallback;
  }
}

/**
 * Force the next resolution to re-read the App Store.
 *
 * Called when DeepL rejects the advertised profile (its outdated-client
 * notice, or a 403): the version is the usual reason, so the next request
 * should try the current release instead of waiting out the 24h cache. The
 * last resolved version is kept, so a failed refetch still degrades to it.
 */
export function invalidateDeepLAppVersion(): void {
  state.fetchedAt = 0;
  state.attemptedAt = 0;
}

/**
 * Query Apple's lookup API for the DeepL iOS app and return its marketing
 * version. Throws on any failure; the caller decides what to fall back to.
 */
async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_VERSION_LOOKUP_TIMEOUT);

  try {
    const response = await fetch(APP_STORE_LOOKUP_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`App Store lookup failed with status ${response.status}`);
    }

    const lookup: unknown = await response.json();
    const version = deepLVersion(lookup);

    if (!version) {
      throw new Error("App Store lookup did not return the DeepL iOS app");
    }

    return version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accept only a result that really is the DeepL iOS app with a plausible
 * dotted-numeric version, so a changed or hijacked lookup cannot poison the
 * client profile.
 */
function deepLVersion(lookup: unknown): string | null {
  if (!lookup || typeof lookup !== "object" || !("results" in lookup)) {
    return null;
  }

  const results = lookup.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const result: unknown = results[0];
  if (!result || typeof result !== "object") return null;

  if (!("trackId" in result) || result.trackId !== APP_STORE_TRACK_ID) {
    return null;
  }
  if (!("bundleId" in result) || result.bundleId !== APP_STORE_BUNDLE_ID) {
    return null;
  }
  if (!("artistName" in result) || result.artistName !== APP_STORE_SELLER) {
    return null;
  }

  const version = "version" in result ? result.version : undefined;
  return typeof version === "string" && /^\d+(\.\d+){1,3}$/.test(version)
    ? version
    : null;
}
