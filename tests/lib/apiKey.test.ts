/**
 * Tests for the bearer-token gate in front of every endpoint.
 */

import { rejectUnauthorized } from "../../src/lib/apiKey";

/**
 * Build a minimal context carrying only what the gate reads. The response
 * stand-in exposes the status the gate chose.
 */
function context(
  apiKeys: string | undefined,
  headers: Record<string, string> = {}
) {
  const json = jest.fn(
    (_body: unknown, status: number) => ({ status }) as unknown as Response
  );

  return {
    json,
    ctx: {
      // Only the one field the gate reads is needed.
      env: { API_KEYS: apiKeys } as unknown as Env,
      req: {
        raw: new Request("https://example.com/deepl", {
          method: "POST",
          headers,
        }),
      },
      json,
    },
  };
}

describe("rejectUnauthorized", () => {
  it("should fail closed with 503 when no keys are configured", () => {
    const { ctx, json } = context(undefined);

    expect(rejectUnauthorized(ctx)).not.toBeNull();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 503 }), 503);
  });

  it("should fail closed when the key list is only whitespace", () => {
    const { ctx, json } = context(" , ");

    expect(rejectUnauthorized(ctx)).not.toBeNull();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 503 }), 503);
  });

  it("should reject a request without a key with 401", () => {
    const { ctx, json } = context("alpha,beta");

    expect(rejectUnauthorized(ctx)).not.toBeNull();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 401 }), 401);
  });

  it("should reject a wrong key with 403", () => {
    const { ctx, json } = context("alpha,beta", {
      Authorization: "Bearer gamma",
    });

    expect(rejectUnauthorized(ctx)).not.toBeNull();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 403 }), 403);
  });

  it("should accept a configured bearer key", () => {
    const { ctx } = context("alpha,beta", {
      Authorization: "Bearer beta",
    });

    expect(rejectUnauthorized(ctx)).toBeNull();
  });

  it("should accept a configured X-API-Key header", () => {
    const { ctx } = context("alpha,beta", { "X-API-Key": "alpha" });

    expect(rejectUnauthorized(ctx)).toBeNull();
  });
});
