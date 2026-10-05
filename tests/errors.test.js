import { describe, it, expect, vi } from "vitest";
import worker, { translateUpstreamError, normalizeUpstreamError, errorResponse } from "../src/index.js";

const VALID_REQ = {
  state: "test state",
  model: "clef",
  questions: {
    urgent: { type: "noul", instructions: "urgent?" }
  }
};

describe("Error translation - Envelope structure", () => {
  it("always returns all 4 error properties, application/json, and no-store", () => {
    const res = errorResponse(422, "invalid_request_error", "test_code", "test message", "field.name");
    expect(res.status).toBe(422);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // Check JSON body
    return res.json().then(body => {
      expect(body).toEqual({
        error: {
          type: "invalid_request_error",
          code: "test_code",
          message: "test message",
          param: "field.name"
        }
      });
    });
  });

  it("sets param to null for non-validation errors", () => {
    const res = errorResponse(502, "api_error", "upstream_error", "failed", null);
    return res.json().then(body => {
      expect(body.error.param).toBeNull();
    });
  });
});

describe("Error normalization helper", () => {
  it("normalizes string errors", () => {
    const n = normalizeUpstreamError("Something failed");
    expect(n.message).toBe("Something failed");
    expect(n.internalCode).toBeNull();
    expect(n.httpStatus).toBeNull();
  });

  it("normalizes Error objects and extracts nested cause properties", () => {
    const err = new Error("Top error");
    err.cause = { code: 3040, status: 429, retryAfter: 30 };
    const n = normalizeUpstreamError(err);
    expect(n.message).toBe("Top error");
    expect(n.internalCode).toBe(3040);
    expect(n.httpStatus).toBe(429);
    expect(n.retryAfter).toBe("30");
  });

  it("extracts Retry-After from Headers instance", () => {
    const headers = new Headers();
    headers.set("retry-after", "120");
    const err = { message: "Rate limit", headers };
    const n = normalizeUpstreamError(err);
    expect(n.retryAfter).toBe("120");
  });
});

describe("Upstream Error Translation - Status and Codes", () => {
  it("translates internal code 3040 to 529 overloaded_error", async () => {
    const err = { code: 3040, message: "Workers AI service is overloaded" };
    const res = translateUpstreamError(err);
    expect(res.status).toBe(529);
    const body = await res.json();
    expect(body.error).toEqual({
      type: "overloaded_error",
      code: "overloaded",
      message: "Workers AI service is overloaded",
      param: null
    });
  });

  it("translates HTTP 529 and capacity-related 503 to 529 overloaded_error", async () => {
    const err529 = { status: 529, message: "Service Overloaded" };
    const res529 = translateUpstreamError(err529);
    expect(res529.status).toBe(529);
    const body529 = await res529.json();
    expect(body529.error.type).toBe("overloaded_error");

    const err503Capacity = { status: 503, message: "No capacity available in region" };
    const res503 = translateUpstreamError(err503Capacity);
    expect(res503.status).toBe(529);
    const body503 = await res503.json();
    expect(body503.error.type).toBe("overloaded_error");
  });

  it("translates internal code 3036 and HTTP 429 to 429 rate_limit_error", async () => {
    const err3036 = { code: 3036, message: "Hourly quota exceeded" };
    const res3036 = translateUpstreamError(err3036);
    expect(res3036.status).toBe(429);
    const body3036 = await res3036.json();
    expect(body3036.error).toEqual({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "Hourly quota exceeded",
      param: null
    });

    const err429 = { status: 429, message: "Too Many Requests" };
    const res429 = translateUpstreamError(err429);
    expect(res429.status).toBe(429);
    const body429 = await res429.json();
    expect(body429.error.type).toBe("rate_limit_error");
  });

  it("forwards Retry-After header on 429 and 529 when provided by upstream", async () => {
    const err429WithRetry = {
      code: 3036,
      message: "Rate limited",
      retryAfter: "45"
    };
    const res = translateUpstreamError(err429WithRetry);
    expect(res.headers.get("Retry-After")).toBe("45");

    const err529WithRetry = {
      code: 3040,
      message: "Overloaded",
      retryAfter: "60"
    };
    const res529 = translateUpstreamError(err529WithRetry);
    expect(res529.headers.get("Retry-After")).toBe("60");
  });

  it("translates upstream input validation failures (5004 -> images, 3006 -> body) to 422", async () => {
    const err5004 = { code: 5004, message: "Malformed image data" };
    const res5004 = translateUpstreamError(err5004);
    expect(res5004.status).toBe(422);
    const body5004 = await res5004.json();
    expect(body5004.error.code).toBe("invalid_field");
    expect(body5004.error.param).toBe("images");

    const err3006 = { code: 3006, message: "Payload too large for model" };
    const res3006 = translateUpstreamError(err3006);
    expect(res3006.status).toBe(422);
    const body3006 = await res3006.json();
    expect(body3006.error.code).toBe("request_too_large");
    expect(body3006.error.param).toBe("body");
  });

  it("maps unrecognized upstream errors, string throws, and provider issues to 502 api_error upstream_error", async () => {
    const unknownErrors = [
      new Error("Database connection lost"),
      "Plain string failure message",
      { code: 1000, message: "Internal Cloudflare error" },
      { status: 500, message: "Internal Server Error" }
    ];

    for (const err of unknownErrors) {
      const res = translateUpstreamError(err);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.type).toBe("api_error");
      expect(body.error.code).toBe("upstream_error");
      expect(body.error.param).toBeNull();
    }
  });

  it("does not convert upstream 401 or model-not-found into client 401 or 422", async () => {
    // Upstream binding auth failure is a provider problem, NOT client invalid_api_key
    const upstreamAuthFail = { status: 401, message: "Unauthorized account access to Workers AI" };
    const resAuth = translateUpstreamError(upstreamAuthFail);
    expect(resAuth.status).toBe(502);
    const bodyAuth = await resAuth.json();
    expect(bodyAuth.error.code).toBe("upstream_error");

    // Upstream missing model is a provider problem, NOT client invalid_model
    const upstreamModelNotFound = { status: 404, message: "Model @cf/cloudflare/clef not found" };
    const resModel = translateUpstreamError(upstreamModelNotFound);
    expect(resModel.status).toBe(502);
    const bodyModel = await resModel.json();
    expect(bodyModel.error.code).toBe("upstream_error");
  });

  it("translates errors during worker.fetch execution", async () => {
    const env = {
      CLEF_TOKEN: "valid-token",
      AI: {
        run: vi.fn().mockRejectedValue({ code: 3040, message: "Server busy" })
      }
    };

    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(VALID_REQ)
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(529);
    const body = await res.json();
    expect(body.error.type).toBe("overloaded_error");
    expect(body.error.code).toBe("overloaded");
  });
});
