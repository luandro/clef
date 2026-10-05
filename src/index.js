/**
 * clef-proxy — Jev-compatible Cloudflare Workers AI Proxy for Clef & Clef Flash
 */

export const MAX_BODY_BYTES = 13 * 1024 * 1024; // 13 MiB = 13,631,488 bytes
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;       // 4 MiB = 4,194,304 bytes
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB = 8,388,608 bytes

const QUESTION_ID_REGEX = /^[A-Za-z0-9_.-]{1,100}$/;
const LEGACY_VERSION = /^jev-1\.\d+(?:\.\d+)?$/;
const SAFE_BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

function isValidBase64(str) {
  if (str.length % 4 !== 0) return false;
  if (!SAFE_BASE64_CHARS.test(str)) return false;
  const paddingIndex = str.indexOf("=");
  if (paddingIndex !== -1) {
    if (paddingIndex < str.length - 2) return false;
    if (paddingIndex === str.length - 2 && str[str.length - 1] !== "=") return false;
  }
  return true;
}

const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

const EVALUATION_PATHS = new Set([
  "/v1/systemone",
  "/clef/v1/systemone",
  "/clef-flash/v1/systemone"
]);

export const MODEL_DATA = [
  {
    name: "clef",
    description: "Cloudflare Clef decision model",
    release_date: "2026-10-04"
  },
  {
    name: "clef-flash",
    description: "Cloudflare Clef Flash decision model",
    release_date: "2026-10-04"
  }
];

export const MODEL_LIST = {
  object: "list",
  data: MODEL_DATA,
  models: MODEL_DATA
};

// Shape helpers
export const own = (value, key) => Object.hasOwn(value, key);

export const record = value =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

export const entry = value =>
  value === null ||
  typeof value === "string" ||
  record(value) ||
  Array.isArray(value);

export class ValidationError extends Error {
  constructor(param, code, message, status = 422, type = "invalid_request_error") {
    super(message);
    this.name = "ValidationError";
    this.param = param;
    this.code = code;
    this.status = status;
    this.type = type;
  }

  toResponse() {
    return errorResponse(this.status, this.type, this.code, this.message, this.param);
  }
}

const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Validate and sanitize Retry-After value according to RFC 9110 / RFC 7231.
 * Accepts delay-seconds (non-negative integer) or strict IMF-fixdate HTTP-date.
 * Drops invalid formats, decimals, signs, whitespace, or junk.
 */
export function sanitizeRetryAfter(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);

  // 1. delay-seconds: non-negative integer (no decimals/sign/whitespace)
  if (/^\d+$/.test(str)) {
    return str;
  }

  // 2. strict RFC 7231 IMF-fixdate HTTP-date
  if (IMF_FIXDATE.test(str) && !Number.isNaN(Date.parse(str))) {
    return str;
  }

  return null;
}

/**
 * Construct exact standard proxy error response.
 */
export function errorResponse(status, type, code, message, param = null, retryAfter = null) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };
  const validRetry = sanitizeRetryAfter(retryAfter);
  if (validRetry !== null) {
    headers["Retry-After"] = validRetry;
  }
  return new Response(
    JSON.stringify({
      error: {
        type,
        code,
        message,
        param: param !== undefined ? param : null
      }
    }),
    {
      status,
      headers
    }
  );
}

/**
 * SHA-256 helper for crypto.subtle.
 */
async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * Authenticate incoming Bearer token in constant time against env.CLEF_TOKEN.
 */
export async function authenticate(request, env) {
  const authHeader = request.headers?.get("Authorization");
  if (!authHeader) return false;

  const match = authHeader.match(/^Bearer ([^\s]+)$/i);
  if (!match || !env?.CLEF_TOKEN || typeof env.CLEF_TOKEN !== "string") {
    return false;
  }

  const supplied = await sha256(match[1]);
  const expected = await sha256(env.CLEF_TOKEN);

  let difference = 0;
  for (let i = 0; i < 32; i++) {
    difference |= supplied[i] ^ expected[i];
  }

  return difference === 0;
}

/**
 * Helper to ensure reader and underlying stream / body are properly cancelled on overflow.
 */
async function cancelStream(reader) {
  try {
    await reader.cancel("request_too_large");
  } catch {}
}

/**
 * Read request body with 13 MiB limit and UTF-8 / JSON decoding.
 */
export async function readBoundedJson(request) {
  const clHeader = request.headers?.get("content-length");
  if (clHeader !== null && clHeader !== undefined) {
    const cl = Number(clHeader);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      return {
        error: errorResponse(422, "invalid_request_error", "request_too_large", "body: exceeds 13 MiB", "body")
      };
    }
  }

  if (!request.body) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: empty request body", "body")
    };
  }

  const reader = request.body.getReader();
  let total = 0;
  const chunks = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await cancelStream(reader);
        return {
          error: errorResponse(422, "invalid_request_error", "request_too_large", "body: exceeds 13 MiB", "body")
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: error reading request stream: " + err.message, "body")
    };
  }

  if (total === 0) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: empty request body", "body")
    };
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    text = decoder.decode(buffer);
  } catch (err) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: invalid UTF-8 encoding", "body")
    };
  }

  if (!text.trim()) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: empty request body", "body")
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return {
      error: errorResponse(422, "invalid_request_error", "invalid_json", "body: invalid JSON: " + err.message, "body")
    };
  }

  return { data };
}

/**
 * Map model name from body to upstream model name ("clef" or "clef-flash").
 */
export function mapModel(model) {
  if (
    model === "jev-latest" ||
    model === "jev-preview" ||
    (typeof model === "string" && LEGACY_VERSION.test(model))
  ) {
    return "clef";
  }

  if (model === "clef" || model === "clef-flash") {
    return model;
  }

  throw new ValidationError("model", "invalid_model", "model: unsupported model");
}

export const mapBodyModel = mapModel;

/**
 * Resolve model considering path pinning.
 */
export function resolveModel(pathname, body) {
  if (pathname === "/clef/v1/systemone") {
    return "clef";
  }
  if (pathname === "/clef-flash/v1/systemone") {
    return "clef-flash";
  }
  return mapModel(body?.model);
}

/**
 * Safely extracts question entries, including __proto__ when set as a prototype,
 * without permitting prototype pollution.
 */
export function getQuestionEntries(questions) {
  if (!record(questions)) return [];

  const entries = [];
  const ownKeys = Object.getOwnPropertyNames(questions);

  // Safely handle __proto__ if set via prototype setter (Object.getPrototypeOf)
  const proto = Object.getPrototypeOf(questions);
  if (
    proto &&
    proto !== Object.prototype &&
    typeof proto === "object" &&
    !Object.prototype.hasOwnProperty.call(questions, "__proto__")
  ) {
    entries.push(["__proto__", proto]);
  }

  for (const key of ownKeys) {
    entries.push([key, questions[key]]);
  }

  return entries;
}

/**
 * Deterministic validation in order: body -> state -> model -> questions -> question entries -> images.
 * Returns selected model name on success; throws ValidationError on failure.
 */
export function validateBody(body, pathname = "/v1/systemone") {
  // 1. Body
  if (!record(body)) {
    throw new ValidationError("body", "invalid_field", "body: must be a JSON object");
  }

  // 2. State
  if (!own(body, "state")) {
    throw new ValidationError("state", "missing_field", "state: required field missing");
  }

  // 3. Model
  if (!own(body, "model")) {
    throw new ValidationError("model", "missing_field", "model: required field missing");
  }
  if (typeof body.model !== "string") {
    throw new ValidationError("model", "invalid_field", "model: must be a string");
  }

  // Check path pinning or map body model
  let selectedModel;
  if (pathname === "/clef/v1/systemone") {
    selectedModel = "clef";
  } else if (pathname === "/clef-flash/v1/systemone") {
    selectedModel = "clef-flash";
  } else {
    selectedModel = mapModel(body.model);
  }

  // 4. Questions
  if (!own(body, "questions")) {
    throw new ValidationError("questions", "missing_field", "questions: required field missing");
  }
  if (!record(body.questions)) {
    throw new ValidationError("questions", "invalid_field", "questions: must be an object");
  }

  const questionEntries = getQuestionEntries(body.questions);
  if (questionEntries.length < 1 || questionEntries.length > 64) {
    throw new ValidationError("questions", "invalid_field", "questions: expected 1–64 entries");
  }

  // 5. Question entries
  for (const [id, question] of questionEntries) {
    const field = `questions.${id}`;

    if (!QUESTION_ID_REGEX.test(id)) {
      throw new ValidationError(field, "invalid_field", `${field}: invalid question id`);
    }

    if (!record(question)) {
      throw new ValidationError(field, "invalid_field", `${field}: must be an object`);
    }

    if (!Object.prototype.hasOwnProperty.call(question, "type") && !("type" in question)) {
      throw new ValidationError(`${field}.type`, "missing_field", `${field}.type: required field missing`);
    }
    if (question.type !== "noul" && question.type !== "choice" && question.type !== "score") {
      throw new ValidationError(`${field}.type`, "invalid_field", `${field}.type: expected 'noul', 'choice', or 'score'`);
    }

    if (!Object.prototype.hasOwnProperty.call(question, "instructions") && !("instructions" in question)) {
      throw new ValidationError(`${field}.instructions`, "missing_field", `${field}.instructions: required field missing`);
    }
    if (!entry(question.instructions)) {
      throw new ValidationError(`${field}.instructions`, "invalid_field", `${field}.instructions: invalid instructions shape`);
    }

    if (question.type === "noul") {
      if (own(question, "criteria") && question.criteria !== null && question.criteria !== undefined) {
        if (!record(question.criteria)) {
          throw new ValidationError(`${field}.criteria`, "invalid_field", `${field}.criteria: must be an object`);
        }
        for (const [key, value] of Object.entries(question.criteria)) {
          if (key !== "true" && key !== "false") {
            throw new ValidationError(`${field}.criteria.${key}`, "invalid_field", `${field}.criteria.${key}: criteria keys for noul must be 'true' or 'false'`);
          }
          if (!entry(value)) {
            throw new ValidationError(`${field}.criteria.${key}`, "invalid_field", `${field}.criteria.${key}: invalid criteria entry`);
          }
        }
      }
    } else if (question.type === "choice") {
      if (!own(question, "criteria")) {
        throw new ValidationError(`${field}.criteria`, "missing_field", `${field}.criteria: required field missing`);
      }
      if (!record(question.criteria)) {
        throw new ValidationError(`${field}.criteria`, "invalid_field", `${field}.criteria: must be an object`);
      }
      const options = Object.keys(question.criteria);
      if (options.length < 1 || options.length > 255) {
        throw new ValidationError(`${field}.criteria`, "invalid_field", `${field}.criteria: expected 1–255 options`);
      }
      for (const [option, value] of Object.entries(question.criteria)) {
        if (!entry(value)) {
          throw new ValidationError(`${field}.criteria.${option}`, "invalid_field", `${field}.criteria.${option}: invalid criteria option value`);
        }
      }
    } else if (question.type === "score") {
      if (!own(question, "criteria")) {
        throw new ValidationError(`${field}.criteria`, "missing_field", `${field}.criteria: required field missing`);
      }
      if (!Array.isArray(question.criteria)) {
        throw new ValidationError(`${field}.criteria`, "invalid_field", `${field}.criteria: must be an array`);
      }
      if (question.criteria.length < 2 || question.criteria.length > 10) {
        throw new ValidationError(`${field}.criteria`, "invalid_field", `${field}.criteria: expected 2-10 levels`);
      }
      for (let i = 0; i < question.criteria.length; i++) {
        if (!entry(question.criteria[i])) {
          throw new ValidationError(`${field}.criteria.${i}`, "invalid_field", `${field}.criteria.${i}: invalid score level description`);
        }
      }
    }
  }

  // 6. Images
  if (own(body, "images") && body.images !== undefined) {
    if (!Array.isArray(body.images)) {
      throw new ValidationError("images", "invalid_field", "images: must be an array");
    }
    if (body.images.length > 4) {
      throw new ValidationError("images", "invalid_field", "images: maximum 4 images allowed");
    }

    let totalImageBytes = 0;

    for (let i = 0; i < body.images.length; i++) {
      const img = body.images[i];
      const imgField = `images[${i}]`;

      if (typeof img === "string") {
        if (!img.startsWith("data:")) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: must be a data URL starting with 'data:'`);
        }
        const marker = ";base64,";
        const markerIndex = img.indexOf(marker);
        if (markerIndex === -1) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: data URL missing ';base64,' payload`);
        }
        const mime = img.slice(5, markerIndex);
        if (!ALLOWED_MIMES.has(mime)) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: expected image/png, image/jpeg, or image/webp`);
        }
        const b64 = img.slice(markerIndex + marker.length);
        if (!b64 || !isValidBase64(b64)) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: invalid base64 encoding`);
        }

        let padding = 0;
        if (b64.endsWith("==")) padding = 2;
        else if (b64.endsWith("=")) padding = 1;
        const decodedBytes = Math.floor((b64.length / 4) * 3) - padding;

        if (decodedBytes > MAX_IMAGE_BYTES) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: image exceeds 4 MiB decoded size`);
        }

        totalImageBytes += decodedBytes;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new ValidationError("images", "invalid_field", "images: total image size exceeds 8 MiB decoded");
        }
      } else if (record(img)) {
        if (!own(img, "content_type") || typeof img.content_type !== "string" || !ALLOWED_MIMES.has(img.content_type)) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: content_type must be image/png, image/jpeg, or image/webp`);
        }

        if (!own(img, "base64") || typeof img.base64 !== "string" || img.base64.length === 0 || !isValidBase64(img.base64)) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: base64 must be a non-empty valid base64 string`);
        }

        let padding = 0;
        if (img.base64.endsWith("==")) padding = 2;
        else if (img.base64.endsWith("=")) padding = 1;
        const decodedBytes = Math.floor((img.base64.length / 4) * 3) - padding;

        if (decodedBytes > MAX_IMAGE_BYTES) {
          throw new ValidationError(imgField, "invalid_field", `${imgField}: image exceeds 4 MiB decoded size`);
        }

        totalImageBytes += decodedBytes;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new ValidationError("images", "invalid_field", "images: total image size exceeds 8 MiB decoded");
        }
      } else {
        throw new ValidationError(imgField, "invalid_field", `${imgField}: must be a data URL string or image object`);
      }
    }
  }

  return selectedModel;
}

/**
 * Pure helper for non-throwing validation results.
 */
export function validateRequest(body, pathname = "/v1/systemone") {
  try {
    const model = validateBody(body, pathname);
    return { valid: true, model };
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        valid: false,
        error: {
          status: err.status,
          type: err.type,
          code: err.code,
          message: err.message,
          param: err.param
        },
        response: err.toResponse()
      };
    }
    throw err;
  }
}

/**
 * Collect all candidate error codes from error, cause, body, and body.errors[].
 */
function collectCandidateCodes(error) {
  const codes = new Set();
  if (!error || typeof error !== "object") return codes;

  const add = val => {
    if (val !== null && val !== undefined) {
      codes.add(val);
      if (typeof val === "string" && /^\d+$/.test(val)) {
        codes.add(Number(val));
      }
    }
  };

  add(error.code);
  add(error.internalCode);
  add(error.upstreamCode);

  const checkBody = b => {
    let bodyObj = b;
    if (typeof bodyObj === "string") {
      try {
        bodyObj = JSON.parse(bodyObj);
      } catch {}
    }
    if (!bodyObj || typeof bodyObj !== "object") return;
    add(bodyObj.code);
    add(bodyObj.internalCode);
    add(bodyObj.upstreamCode);

    if (bodyObj.error && typeof bodyObj.error === "object") {
      add(bodyObj.error.code);
      add(bodyObj.error.internalCode);
      add(bodyObj.error.upstreamCode);
    }

    if (Array.isArray(bodyObj.errors)) {
      for (const e of bodyObj.errors) {
        if (e && typeof e === "object") {
          add(e.code);
          add(e.internalCode);
          add(e.upstreamCode);
        }
      }
    }
  };

  if (error.body) checkBody(error.body);

  if (error.cause && typeof error.cause === "object") {
    add(error.cause.code);
    add(error.cause.internalCode);
    add(error.cause.upstreamCode);
    if (error.cause.body) checkBody(error.cause.body);
  }

  return codes;
}

/**
 * Collect all candidate HTTP status codes.
 */
function collectCandidateStatuses(error) {
  const statuses = new Set();
  if (!error || typeof error !== "object") return statuses;

  const add = val => {
    const num = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(num) && num > 0) {
      statuses.add(num);
    }
  };

  add(error.httpStatus);
  add(error.status);
  add(error.statusCode);

  const checkBody = b => {
    let bodyObj = b;
    if (typeof bodyObj === "string") {
      try {
        bodyObj = JSON.parse(bodyObj);
      } catch {}
    }
    if (!bodyObj || typeof bodyObj !== "object") return;
    add(bodyObj.status);
    add(bodyObj.statusCode);

    if (bodyObj.error && typeof bodyObj.error === "object") {
      add(bodyObj.error.status);
      add(bodyObj.error.statusCode);
    }

    if (Array.isArray(bodyObj.errors)) {
      for (const e of bodyObj.errors) {
        if (e && typeof e === "object") {
          add(e.status);
          add(e.statusCode);
        }
      }
    }
  };

  if (error.body) checkBody(error.body);

  if (error.cause && typeof error.cause === "object") {
    add(error.cause.httpStatus);
    add(error.cause.status);
    add(error.cause.statusCode);
    if (error.cause.body) checkBody(error.cause.body);
  }

  return statuses;
}

/**
 * Normalize upstream thrown error, inspecting direct properties, cause,
 * cause.body (structured JSON error body), candidate codes, and headers.
 */
export function normalizeUpstreamError(error) {
  if (typeof error === "string") {
    return {
      message: error,
      httpStatus: null,
      internalCode: null,
      upstreamCode: null,
      candidateCodes: new Set(),
      candidateStatuses: new Set(),
      retryAfter: null
    };
  }

  if (!error || typeof error !== "object") {
    return {
      message: String(error),
      httpStatus: null,
      internalCode: null,
      upstreamCode: null,
      candidateCodes: new Set(),
      candidateStatuses: new Set(),
      retryAfter: null
    };
  }

  const cause = error.cause && typeof error.cause === "object" ? error.cause : {};
  const candidateCodes = collectCandidateCodes(error);
  const candidateStatuses = collectCandidateStatuses(error);

  // Inspect structured body on error or cause (JSON object or stringified JSON)
  let bodyObj = null;
  const rawBody = error.body ?? cause.body ?? null;
  if (rawBody) {
    if (typeof rawBody === "object") {
      bodyObj = rawBody;
    } else if (typeof rawBody === "string") {
      try {
        bodyObj = JSON.parse(rawBody);
      } catch {}
    }
  }
  const bodyError =
    bodyObj?.error && typeof bodyObj.error === "object"
      ? bodyObj.error
      : Array.isArray(bodyObj?.errors) && typeof bodyObj.errors[0] === "object"
      ? bodyObj.errors[0]
      : bodyObj;

  // Extract internal code: prefer recognized codes if present in candidates
  let internalCode = null;
  for (const recognized of [3040, 3036, 5004, 3006]) {
    if (candidateCodes.has(recognized)) {
      internalCode = recognized;
      break;
    }
  }
  if (internalCode === null) {
    const rawInternalCode =
      error.internalCode ??
      error.code ??
      cause.internalCode ??
      cause.code ??
      bodyError?.internalCode ??
      bodyError?.code ??
      null;
    const numInternalCode = typeof rawInternalCode === "number" ? rawInternalCode : Number(rawInternalCode);
    internalCode = Number.isFinite(numInternalCode) ? numInternalCode : null;
  }

  // Extract httpStatus
  const rawHttpStatus =
    error.httpStatus ??
    error.status ??
    error.statusCode ??
    cause.httpStatus ??
    cause.status ??
    cause.statusCode ??
    bodyError?.status ??
    bodyError?.statusCode ??
    null;
  const numHttpStatus = typeof rawHttpStatus === "number" ? rawHttpStatus : Number(rawHttpStatus);
  const httpStatus = Number.isFinite(numHttpStatus) ? numHttpStatus : null;

  // Extract upstreamCode
  let upstreamCode = null;
  for (const c of ["overloaded", "capacity_exceeded", "capacity_exhausted", "rate_limit_exceeded"]) {
    if (candidateCodes.has(c)) {
      upstreamCode = c;
      break;
    }
  }
  if (!upstreamCode) {
    upstreamCode =
      error.upstreamCode ??
      cause.upstreamCode ??
      bodyError?.upstreamCode ??
      (typeof error.code === "string" ? error.code : null) ??
      (typeof cause.code === "string" ? cause.code : null);
  }

  // Extract message
  const message =
    error.message ||
    cause.message ||
    bodyError?.message ||
    bodyObj?.message ||
    "Upstream AI service error";

  // Extract Retry-After from direct property, cause, body, or headers
  let rawRetryAfter =
    error.retryAfter ??
    cause.retryAfter ??
    bodyError?.retryAfter ??
    null;

  if (!rawRetryAfter) {
    const headersList = [error.headers, cause.headers, bodyObj?.headers];
    for (const h of headersList) {
      if (!h) continue;
      if (typeof h.get === "function") {
        rawRetryAfter = h.get("retry-after") ?? h.get("Retry-After");
      } else if (typeof h === "object") {
        for (const [k, v] of Object.entries(h)) {
          if (/^retry-?after$/i.test(k)) {
            rawRetryAfter = v;
            break;
          }
        }
      }
      if (rawRetryAfter) break;
    }
  }

  return {
    message,
    httpStatus,
    internalCode,
    upstreamCode: upstreamCode ?? null,
    candidateCodes,
    candidateStatuses,
    retryAfter: sanitizeRetryAfter(rawRetryAfter)
  };
}

/**
 * Determine if an error represents recognized capacity exhaustion / overload.
 */
function isCapacityOverloaded(normalized) {
  // 1. Any candidate code matches 3040
  if (normalized.candidateCodes?.has(3040) || normalized.internalCode === 3040) {
    return true;
  }

  // 2. HTTP status 529
  if (normalized.candidateStatuses?.has(529) || normalized.httpStatus === 529) {
    return true;
  }

  // 3. Explicit overload / capacity-exhausted error code
  for (const c of ["overloaded", "overloaded_error", "capacity_exceeded", "capacity_exhausted", "at capacity"]) {
    if (normalized.candidateCodes?.has(c)) {
      return true;
    }
  }

  // 4. HTTP 503 + positive capacity wording (Point 3)
  if (normalized.candidateStatuses?.has(503) || normalized.httpStatus === 503) {
    const msg = (normalized.message || "").toLowerCase();

    // Reject negation / judgment phrases: "not a capacity problem", "no capacity issues detected"
    if (
      /\bnot\s+(?:a\s+)?capacity\s+(?:issues?|problems?|errors?|faults?|warnings?)\b/i.test(msg) ||
      /\bno\s+capacity\s+(?:issues?|problems?|errors?|faults?|warnings?)\b/i.test(msg)
    ) {
      return false;
    }

    // Match positive phrases: overloaded, capacity exhausted/exceeded, at capacity, too many requests, no capacity available/left, out of capacity
    return /overloaded|overloaded_error|capacity exhausted|capacity exceeded|at capacity|too many requests|no capacity available|no capacity left|out of capacity/i.test(msg);
  }

  return false;
}

/**
 * Translate normalized upstream error into standard error Response.
 */
export function translateUpstreamError(error, aiBinding) {
  const normalized = normalizeUpstreamError(error);

  // 1. Overload / Capacity exhaustion -> 529 overloaded_error
  if (isCapacityOverloaded(normalized)) {
    return errorResponse(529, "overloaded_error", "overloaded", "Model overloaded.", null, normalized.retryAfter);
  }

  // 2. Recognized rate limit (code 3036, status 429, or candidate matches) -> 429 rate_limit_error
  if (
    normalized.candidateCodes?.has(3036) ||
    normalized.internalCode === 3036 ||
    normalized.candidateStatuses?.has(429) ||
    normalized.httpStatus === 429 ||
    normalized.candidateCodes?.has("rate_limit_exceeded")
  ) {
    return errorResponse(429, "rate_limit_error", "rate_limit_exceeded", "Rate limited upstream.", null, normalized.retryAfter);
  }

  // 3. Confirmed caller validation failures from upstream with named field path:
  // 5004 -> malformed image data
  if (normalized.candidateCodes?.has(5004) || normalized.internalCode === 5004) {
    const msg = normalized.message.startsWith("images: ") ? normalized.message : `images: ${normalized.message}`;
    return errorResponse(422, "invalid_request_error", "invalid_field", msg, "images");
  }

  // 3006 -> request too large
  if (normalized.candidateCodes?.has(3006) || normalized.internalCode === 3006) {
    const msg = normalized.message.startsWith("body: ") ? normalized.message : `body: ${normalized.message}`;
    return errorResponse(422, "invalid_request_error", "request_too_large", msg, "body");
  }

  // Strict prefix check for field path rewriting (Point 4):
  // Require message to START WITH exactly 'images: ' or 'body: ' (case-sensitive, includes colon+space)
  if (normalized.message.startsWith("images: ")) {
    return errorResponse(422, "invalid_request_error", "invalid_field", normalized.message, "images");
  }

  if (normalized.message.startsWith("body: ")) {
    return errorResponse(422, "invalid_request_error", "invalid_field", normalized.message, "body");
  }

  // Upstream 422 without strict prefix keeps 422 with param: null
  if (normalized.candidateStatuses?.has(422) || normalized.httpStatus === 422) {
    return errorResponse(422, "invalid_request_error", "invalid_field", normalized.message, null);
  }

  // 4. Ambiguous failures / everything else -> 502 api_error upstream_error with param: null
  return errorResponse(502, "api_error", "upstream_error", "Upstream model call failed.", null);
}

/**
 * Evaluate request handler for /v1/systemone, /clef/v1/systemone, /clef-flash/v1/systemone.
 */
async function evaluate(request, env, pathname) {
  const bodyResult = await readBoundedJson(request);
  if (bodyResult.error) {
    return bodyResult.error;
  }
  const body = bodyResult.data;

  let selectedModel;
  try {
    selectedModel = validateBody(body, pathname);
  } catch (err) {
    if (err instanceof ValidationError) {
      return err.toResponse();
    }
    throw err;
  }

  const safeQuestions = Object.create(null);
  for (const [id, q] of getQuestionEntries(body.questions)) {
    Object.defineProperty(safeQuestions, id, {
      value: q,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }

  const input = { state: body.state, model: selectedModel, questions: safeQuestions };
  if (own(body, "images") && body.images !== undefined) {
    input.images = body.images;
  }
  const upstream = `@cf/cloudflare/${selectedModel}`;

  try {
    const result = await env.AI.run(upstream, input);
    return Response.json(result, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    return translateUpstreamError(err, env?.AI);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/healthz" && request.method === "GET") {
      return Response.json({ status: "ok" });
    }

    // Authentication applies to every other route, including unknown paths
    if (!(await authenticate(request, env))) {
      return errorResponse(401, "authentication_error", "invalid_api_key", "Missing or invalid API key", null);
    }

    if (pathname === "/healthz") {
      const res = errorResponse(405, "invalid_request_error", "method_not_allowed", "Method not allowed", null);
      res.headers.set("Allow", "GET");
      return res;
    }

    if (pathname === "/v1/models") {
      if (request.method !== "GET") {
        const res = errorResponse(405, "invalid_request_error", "method_not_allowed", "Method not allowed", null);
        res.headers.set("Allow", "GET");
        return res;
      }
      return Response.json(MODEL_LIST, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    }

    if (EVALUATION_PATHS.has(pathname)) {
      if (request.method !== "POST") {
        const res = errorResponse(405, "invalid_request_error", "method_not_allowed", "Method not allowed", null);
        res.headers.set("Allow", "POST");
        return res;
      }
      return await evaluate(request, env, pathname);
    }

    return errorResponse(404, "invalid_request_error", "not_found", "Not found", null);
  }
};
