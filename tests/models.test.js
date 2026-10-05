import { describe, it, expect } from "vitest";
import { mapModel, mapBodyModel, resolveModel, validateBody, ValidationError, MODEL_LIST } from "../src/index.js";

const VALID_QUESTIONS = {
  urgent: { type: "noul", instructions: "urgent?" }
};

describe("Model mapping - Aliases and explicit models", () => {
  it("maps jev aliases to clef", () => {
    const clefAliases = [
      "jev-latest",
      "jev-preview",
      "jev-1.0",
      "jev-1.13",
      "jev-1.13.0",
      "jev-1.99",
      "jev-1.99.99"
    ];

    for (const alias of clefAliases) {
      expect(mapModel(alias)).toBe("clef");
      expect(mapBodyModel(alias)).toBe("clef");
    }
  });

  it("passes through explicit clef and clef-flash models", () => {
    expect(mapModel("clef")).toBe("clef");
    expect(mapModel("clef-flash")).toBe("clef-flash");
  });

  it("rejects unknown models and version boundaries with invalid_model 422", () => {
    const invalidModels = [
      "jev-2.0.0",
      "jev-foo",
      "jev-1.13-beta",
      "jev-1.13.0.1",
      "jev-1",
      " jev-latest ",
      "clef-pro",
      "gpt-4",
      "claude-3",
      ""
    ];

    for (const invalid of invalidModels) {
      expect(() => mapModel(invalid)).toThrow(ValidationError);
      try {
        mapModel(invalid);
      } catch (err) {
        expect(err.code).toBe("invalid_model");
        expect(err.param).toBe("model");
        expect(err.status).toBe(422);
      }
    }
  });
});

describe("Model resolution - Path pinning and precedence", () => {
  it("overrides body model to 'clef' on /clef/v1/systemone even for unknown or clef-flash", () => {
    const tests = [
      { body: { model: "clef-flash" }, expected: "clef" },
      { body: { model: "unknown-model" }, expected: "clef" },
      { body: { model: "jev-latest" }, expected: "clef" }
    ];

    for (const t of tests) {
      expect(resolveModel("/clef/v1/systemone", t.body)).toBe(t.expected);
      const fullReq = { state: "test", model: t.body.model, questions: VALID_QUESTIONS };
      expect(validateBody(fullReq, "/clef/v1/systemone")).toBe("clef");
    }
  });

  it("overrides body model to 'clef-flash' on /clef-flash/v1/systemone even for unknown or jev-latest", () => {
    const tests = [
      { body: { model: "clef" }, expected: "clef-flash" },
      { body: { model: "unknown-model" }, expected: "clef-flash" },
      { body: { model: "jev-latest" }, expected: "clef-flash" }
    ];

    for (const t of tests) {
      expect(resolveModel("/clef-flash/v1/systemone", t.body)).toBe(t.expected);
      const fullReq = { state: "test", model: t.body.model, questions: VALID_QUESTIONS };
      expect(validateBody(fullReq, "/clef-flash/v1/systemone")).toBe("clef-flash");
    }
  });

  it("requires valid presence and string type of 'model' on pinned paths too", () => {
    for (const path of ["/clef/v1/systemone", "/clef-flash/v1/systemone"]) {
      // Missing model
      const missing = { state: "test", questions: VALID_QUESTIONS };
      expect(() => validateBody(missing, path)).toThrow(ValidationError);
      try {
        validateBody(missing, path);
      } catch (err) {
        expect(err.code).toBe("missing_field");
        expect(err.param).toBe("model");
      }

      // Non-string model
      const nonString = { state: "test", model: 123, questions: VALID_QUESTIONS };
      expect(() => validateBody(nonString, path)).toThrow(ValidationError);
      try {
        validateBody(nonString, path);
      } catch (err) {
        expect(err.code).toBe("invalid_field");
        expect(err.param).toBe("model");
      }
    }
  });

  it("follows body.model on unpinned /v1/systemone", () => {
    const fullClef = { state: "test", model: "jev-latest", questions: VALID_QUESTIONS };
    expect(validateBody(fullClef, "/v1/systemone")).toBe("clef");

    const fullFlash = { state: "test", model: "clef-flash", questions: VALID_QUESTIONS };
    expect(validateBody(fullFlash, "/v1/systemone")).toBe("clef-flash");

    const fullUnknown = { state: "test", model: "unknown-model", questions: VALID_QUESTIONS };
    expect(() => validateBody(fullUnknown, "/v1/systemone")).toThrow(ValidationError);
  });
});

describe("GET /v1/models response shape", () => {
  it("contains Jev compliant list envelope with clef and clef-flash entries", () => {
    expect(MODEL_LIST.object).toBe("list");
    expect(Array.isArray(MODEL_LIST.data)).toBe(true);
    expect(MODEL_LIST.data.length).toBe(2);

    const names = MODEL_LIST.data.map(m => m.name);
    expect(names).toContain("clef");
    expect(names).toContain("clef-flash");

    for (const m of MODEL_LIST.data) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.description).toBe("string");
      expect(typeof m.release_date).toBe("string");
      expect(m.release_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // Also supports .models array for SDK variations
    expect(Array.isArray(MODEL_LIST.models)).toBe(true);
    expect(MODEL_LIST.models).toEqual(MODEL_LIST.data);
  });
});
