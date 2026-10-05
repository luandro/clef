import { describe, it, expect, vi } from "vitest";
import worker, { MAX_BODY_BYTES, authenticate } from "../src/index.js";
import fs from "node:fs";

const clefReqFixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/clef-req.json", import.meta.url), "utf-8")
);
const clefRespFixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/clef-resp.json", import.meta.url), "utf-8")
);

const TEST_SECRET = "correct-clef-test-token-value-12345";

function createEnv(overrides = {}) {
  return {
    CLEF_TOKEN: TEST_SECRET,
    AI: {
      run: vi.fn().mockResolvedValue(clefRespFixture)
    },
    ...overrides
  };
}

function authedHeaders(token = TEST_SECRET, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra
  };
}

describe("Worker - Authentication", () => {
  it("allows unauthenticated GET /healthz without invoking AI", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/healthz", { method: "GET" });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("fails closed on missing, malformed, or incorrect Bearer token", async () => {
    const env = createEnv();
    const testCases = [
      {}, // missing Authorization
      { Authorization: "Basic abcde" }, // wrong scheme
      { Authorization: "Bearer " }, // empty token
      { Authorization: "Bearer wrong-token" }, // wrong token
      { Authorization: "Token valid-token" } // unsupported scheme
    ];

    for (const headers of testCases) {
      const req = new Request("https://clef.example/v1/systemone", {
        method: "POST",
        headers,
        body: JSON.stringify(clefReqFixture)
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const err = await res.json();
      expect(err).toEqual({
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "Missing or invalid API key",
          param: null
        }
      });
      expect(env.AI.run).not.toHaveBeenCalled();
    }

    // A3: Auth happens before any body read (request whose body stream throws on read must return 401 without being pulled)
    let streamPulled = false;
    let armed = false;
    const throwingStream = new ReadableStream({
      pull(controller) {
        if (!armed) {
          controller.enqueue(new Uint8Array(1));
        } else {
          streamPulled = true;
          throw new Error("Stream read should not occur before auth");
        }
      }
    });
    const throwingReq = {
      url: "https://clef.example/v1/systemone",
      method: "POST",
      headers: new Headers({
        Authorization: "Bearer invalid-token",
        "Content-Type": "application/json"
      }),
      body: throwingStream
    };
    await new Promise(r => setTimeout(r, 0));
    armed = true;
    const throwingRes = await worker.fetch(throwingReq, env);
    expect(throwingRes.status).toBe(401);
    expect(streamPulled).toBe(false);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("fails closed when env.CLEF_TOKEN is not configured or empty", async () => {
    for (const unconfigured of [undefined, null, ""]) {
      const env = createEnv({ CLEF_TOKEN: unconfigured });
      const req = new Request("https://clef.example/v1/systemone", {
        method: "POST",
        headers: authedHeaders(TEST_SECRET),
        body: JSON.stringify(clefReqFixture)
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
      expect(env.AI.run).not.toHaveBeenCalled();
    }
  });

  it("authenticates successfully with valid Bearer token", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify(clefReqFixture)
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(1);

    // A3: Structural constant-time test: verify crypto.subtle.digest is called once for each side
    const authEnv = { CLEF_TOKEN: TEST_SECRET };
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.fn().mockImplementation(originalDigest);
    const originalSubtle = crypto.subtle;
    const patchedSubtle = new Proxy(originalSubtle, {
      get(target, prop) {
        if (prop === "digest") return digestSpy;
        return Reflect.get(target, prop);
      }
    });
    Object.defineProperty(crypto, "subtle", {
      value: patchedSubtle,
      configurable: true
    });

    try {
      // Token differing in FIRST character: computes SHA-256 for supplied and expected
      const diffFirstToken = "x" + TEST_SECRET.slice(1);
      const reqFirstDiff = new Request("https://clef.example/v1/systemone", {
        headers: { Authorization: `Bearer ${diffFirstToken}` }
      });
      const authFirstDiff = await authenticate(reqFirstDiff, authEnv);
      expect(authFirstDiff).toBe(false);
      expect(digestSpy).toHaveBeenCalledTimes(2);

      digestSpy.mockClear();

      // Token differing in LAST character: computes SHA-256 for supplied and expected
      const diffLastToken = TEST_SECRET.slice(0, -1) + "x";
      const reqLastDiff = new Request("https://clef.example/v1/systemone", {
        headers: { Authorization: `Bearer ${diffLastToken}` }
      });
      const authLastDiff = await authenticate(reqLastDiff, authEnv);
      expect(authLastDiff).toBe(false);
      // Assert call count is identical (two) regardless of where difference is
      expect(digestSpy).toHaveBeenCalledTimes(2);

      digestSpy.mockClear();

      // Matching token: computes SHA-256 for supplied and expected
      const reqMatch = new Request("https://clef.example/v1/systemone", {
        headers: { Authorization: `Bearer ${TEST_SECRET}` }
      });
      const authMatch = await authenticate(reqMatch, authEnv);
      expect(authMatch).toBe(true);
      expect(digestSpy).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(crypto, "subtle", {
        value: originalSubtle,
        configurable: true
      });
    }
  });
});

describe("Worker - Routing and Methods", () => {
  it("serves GET /v1/models with authentication", async () => {
    const env = createEnv();

    // Without auth -> 401
    const unauthedReq = new Request("https://clef.example/v1/models", { method: "GET" });
    const unauthedRes = await worker.fetch(unauthedReq, env);
    expect(unauthedRes.status).toBe(401);

    // With auth -> 200
    const authedReq = new Request("https://clef.example/v1/models", {
      method: "GET",
      headers: authedHeaders()
    });
    const authedRes = await worker.fetch(authedReq, env);
    expect(authedRes.status).toBe(200);
    const body = await authedRes.json();
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(2);
    expect(body.data.map(m => m.name)).toEqual(["clef", "clef-flash"]);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns 405 with Allow header for unsupported methods on known routes", async () => {
    const env = createEnv();

    // POST /healthz with auth -> 405 Allow: GET
    const postHealth = new Request("https://clef.example/healthz", {
      method: "POST",
      headers: authedHeaders()
    });
    const resHealth = await worker.fetch(postHealth, env);
    expect(resHealth.status).toBe(405);
    expect(resHealth.headers.get("Allow")).toBe("GET");

    // POST /v1/models -> 405 Allow: GET
    const postModels = new Request("https://clef.example/v1/models", {
      method: "POST",
      headers: authedHeaders()
    });
    const resModels = await worker.fetch(postModels, env);
    expect(resModels.status).toBe(405);
    expect(resModels.headers.get("Allow")).toBe("GET");

    // GET /v1/systemone -> 405 Allow: POST
    const getEval = new Request("https://clef.example/v1/systemone", {
      method: "GET",
      headers: authedHeaders()
    });
    const resEval = await worker.fetch(getEval, env);
    expect(resEval.status).toBe(405);
    expect(resEval.headers.get("Allow")).toBe("POST");
  });

  it("returns authenticated 404 for unknown paths", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/unknown", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify(clefReqFixture)
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
    const err = await res.json();
    expect(err.error.code).toBe("not_found");
  });

  it("ignores query strings and does not let them select models or alter route matching", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/systemone?model=clef-flash&foo=bar", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ ...clefReqFixture, model: "clef" })
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    // model passed to AI is based on body.model ("clef"), not query param
    expect(env.AI.run).toHaveBeenCalledWith("@cf/cloudflare/clef", expect.objectContaining({ model: "clef" }));
  });
});

describe("Worker - Bounded body reading and 13 MiB limit", () => {
  it("rejects empty body with 422 invalid_json", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders()
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(422);
    const err = await res.json();
    expect(err.error.code).toBe("invalid_json");
    expect(err.error.param).toBe("body");
  });

  it("rejects malformed JSON syntax with 422 invalid_json", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: "{ unquoted_key: 123 "
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(422);
    const err = await res.json();
    expect(err.error.code).toBe("invalid_json");
    expect(err.error.param).toBe("body");
  });

  it("rejects invalid UTF-8 bytes with 422 invalid_json", async () => {
    const env = createEnv();
    // Invalid UTF-8 sequence [0xFF, 0xFF]
    const invalidUtf8 = new Uint8Array([0xff, 0xff]);
    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: invalidUtf8
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(422);
    const err = await res.json();
    expect(err.error.code).toBe("invalid_json");
  });

  it("rejects early when Content-Length exceeds 13 MiB", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(TEST_SECRET, {
        "Content-Length": String(MAX_BODY_BYTES + 1)
      }),
      body: JSON.stringify(clefReqFixture)
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(422);
    const err = await res.json();
    expect(err.error.code).toBe("request_too_large");
    expect(err.error.param).toBe("body");
    expect(env.AI.run).not.toHaveBeenCalled();

    // A2: Byte counting uses actual stream bytes, not Content-Length when they disagree (Content-Length lies small, body bigger -> reject)
    const lyingStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {}
    });
    const lyingReq = {
      url: "https://clef.example/v1/systemone",
      method: "POST",
      headers: new Headers({
        Authorization: `Bearer ${TEST_SECRET}`,
        "Content-Type": "application/json",
        "Content-Length": "100" // Lies small
      }),
      body: lyingStream
    };
    const lyingRes = await worker.fetch(lyingReq, env);
    expect(lyingRes.status).toBe(422);
    const lyingErr = await lyingRes.json();
    expect(lyingErr.error.code).toBe("request_too_large");
    expect(lyingErr.error.param).toBe("body");

    // A2: Literal boundary assertions: 13,631,488 bytes accepted, 13,631,489 bytes rejected
    const baseObj = {
      model: "clef",
      state: "",
      questions: { q: { type: "noul", instructions: "ok" } }
    };
    const baseLength = new TextEncoder().encode(JSON.stringify(baseObj)).byteLength;
    const deficit = 13631488 - baseLength;
    baseObj.state = "a".repeat(deficit);
    const exact13MiBBody = JSON.stringify(baseObj);
    expect(new TextEncoder().encode(exact13MiBBody).byteLength).toBe(13631488);

    const exactReq = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: exact13MiBBody
    });
    const exactRes = await worker.fetch(exactReq, env);
    expect(exactRes.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalled();

    // 13,631,489 bytes rejected
    const over13MiBBody = exact13MiBBody + " ";
    expect(new TextEncoder().encode(over13MiBBody).byteLength).toBe(13631489);

    const overReq = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: over13MiBBody
    });
    const overRes = await worker.fetch(overReq, env);
    expect(overRes.status).toBe(422);
    const overErr = await overRes.json();
    expect(overErr.error.code).toBe("request_too_large");
    expect(overErr.error.param).toBe("body");
  });

  it("enforces stream byte limit and cancels reader when stream exceeds 13 MiB without Content-Length", async () => {
    const env = createEnv();
    let readerCancelled = false;

    // Create an unbounded stream that emits 1 MiB chunks on every pull without closing
    const chunkSize = 1024 * 1024;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(chunkSize));
      },
      cancel() {
        readerCancelled = true;
      }
    });

    const req = {
      url: "https://clef.example/v1/systemone",
      method: "POST",
      headers: new Headers({
        Authorization: `Bearer ${TEST_SECRET}`,
        "Content-Type": "application/json"
      }),
      body: stream
    };

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(422);
    const err = await res.json();
    expect(err.error.code).toBe("request_too_large");
    expect(err.error.param).toBe("body");
    expect(readerCancelled).toBe(true);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe("Worker - Upstream Invocation, Passthrough, and Path Pinning", () => {
  it("invokes env.AI.run exactly once with rewritten body.model and returns upstream JSON verbatim", async () => {
    const env = createEnv();
    const inputReq = {
      ...clefReqFixture,
      model: "jev-latest",
      custom_field: "forwarded-verbatim"
    };

    const req = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify(inputReq)
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    // Verify AI.run was called with @cf/cloudflare/clef and body.model rewritten to 'clef'
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [calledModel, calledBody] = env.AI.run.mock.calls[0];
    expect(calledModel).toBe("@cf/cloudflare/clef");
    expect(calledBody.model).toBe("clef");
    expect(calledBody.state).toBe(inputReq.state);
    expect(calledBody.custom_field).toBe("forwarded-verbatim");

    // Original input should not be mutated
    expect(inputReq.model).toBe("jev-latest");

    // Response body matches fixture verbatim (including output_tokens: 0)
    const resJson = await res.json();
    expect(resJson).toEqual(clefRespFixture);
    expect(resJson.usage.output_tokens).toBe(0);
  });

  it("routes /clef/v1/systemone to @cf/cloudflare/clef overriding body.model", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/clef/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ ...clefReqFixture, model: "clef-flash" })
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/cloudflare/clef",
      expect.objectContaining({ model: "clef" })
    );
  });

  it("routes /clef-flash/v1/systemone to @cf/cloudflare/clef-flash overriding body.model", async () => {
    const env = createEnv();
    const req = new Request("https://clef.example/clef-flash/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ ...clefReqFixture, model: "jev-latest" })
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledWith(
      "@cf/cloudflare/clef-flash",
      expect.objectContaining({ model: "clef-flash" })
    );
  });

  it("handles concurrent clef and clef-flash requests correctly", async () => {
    const env = createEnv({
      AI: {
        run: vi.fn().mockImplementation(async (model) => {
          if (model === "@cf/cloudflare/clef") {
            return { model: "clef", answers: {} };
          }
          return { model: "clef-flash", answers: {} };
        })
      }
    });

    const reqClef = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ ...clefReqFixture, model: "clef" })
    });

    const reqFlash = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ ...clefReqFixture, model: "clef-flash" })
    });

    const [resClef, resFlash] = await Promise.all([
      worker.fetch(reqClef, env),
      worker.fetch(reqFlash, env)
    ]);

    const jsonClef = await resClef.json();
    const jsonFlash = await resFlash.json();

    expect(jsonClef.model).toBe("clef");
    expect(jsonFlash.model).toBe("clef-flash");
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });
});
