/**
 * Tests for the runtime DeepL iOS app version resolver.
 *
 * Each test loads a fresh module instance (jest.resetModules) so the
 * isolate-lifetime cache does not leak between cases.
 */

const LOOKUP_URL = "https://itunes.apple.com/lookup?id=1552407475&country=us";

function appStoreResponse(overrides: Record<string, unknown> = {}) {
  return {
    resultCount: 1,
    results: [
      {
        trackId: 1552407475,
        bundleId: "com.linguee.DeepLMobileTranslator",
        artistName: "DeepL SE",
        version: "26.60",
        ...overrides,
      },
    ],
  };
}

/**
 * Minimal fetch Response stand-in carrying only what the resolver reads.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function loadProvider() {
  jest.resetModules();
  return import("../../src/lib/appVersion");
}

describe("resolveDeepLAppVersion", () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    // The resolver warns on every fallback; keep test output clean.
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("should return the version published on the App Store", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(appStoreResponse()));

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.60");
    expect(mockFetch).toHaveBeenCalledWith(LOOKUP_URL, expect.any(Object));
  });

  it("should cache the resolved version for later requests", async () => {
    mockFetch.mockResolvedValue(jsonResponse(appStoreResponse()));

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.60");
    await expect(resolveDeepLAppVersion()).resolves.toBe("26.60");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should refetch after the version is invalidated", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(appStoreResponse({ version: "26.60" }))
      )
      .mockResolvedValueOnce(
        jsonResponse(appStoreResponse({ version: "26.61" }))
      );

    const { resolveDeepLAppVersion, invalidateDeepLAppVersion } =
      await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.60");
    invalidateDeepLAppVersion();
    await expect(resolveDeepLAppVersion()).resolves.toBe("26.61");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should fall back to the pinned version when the lookup fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.52");
  });

  it("should reject a lookup that is not the DeepL iOS app", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(appStoreResponse({ bundleId: "com.example.other" }))
    );

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.52");
  });

  it("should reject an implausible version string", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(appStoreResponse({ version: "latest" }))
    );

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.52");
  });

  it("should not retry a failed lookup immediately", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const { resolveDeepLAppVersion } = await loadProvider();

    await expect(resolveDeepLAppVersion()).resolves.toBe("26.52");
    await expect(resolveDeepLAppVersion()).resolves.toBe("26.52");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
