import { describe, it, expect, vi } from "vitest";
import worker, { validateBody, validateRequest, ValidationError, getQuestionEntries } from "../src/index.js";

const VALID_BASE_REQUEST = {
  state: "User needs assistance with subscription",
  model: "clef",
  questions: {
    urgent: {
      type: "noul",
      instructions: "Is this urgent?"
    }
  }
};

describe("Validation - Root body and required fields", () => {
  it("rejects non-object body primitives, null, and arrays", () => {
    for (const invalid of [null, undefined, 123, "string", true, [1, 2]]) {
      expect(() => validateBody(invalid)).toThrow(ValidationError);
      const res = validateRequest(invalid);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe("invalid_field");
      expect(res.error.param).toBe("body");
      expect(res.error.status).toBe(422);
      expect(res.error.type).toBe("invalid_request_error");
    }
  });

  it("requires 'state' field as own property", () => {
    const withoutState = { model: "clef", questions: VALID_BASE_REQUEST.questions };
    expect(() => validateBody(withoutState)).toThrow(ValidationError);
    const res = validateRequest(withoutState);
    expect(res.valid).toBe(false);
    expect(res.error.code).toBe("missing_field");
    expect(res.error.param).toBe("state");
  });

  it("accepts any JSON value for 'state' including falsy and structured values", () => {
    const states = [
      "",
      0,
      false,
      null,
      [],
      {},
      { complex: ["nested", 123, { bool: true }] },
      [null, false, "item"]
    ];

    for (const state of states) {
      const req = { ...VALID_BASE_REQUEST, state };
      expect(() => validateBody(req)).not.toThrow();
      expect(validateRequest(req).valid).toBe(true);
    }
  });

  it("requires 'model' field as own property and string", () => {
    const withoutModel = { state: "foo", questions: VALID_BASE_REQUEST.questions };
    const resMissing = validateRequest(withoutModel);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("model");

    const nonStringModel = { ...VALID_BASE_REQUEST, model: 123 };
    const resNonString = validateRequest(nonStringModel);
    expect(resNonString.valid).toBe(false);
    expect(resNonString.error.code).toBe("invalid_field");
    expect(resNonString.error.param).toBe("model");
  });

  it("requires 'questions' field as an own object", () => {
    const withoutQuestions = { state: "foo", model: "clef" };
    const resMissing = validateRequest(withoutQuestions);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("questions");

    for (const badQuestions of [null, "not an object", 42, ["item"]]) {
      const req = { state: "foo", model: "clef", questions: badQuestions };
      const res = validateRequest(req);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe("invalid_field");
      expect(res.error.param).toBe("questions");
    }
  });
});

describe("Validation - Question count and IDs", () => {
  it("enforces question count between 1 and 64", () => {
    // 0 questions
    const res0 = validateRequest({ ...VALID_BASE_REQUEST, questions: {} });
    expect(res0.valid).toBe(false);
    expect(res0.error.code).toBe("invalid_field");
    expect(res0.error.param).toBe("questions");

    // 1 question
    const res1 = validateRequest(VALID_BASE_REQUEST);
    expect(res1.valid).toBe(true);

    // 64 questions
    const q64 = {};
    for (let i = 0; i < 64; i++) {
      q64[`q_${i}`] = { type: "noul", instructions: `Question ${i}` };
    }
    const res64 = validateRequest({ ...VALID_BASE_REQUEST, questions: q64 });
    expect(res64.valid).toBe(true);

    // 65 questions
    q64["q_64"] = { type: "noul", instructions: "Question 65" };
    const res65 = validateRequest({ ...VALID_BASE_REQUEST, questions: q64 });
    expect(res65.valid).toBe(false);
    expect(res65.error.code).toBe("invalid_field");
    expect(res65.error.param).toBe("questions");
  });

  it("validates question ID regex ^[A-Za-z0-9_.-]{1,100}$", () => {
    // Valid lengths and punctuation
    const validIds = ["a", "Z", "0", "a-b", "a.b", "a_b", "a-1.2_c", "x".repeat(100)];
    for (const id of validIds) {
      const req = {
        ...VALID_BASE_REQUEST,
        questions: { [id]: { type: "noul", instructions: "test" } }
      };
      expect(validateRequest(req).valid).toBe(true);
    }

    // Invalid IDs: length 101, spaces, slashes, unicode
    const invalidIds = ["x".repeat(101), "with space", "with/slash", "unicode_ümlaut", "id#special", ""];
    for (const id of invalidIds) {
      const req = {
        ...VALID_BASE_REQUEST,
        questions: { [id]: { type: "noul", instructions: "test" } }
      };
      const res = validateRequest(req);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe("invalid_field");
      expect(res.error.param).toBe(`questions.${id}`);
    }
  });

  it("safely handles prototype-like question IDs", async () => {
    for (const protoId of ["constructor", "toString", "valueOf"]) {
      const questions = {};
      questions[protoId] = { type: "noul", instructions: "safe proto test" };
      const req = { ...VALID_BASE_REQUEST, questions };
      const res = validateRequest(req);
      expect(res.valid).toBe(true);
    }

    // A1: Rebuild own enumerable __proto__ via JSON.parse
    const jsonStr = '{"state":"ok","model":"clef","questions":{"__proto__":{"type":"noul","instructions":"proto test"}}}';
    const jsonReq = JSON.parse(jsonStr);

    // Verify __proto__ is an OWN enumerable property created by JSON.parse
    expect(Object.prototype.hasOwnProperty.call(jsonReq.questions, "__proto__")).toBe(true);
    expect(Object.keys(jsonReq.questions)).toContain("__proto__");

    // The id regex /^[A-Za-z0-9_.-]{1,100}$/ matches "__proto__" (only alphanumeric + underscores)
    expect(/^[A-Za-z0-9_.-]{1,100}$/.test("__proto__")).toBe(true);

    // Validator treats it as a valid own question key
    const res = validateRequest(jsonReq);
    expect(res.valid).toBe(true);

    // Verify getQuestionEntries extracts it as an own key entry
    const entries = getQuestionEntries(jsonReq.questions);
    expect(entries.length).toBe(1);
    expect(entries[0][0]).toBe("__proto__");
    expect(entries[0][1]).toEqual({ type: "noul", instructions: "proto test" });

    // Assert prototype is not polluted and answers mapping cannot be poisoned
    expect(Object.prototype.instructions).toBeUndefined();
    expect(Object.prototype.type).toBeUndefined();

    // Also verify own key defined via Object.defineProperty
    const definedQuestions = {};
    Object.defineProperty(definedQuestions, "__proto__", {
      value: { type: "noul", instructions: "defined proto" },
      enumerable: true,
      configurable: true,
      writable: true
    });
    expect(Object.prototype.hasOwnProperty.call(definedQuestions, "__proto__")).toBe(true);
    const defReq = { ...VALID_BASE_REQUEST, questions: definedQuestions };
    expect(validateRequest(defReq).valid).toBe(true);
    expect(Object.prototype.instructions).toBeUndefined();

    // Verify forwarding: valid request carrying own '__proto__' and normal question reaches AI.run
    const forwardJsonStr = '{"state":"ok","model":"clef","questions":{"__proto__":{"type":"noul","instructions":"proto test"},"normal_q":{"type":"noul","instructions":"normal test"}}}';
    const forwardReq = new Request("https://clef.example/v1/systemone", {
      method: "POST",
      headers: {
        Authorization: "Bearer proto-test-token",
        "Content-Type": "application/json"
      },
      body: forwardJsonStr
    });
    const runMock = vi.fn().mockResolvedValue({
      model: "clef",
      answers: {
        __proto__: { type: "noul", noul: 0.5 },
        normal_q: { type: "noul", noul: 0.8 }
      }
    });
    const env = {
      CLEF_TOKEN: "proto-test-token",
      AI: { run: runMock }
    };
    const forwardRes = await worker.fetch(forwardReq, env);
    expect(forwardRes.status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);

    const [upstreamModel, forwardedBody] = runMock.mock.calls[0];
    expect(upstreamModel).toBe("@cf/cloudflare/clef");
    expect(forwardedBody.questions).toBeDefined();

    // BOTH questions present in the forwarded body's questions
    expect(Object.prototype.hasOwnProperty.call(forwardedBody.questions, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(forwardedBody.questions, "normal_q")).toBe(true);
    expect(forwardedBody.questions["__proto__"]).toEqual({ type: "noul", instructions: "proto test" });
    expect(forwardedBody.questions.normal_q).toEqual({ type: "noul", instructions: "normal test" });

    // The forwarded object's prototype chain is untouched
    const protoChain = Object.getPrototypeOf(forwardedBody.questions);
    expect(protoChain === null || protoChain === Object.prototype).toBe(true);

    // No pollution of Object.prototype
    expect(Object.prototype.instructions).toBeUndefined();
    expect(Object.prototype.type).toBeUndefined();
  });
});

describe("Validation - Question common properties and types", () => {
  it("rejects non-object question entries", () => {
    const req = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: "not an object" }
    };
    const res = validateRequest(req);
    expect(res.valid).toBe(false);
    expect(res.error.code).toBe("invalid_field");
    expect(res.error.param).toBe("questions.urgent");
  });

  it("requires 'type' property with valid enum ('noul', 'choice', 'score')", () => {
    // Missing type
    const missingType = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: { instructions: "test" } }
    };
    const resMissing = validateRequest(missingType);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("questions.urgent.type");

    // Invalid type
    const invalidType = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: { type: "boolean", instructions: "test" } }
    };
    const resInvalid = validateRequest(invalidType);
    expect(resInvalid.valid).toBe(false);
    expect(resInvalid.error.code).toBe("invalid_field");
    expect(resInvalid.error.param).toBe("questions.urgent.type");
  });

  it("requires 'instructions' property satisfying entry() shape", () => {
    // Missing instructions
    const missing = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: { type: "noul" } }
    };
    const resMissing = validateRequest(missing);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("questions.urgent.instructions");

    // Valid entry shapes: string, object, array, null
    const validEntries = ["simple string", { text: "structured" }, ["array", "lines"], null];
    for (const inst of validEntries) {
      const req = {
        ...VALID_BASE_REQUEST,
        questions: { urgent: { type: "noul", instructions: inst } }
      };
      expect(validateRequest(req).valid).toBe(true);
    }

    // Invalid entry shapes: number, boolean
    for (const bad of [123, true, false]) {
      const req = {
        ...VALID_BASE_REQUEST,
        questions: { urgent: { type: "noul", instructions: bad } }
      };
      const res = validateRequest(req);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe("invalid_field");
      expect(res.error.param).toBe("questions.urgent.instructions");
    }
  });
});

describe("Validation - Noul criteria", () => {
  it("accepts omitted, null, empty object, true-only, false-only, and both criteria", () => {
    const validCriteria = [
      undefined,
      null,
      {},
      { true: "is urgent" },
      { false: "not urgent" },
      { true: "is urgent", false: "not urgent" },
      { true: { desc: "structured" }, false: ["array", "desc"] }
    ];

    for (const crit of validCriteria) {
      const q = { type: "noul", instructions: "check" };
      if (crit !== undefined) q.criteria = crit;
      const req = { ...VALID_BASE_REQUEST, questions: { urgent: q } };
      expect(validateRequest(req).valid).toBe(true);
    }
  });

  it("rejects invalid container, unknown keys, or invalid entry values in noul criteria", () => {
    // Bad container
    const badContainers = ["string", 123, ["true"]];
    for (const crit of badContainers) {
      const req = {
        ...VALID_BASE_REQUEST,
        questions: { urgent: { type: "noul", instructions: "check", criteria: crit } }
      };
      const res = validateRequest(req);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe("invalid_field");
      expect(res.error.param).toBe("questions.urgent.criteria");
    }

    // Unknown outcome key
    const unknownKeyReq = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: { type: "noul", instructions: "check", criteria: { maybe: "uncertain" } } }
    };
    const resKey = validateRequest(unknownKeyReq);
    expect(resKey.valid).toBe(false);
    expect(resKey.error.code).toBe("invalid_field");
    expect(resKey.error.param).toBe("questions.urgent.criteria.maybe");

    // Bad description entry (number)
    const badDescReq = {
      ...VALID_BASE_REQUEST,
      questions: { urgent: { type: "noul", instructions: "check", criteria: { true: 42 } } }
    };
    const resDesc = validateRequest(badDescReq);
    expect(resDesc.valid).toBe(false);
    expect(resDesc.error.code).toBe("invalid_field");
    expect(resDesc.error.param).toBe("questions.urgent.criteria.true");
  });
});

describe("Validation - Choice criteria", () => {
  it("requires criteria object with 1–255 options", () => {
    // Missing criteria
    const missing = {
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?" } }
    };
    const resMissing = validateRequest(missing);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("questions.team.criteria");

    // 0 options
    const empty = {
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?", criteria: {} } }
    };
    const res0 = validateRequest(empty);
    expect(res0.valid).toBe(false);
    expect(res0.error.code).toBe("invalid_field");
    expect(res0.error.param).toBe("questions.team.criteria");

    // 1 option
    const one = {
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?", criteria: { tech: "Technical" } } }
    };
    expect(validateRequest(one).valid).toBe(true);

    // 255 options
    const crit255 = {};
    for (let i = 0; i < 255; i++) crit255[`opt_${i}`] = `Description ${i}`;
    const req255 = {
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?", criteria: crit255 } }
    };
    expect(validateRequest(req255).valid).toBe(true);

    // 256 options
    crit255["opt_255"] = "Description 256";
    const res256 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?", criteria: crit255 } }
    });
    expect(res256.valid).toBe(false);
    expect(res256.error.code).toBe("invalid_field");
    expect(res256.error.param).toBe("questions.team.criteria");

    // 300 options rejection (specifically noted in SPEC)
    const crit300 = {};
    for (let i = 0; i < 300; i++) crit300[`opt_${i}`] = `Desc ${i}`;
    const res300 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { team: { type: "choice", instructions: "Which team?", criteria: crit300 } }
    });
    expect(res300.valid).toBe(false);
    expect(res300.error.code).toBe("invalid_field");
    expect(res300.error.param).toBe("questions.team.criteria");
  });

  it("supports structured/null descriptions and rejects non-entry values", () => {
    const validDesc = {
      ...VALID_BASE_REQUEST,
      questions: {
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: {
            billing: "Text description",
            support: { structured: true },
            sales: ["line1", "line2"],
            other: null
          }
        }
      }
    };
    expect(validateRequest(validDesc).valid).toBe(true);

    // Invalid option description (boolean)
    const invalidDesc = {
      ...VALID_BASE_REQUEST,
      questions: {
        team: {
          type: "choice",
          instructions: "Which team?",
          criteria: {
            billing: true
          }
        }
      }
    };
    const res = validateRequest(invalidDesc);
    expect(res.valid).toBe(false);
    expect(res.error.code).toBe("invalid_field");
    expect(res.error.param).toBe("questions.team.criteria.billing");
  });
});

describe("Validation - Score criteria", () => {
  it("requires criteria array with 2–10 levels", () => {
    // Missing criteria
    const missing = {
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate severity" } }
    };
    const resMissing = validateRequest(missing);
    expect(resMissing.valid).toBe(false);
    expect(resMissing.error.code).toBe("missing_field");
    expect(resMissing.error.param).toBe("questions.score.criteria");

    // 0 levels
    const res0 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate", criteria: [] } }
    });
    expect(res0.valid).toBe(false);
    expect(res0.error.code).toBe("invalid_field");

    // 1 level (SPEC explicitly mentions single level rejection)
    const res1 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate", criteria: ["Low"] } }
    });
    expect(res1.valid).toBe(false);
    expect(res1.error.code).toBe("invalid_field");
    expect(res1.error.param).toBe("questions.score.criteria");

    // 2 levels
    const res2 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate", criteria: ["Low", "High"] } }
    });
    expect(res2.valid).toBe(true);

    // 10 levels
    const lv10 = Array.from({ length: 10 }, (_, i) => `Level ${i}`);
    const res10 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate", criteria: lv10 } }
    });
    expect(res10.valid).toBe(true);

    // 11 levels
    const lv11 = Array.from({ length: 11 }, (_, i) => `Level ${i}`);
    const res11 = validateRequest({
      ...VALID_BASE_REQUEST,
      questions: { score: { type: "score", instructions: "Rate", criteria: lv11 } }
    });
    expect(res11.valid).toBe(false);
    expect(res11.error.code).toBe("invalid_field");
    expect(res11.error.param).toBe("questions.score.criteria");
    expect(res11.error.message).toMatch(/2[-–]10 levels/);
  });

  it("preserves order, duplicates, and structured/null level descriptions", () => {
    const req = {
      ...VALID_BASE_REQUEST,
      questions: {
        score: {
          type: "score",
          instructions: "Rate",
          criteria: [
            "Level A",
            "Level A", // duplicate
            { complex: 1 },
            ["sub1", "sub2"],
            null
          ]
        }
      }
    };
    expect(validateRequest(req).valid).toBe(true);

    // Non-entry level value (number)
    const badReq = {
      ...VALID_BASE_REQUEST,
      questions: {
        score: {
          type: "score",
          instructions: "Rate",
          criteria: ["Valid", 99]
        }
      }
    };
    const res = validateRequest(badReq);
    expect(res.valid).toBe(false);
    expect(res.error.code).toBe("invalid_field");
    expect(res.error.param).toBe("questions.score.criteria.1");
  });
});

describe("Validation - Images extension", () => {
  const VALID_BASE64_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  it("accepts omitted, empty array, and up to 4 valid images", () => {
    // Omitted
    expect(validateRequest(VALID_BASE_REQUEST).valid).toBe(true);

    // Empty array
    expect(validateRequest({ ...VALID_BASE_REQUEST, images: [] }).valid).toBe(true);

    // 4 valid images (mix of data URL strings and object forms)
    const images4 = [
      `data:image/png;base64,${VALID_BASE64_PNG}`,
      { content_type: "image/png", base64: VALID_BASE64_PNG },
      `data:image/jpeg;base64,${VALID_BASE64_PNG}`,
      { content_type: "image/webp", base64: VALID_BASE64_PNG }
    ];
    expect(validateRequest({ ...VALID_BASE_REQUEST, images: images4 }).valid).toBe(true);
  });

  it("rejects more than 4 images or non-array images", () => {
    const resNonArr = validateRequest({ ...VALID_BASE_REQUEST, images: "not-an-array" });
    expect(resNonArr.valid).toBe(false);
    expect(resNonArr.error.code).toBe("invalid_field");
    expect(resNonArr.error.param).toBe("images");

    const images5 = [
      `data:image/png;base64,${VALID_BASE64_PNG}`,
      `data:image/png;base64,${VALID_BASE64_PNG}`,
      `data:image/png;base64,${VALID_BASE64_PNG}`,
      `data:image/png;base64,${VALID_BASE64_PNG}`,
      `data:image/png;base64,${VALID_BASE64_PNG}`
    ];
    const res5 = validateRequest({ ...VALID_BASE_REQUEST, images: images5 });
    expect(res5.valid).toBe(false);
    expect(res5.error.code).toBe("invalid_field");
    expect(res5.error.param).toBe("images");
  });

  it("validates mime types and rejects invalid ones", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
      const reqUrl = {
        ...VALID_BASE_REQUEST,
        images: [`data:${mime};base64,${VALID_BASE64_PNG}`]
      };
      expect(validateRequest(reqUrl).valid).toBe(true);

      const reqObj = {
        ...VALID_BASE_REQUEST,
        images: [{ content_type: mime, base64: VALID_BASE64_PNG }]
      };
      expect(validateRequest(reqObj).valid).toBe(true);
    }

    const badMimeUrl = {
      ...VALID_BASE_REQUEST,
      images: [`data:image/gif;base64,${VALID_BASE64_PNG}`]
    };
    const resUrl = validateRequest(badMimeUrl);
    expect(resUrl.valid).toBe(false);
    expect(resUrl.error.code).toBe("invalid_field");
    expect(resUrl.error.param).toBe("images[0]");

    const badMimeObj = {
      ...VALID_BASE_REQUEST,
      images: [{ content_type: "image/gif", base64: VALID_BASE64_PNG }]
    };
    const resObj = validateRequest(badMimeObj);
    expect(resObj.valid).toBe(false);
    expect(resObj.error.code).toBe("invalid_field");
    expect(resObj.error.param).toBe("images[0]");
  });

  it("rejects missing data, empty data, URLs, and data: prefixes", () => {
    const tests = [
      { img: { content_type: "image/png" }, param: "images[0]", code: "invalid_field" },
      { img: { content_type: "image/png", base64: "" }, param: "images[0]", code: "invalid_field" },
      { img: { base64: VALID_BASE64_PNG }, param: "images[0]", code: "invalid_field" },
      { img: "https://example.com/pic.png", param: "images[0]", code: "invalid_field" },
      { img: "data:image/png;notbase64", param: "images[0]", code: "invalid_field" },
      { img: "data:image/png;base64,invalid!base64?characters", param: "images[0]", code: "invalid_field" },
      { img: { content_type: "image/png", base64: "invalid!base64?characters" }, param: "images[0]", code: "invalid_field" },
      { img: 123, param: "images[0]", code: "invalid_field" }
    ];

    for (const t of tests) {
      const req = { ...VALID_BASE_REQUEST, images: [t.img] };
      const res = validateRequest(req);
      expect(res.valid).toBe(false);
      expect(res.error.code).toBe(t.code);
      expect(res.error.param).toBe(t.param);
    }
  });

  it("enforces decoded size limits (<= 4 MiB per image, <= 8 MiB total)", () => {
    // 4 MiB = 4 * 1024 * 1024 = 4,194,304 bytes decoded -> 5,592,408 base64 chars
    // Create base64 string just above 4 MiB decoded
    const over4MiBChars = "A".repeat(5592416); // 5,592,416 / 4 * 3 = 4,194,312 bytes > 4 MiB
    const reqOver4MiBUrl = {
      ...VALID_BASE_REQUEST,
      images: [`data:image/png;base64,${over4MiBChars}`]
    };
    const resSingleUrl = validateRequest(reqOver4MiBUrl);
    expect(resSingleUrl.valid).toBe(false);
    expect(resSingleUrl.error.code).toBe("invalid_field");
    expect(resSingleUrl.error.param).toBe("images[0]");

    const reqOver4MiBObj = {
      ...VALID_BASE_REQUEST,
      images: [{ content_type: "image/png", base64: over4MiBChars }]
    };
    const resSingleObj = validateRequest(reqOver4MiBObj);
    expect(resSingleObj.valid).toBe(false);
    expect(resSingleObj.error.code).toBe("invalid_field");
    expect(resSingleObj.error.param).toBe("images[0]");

    // 3 images of 3 MiB each = 9 MiB total > 8 MiB limit
    // 3 MiB = 3,145,728 bytes decoded = 4,194,304 base64 chars
    const img3MiB = "A".repeat(4194304);
    const reqTotalOver8MiB = {
      ...VALID_BASE_REQUEST,
      images: [
        `data:image/png;base64,${img3MiB}`,
        { content_type: "image/png", base64: img3MiB },
        `data:image/png;base64,${img3MiB}`
      ]
    };
    const resTotal = validateRequest(reqTotalOver8MiB);
    expect(resTotal.valid).toBe(false);
    expect(resTotal.error.code).toBe("invalid_field");
    expect(resTotal.error.param).toBe("images");
  });
});

describe("Validation - Deterministic first-failure order and extra fields", () => {
  it("enforces strict deterministic order: body -> state -> model -> questions -> question entries -> images", () => {
    // Missing state AND model AND questions -> fails on state first
    const missingAll = {};
    const res1 = validateRequest(missingAll);
    expect(res1.error.param).toBe("state");

    // Missing model AND questions -> fails on model first
    const missingModelQuestions = { state: "ok" };
    const res2 = validateRequest(missingModelQuestions);
    expect(res2.error.param).toBe("model");

    // Invalid model AND bad questions -> fails on model first
    const badModelAndQuestions = { state: "ok", model: "unsupported", questions: {} };
    const res3 = validateRequest(badModelAndQuestions);
    expect(res3.error.param).toBe("model");

    // Questions failure before question entries
    const emptyQuestionsWithBadEntries = { state: "ok", model: "clef", questions: {} };
    const res4 = validateRequest(emptyQuestionsWithBadEntries);
    expect(res4.error.param).toBe("questions");

    // Question entries failure before images
    const badQuestionAndBadImage = {
      state: "ok",
      model: "clef",
      questions: { urgent: { type: "bad_type", instructions: "test" } },
      images: [{ content_type: "bad/mime", base64: "bad" }]
    };
    const res5 = validateRequest(badQuestionAndBadImage);
    expect(res5.error.param).toBe("questions.urgent.type");
  });

  it("preserves extra fields without failing validation", () => {
    const withExtras = {
      ...VALID_BASE_REQUEST,
      custom_metadata: { user_id: 12345, tags: ["prod", "fast"] },
      client_timestamp: 1728000000
    };
    const res = validateRequest(withExtras);
    expect(res.valid).toBe(true);
  });
});
