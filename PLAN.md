Implementation plan based on [SPEC.md](/home/luandro/Dev/AI/clef/SPEC.md). No project files were edited and no deployment was performed.

### 1. File-by-file breakdown

| File | Implementation |
|---|---|
| `src/index.js` | One ES module containing routing, authentication, bounded JSON parsing, validation, model mapping, upstream invocation, and error translation. Export pure helpers for testing alongside the default Worker handler. |
| `wrangler.jsonc` | Requested configuration: Worker name, entrypoint, compatibility date, AI binding, workers.dev, observability. |
| `cloudflare.config.ts` | Required addition for deployment through `cf`. Generated from Wrangler configuration, then reviewed. Supports separate canary and production names. |
| `wrangler.config.ts` | Generated build configuration when migrating with the Wrangler bundler. |
| `package.json` | `"private": true`, `"type": "module"`, no runtime dependencies. Development dependencies: Vitest, `cf`, and compatible Wrangler. Scripts: `test`, `dev`, `deploy:check`, `deploy:canary`, `deploy`. |
| `package-lock.json` | Pin development tooling versions. |
| `tests/validation.test.js` | Request and question validation boundaries. |
| `tests/models.test.js` | Model aliases, unknown models, path precedence. |
| `tests/worker.test.js` | Direct handler tests using `Request`, `Response`, Web Crypto, and mocked `env.AI.run`. |
| `tests/errors.test.js` | Upstream error normalization and status translation. |
| Existing `tests/fixtures/clef-req.json`, `clef-resp.json` | Reuse as request and response fixtures; do not assert exact probabilities in live tests. |
| `tests/live.mjs` | Explicitly invoked post-deployment checks; reads URL/token from environment. Never runs during `npm test`. |
| `.gitignore` | Preserve existing entries; ignore `.env`, `.dev.vars`, secret files, `node_modules`, `.wrangler`, `.cloudflare`, coverage. |
| `README.md` | API examples, supported models, limits, error contract, deployment and acceptance commands. |

Initial `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "clef-proxy",
  "main": "src/index.js",
  "compatibility_date": "2026-10-04",
  "ai": { "binding": "AI" },
  "workers_dev": true,
  "observability": { "enabled": true }
}
```

Do not put either token in configuration.

Suggested `src/index.js` sections, in implementation order:

1. Constants: body limit, question ID pattern, upstream model names, model metadata.
2. `errorResponse(status, type, code, message, param = null, retryAfter)`.
3. `authenticate(request, env)`.
4. `readBoundedJson(request)`.
5. Pure shape helpers and `validateBody(body, pathname)`.
6. `resolveModel(pathname, body)`.
7. `normalizeUpstreamError(error, aiBinding)` and `translateUpstreamError`.
8. `evaluate(request, env, pathname)`.
9. Default `fetch` router.

Handler flow:

```js
async function fetch(request, env) {
  const pathname = new URL(request.url).pathname;

  if (pathname === "/healthz" && request.method === "GET")
    return Response.json({ status: "ok" });

  // Applies to every other route, including unknown paths.
  if (!(await authenticate(request, env)))
    return unauthorized();

  if (pathname === "/v1/models") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return Response.json(MODEL_LIST);
  }

  if (EVALUATION_PATHS.has(pathname)) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return await evaluate(request, env, pathname);
  }

  return notFound();
}
```

Use exact pathname matching. Query parameters do not select models. Unknown paths return authenticated 404; unsupported methods return authenticated 405 with `Allow`.

Authentication:

```js
// Missing/empty CLEF_TOKEN must fail closed.
const match = request.headers.get("Authorization")
  ?.match(/^Bearer ([^\s]+)$/i);

if (!match || !env.CLEF_TOKEN) return false;

const supplied = await sha256(match[1]);
const expected = await sha256(env.CLEF_TOKEN);

let difference = 0;
for (let i = 0; i < 32; i++)
  difference |= supplied[i] ^ expected[i];

return difference === 0;
```

Hash both strings with `crypto.subtle.digest`; compare all 32 bytes without early return. Authentication precedes body reading.

`GET /v1/models` uses the Jev SDK envelope:

```json
{
  "models": [
    {
      "name": "clef",
      "description": "Cloudflare Clef decision model",
      "release_date": "<verified YYYY-MM-DD>"
    },
    {
      "name": "clef-flash",
      "description": "Cloudflare Clef Flash decision model",
      "release_date": "<verified YYYY-MM-DD>"
    }
  ]
}
```

The official SDK requires `name`, `description`, and `release_date`. Verify the release dates before filling these constants; SPEC’s “first known good” date is not a model release date. [SDK response schemas](https://docs.typesafe.ai/sdk/python/api/types/responses)

### 2. Validation and error contract

SPEC and the official API reference establish HTTP statuses but do not establish one exact error envelope. Use the following concrete proxy envelope, which the official SDK can parse. Byte-for-byte equality with Jev’s actual error bodies remains **UNVERIFIED**. [Official SDK error parser](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/errors.ts)

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_field",
    "message": "questions.severity.criteria: expected 2–64 levels",
    "param": "questions.severity.criteria"
  }
}
```

Always include all four error properties; `param` is a string for validation errors and `null` otherwise. Return `Content-Type: application/json` and `Cache-Control: no-store`.

| Status | `type` | `code` | Trigger |
|---|---|---|---|
| 401 | `authentication_error` | `invalid_api_key` | Missing, malformed, or incorrect Bearer token |
| 422 | `invalid_request_error` | `invalid_json` | Empty body or invalid JSON; `param: "body"` |
| 422 | `invalid_request_error` | `request_too_large` | More than 13 MiB; `param: "body"` |
| 422 | `invalid_request_error` | `missing_field` | Required property absent |
| 422 | `invalid_request_error` | `invalid_field` | Wrong shape, type, count, or question ID |
| 422 | `invalid_request_error` | `invalid_model` | Unsupported model on the unpinned endpoint |
| 429 | `rate_limit_error` | `rate_limit_exceeded` | Recognized upstream rate/quota limit |
| 529 | `overloaded_error` | `overloaded` | Recognized upstream capacity exhaustion |
| 502 | `api_error` | `upstream_error` | Other upstream failures, preserving SPEC’s fallback |

Authentication response:

```json
{
  "error": {
    "type": "authentication_error",
    "code": "invalid_api_key",
    "message": "Missing or invalid API key",
    "param": null
  }
}
```

Return only the first validation failure, using a deterministic order: body → state → model → questions → question entries → images. Include the field path in both `message` and `param`.

#### Bounded body reading

```js
MAX_BODY_BYTES = 13 * 1024 * 1024; // 13,631,488

// Content-Length is only an early rejection optimization.
if (validContentLengthHeader > MAX_BODY_BYTES)
  fail422("body", "request_too_large", "body exceeds 13 MiB");

reader = request.body?.getReader();
total = 0;
chunks = [];

while (reader) {
  const { done, value } = await reader.read();
  if (done) break;

  total += value.byteLength;
  if (total > MAX_BODY_BYTES) {
    await reader.cancel();
    fail422("body", "request_too_large", "body exceeds 13 MiB");
  }

  chunks.push(value);
}

// Decode accumulated bytes with fatal UTF-8 decoding, then JSON.parse.
// Decode/parse failure -> 422 invalid_json.
```

Count actual stream bytes even without `Content-Length`. Do not call `request.json()` before enforcing the limit. Reject exactly `MAX + 1`; accept exactly `MAX` at the size-check stage.

#### Shape helpers

```js
const own = (value, key) => Object.hasOwn(value, key);

const record = value =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);

const entry = value =>
  value === null ||
  typeof value === "string" ||
  record(value) ||
  Array.isArray(value);
```

Structured instructions and criteria are supported by Jev; a string-only validator would break compatible clients. The official documentation differs on null support, so this plan accepts null entries as documented in its advanced guide. [Structured question fields](https://docs.typesafe.ai/primitives/advanced)

#### Exact local rules

| Field | Rule |
|---|---|
| Body | Non-null object; arrays and primitives rejected |
| `state` | Must be an own property. Follow SPEC’s “any JSON value” wording: accept string, object, array, number, boolean, and null |
| `model` | Own property, string; required on pinned routes too |
| `questions` | Own property, non-null object, 1–64 own entries |
| Question ID | `^[A-Za-z0-9_.-]{1,100}$` |
| Each question | Non-null object |
| `question.type` | Own property; exactly `noul`, `choice`, or `score` |
| `question.instructions` | Own property; satisfies `entry()` |
| Noul `criteria` | Optional; omitted or null accepted. Otherwise object containing only `true` and/or `false`; each supplied value satisfies `entry()` |
| Choice `criteria` | Required object, 1–255 own options; every description satisfies `entry()` |
| Score `criteria` | Required array, 2–64 levels; every level satisfies `entry()` |
| Extra fields | Preserve and forward; upstream remains semantic authority |

For choice option names, do not apply the question ID regex or invent additional limits.

For text/structured entries, do not require nonempty strings, trim values, reorder arrays, serialize objects into strings, or reject nested JSON types.

Validation pseudocode:

```js
requireRecord(body, "body");
requireOwn(body, "state");

requireOwn(body, "model");
requireString(body.model, "model");
const selected = resolveModel(pathname, body);

requireRecord(body.questions, "questions");
requireCount(Object.keys(body.questions), 1, 64, "questions");

for (const [id, question] of Object.entries(body.questions)) {
  const field = `questions.${id}`;

  requireId(id);
  requireRecord(question, field);
  requireOwn(question, "type", field);
  requireEnum(question.type, ["noul", "choice", "score"], `${field}.type`);

  requireOwn(question, "instructions", field);
  requireEntry(question.instructions, `${field}.instructions`);

  if (question.type === "noul") {
    if (own(question, "criteria") && question.criteria !== null) {
      requireRecord(question.criteria, `${field}.criteria`);

      for (const [key, value] of Object.entries(question.criteria)) {
        requireEnum(key, ["true", "false"], `${field}.criteria.${key}`);
        requireEntry(value, `${field}.criteria.${key}`);
      }
    }
  }

  if (question.type === "choice") {
    requireRecord(question.criteria, `${field}.criteria`);
    requireCount(Object.keys(question.criteria), 1, 255, `${field}.criteria`);

    for (const [option, value] of Object.entries(question.criteria))
      requireEntry(value, `${field}.criteria.${option}`);
  }

  if (question.type === "score") {
    requireArray(question.criteria, `${field}.criteria`);
    requireCount(question.criteria, 2, 64, `${field}.criteria`);

    question.criteria.forEach((value, index) =>
      requireEntry(value, `${field}.criteria.${index}`));
  }
}

validateImagesIfPresent(body);
return selected;
```

Use `Object.entries` and `Object.hasOwn`, avoiding prototype-dependent checks. IDs such as `constructor` and `__proto__` satisfy the specified regex and must not corrupt object handling.

For optional `images`:

- Require an array of 0–4 objects.
- Require nonempty `data` containing standard base64 image bytes; reject URLs and `data:` prefixes.
- Require `mime` to be `image/png`, `image/jpeg`, or `image/webp`.
- Validate base64 characters/padding and decoded byte length.
- Reject more than 4 MiB decoded per image or 8 MiB decoded total.
- Leave file decoding and the 16-megapixel limit to upstream; no image library is needed.

Cloudflare documents these additional image limits. [Clef image schema](https://developers.cloudflare.com/workers-ai/models/clef/)

### 3. Model mapping and upstream handling

Define supported legacy aliases narrowly; do not map every arbitrary `jev-*` string.

```js
const LEGACY_VERSION = /^jev-1\.\d+(?:\.\d+)?$/;

function mapBodyModel(model) {
  if (
    model === "jev-latest" ||
    model === "jev-preview" ||
    LEGACY_VERSION.test(model)
  ) return "clef";

  if (model === "clef" || model === "clef-flash")
    return model;

  fail422("model", "invalid_model", "model: unsupported model");
}

function resolveModel(pathname, body) {
  // Presence and string type already validated.
  // Check pins before validating the body model's supported value.
  if (pathname === "/clef/v1/systemone")
    return "clef";

  if (pathname === "/clef-flash/v1/systemone")
    return "clef-flash";

  return mapBodyModel(body.model);
}
```

The regex accepts `jev-1.13` and `jev-1.13.0`; it rejects `jev-2.0.0`, `jev-foo`, whitespace, and suffixes.

Pinned-route behavior:

| Path | Body model | Selection |
|---|---|---|
| `/v1/systemone` | `jev-preview` | Clef |
| `/v1/systemone` | `clef-flash` | Clef Flash |
| `/v1/systemone` | `unknown` | 422 |
| `/clef/v1/systemone` | `clef-flash` or `unknown` | Clef |
| `/clef-flash/v1/systemone` | `jev-latest` or `unknown` | Clef Flash |
| Either pinned path | Missing or non-string model | 422, preserving SPEC’s required request shape |

Upstream invocation:

```js
const selected = validateBody(body, pathname);
const input = { ...body, model: selected };
const upstream = `@cf/cloudflare/${selected}`;

try {
  const result = await env.AI.run(upstream, input);
  return Response.json(result);
} catch (error) {
  return translateUpstreamError(error, env.AI);
}
```

Success passthrough means no application-level response transformation. Preserve every response property, including model, answers, probabilities, usage, and future fields. JSON whitespace need not match upstream bytes.

#### Error translation

Normalize structured error information before classifying:

```js
{
  httpStatus,    // Distinct from Cloudflare's internal numeric code
  internalCode,
  upstreamCode,
  message,
  retryAfter
}
```

Inspect known fields on the thrown object and structured cause/body. Treat unfamiliar shapes as unclassified. Do not assume `error.status` exists or interpret a number embedded in a message as an HTTP status.

Classification order:

1. Internal code `3040` → 529 overloaded, even though Cloudflare represents this as HTTP 429.
2. Recognized HTTP 529, or a confirmed capacity-related 503 → 529.
3. Internal code `3036`, or recognized HTTP 429 without capacity classification → 429.
4. Confirmed request-validation failures, including malformed image data (`5004`) or request too large (`3006`) → 422.
5. Everything else → 502 `api_error` with the upstream message, as SPEC requires.

Cloudflare documents separate internal and HTTP error codes, including quota and capacity errors sharing HTTP 429. [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/)

Only map upstream validation failures when evidence identifies a caller-input problem. An upstream missing-model error or account/binding authorization failure is a proxy/provider problem; it must not become client 401 or invalid-model 422.

Forward a valid available `Retry-After` value on 429/529. If the binding does not expose it, omit the header; do not invent a delay. No automatic Worker retries in this first version.

### 4. Test matrix

Local Vitest tests use an injected mock binding:

```js
const env = {
  CLEF_TOKEN: "test-token",
  AI: { run: vi.fn() }
};

await worker.fetch(request, env);
```

| Area | Local cases and assertions |
|---|---|
| Auth | Missing header, wrong scheme, empty token, wrong token, correct token, missing configured secret; unauthorized requests never invoke AI or read the body |
| Routing | All exact routes; unknown paths; wrong methods; `Allow`; query strings; unauthenticated health with no AI call |
| JSON/body cap | Empty/malformed JSON, root primitive/null/array; exact cap and cap+1; missing/misleading Content-Length; multibyte UTF-8; reader cancellation on overflow |
| Required fields | Missing state/model/questions; falsy state values preserved; missing versus null distinguished |
| Question counts | 0, 1, 64, 65 |
| IDs | Length 1/100/101; allowed punctuation; spaces/slashes/Unicode rejected; prototype-like IDs safely forwarded |
| Common fields | Each type; missing/unknown type; missing instructions; string/object/array/null entries; number/boolean instructions rejected |
| Noul | Omitted/null/empty criteria; true-only/false-only/both; bad container; unknown outcome key; bad description |
| Choice | 0/1/255/256 options, including the specified 300-option rejection; structured/null descriptions; bad container/value |
| Score | 0/1/2/64/65 levels; preserve order and duplicates; structured/null levels; bad container/value |
| Images | Omitted, empty, 4/5 images; MIME/base64 errors; decoded size boundaries and total size |
| Mapping | All aliases, version regex boundaries, explicit models, unknown model; both conflicting and unknown body values under both pins |
| Upstream call | Exactly one call, correct qualified model, rewritten `body.model`, all other fields preserved; input not mutated |
| Success | Deep equality with fixture; no model rewrite; `output_tokens: 0` retained |
| Errors | Codes 3040/3036/5004/3006; available status/header variants; string/Error/plain-object throws; unknown failures remain 502; no false client 401 |
| Concurrency | Concurrent Clef/Clef Flash requests retain separate selections and responses |

Post-deployment live tests:

| Check | Acceptance |
|---|---|
| Health | 200 without authentication; no inference |
| Models | 200 with token; both entries parse using Jev metadata schema |
| Mixed request using `jev-latest` | 200; response model `clef`; exactly one answer per requested ID; usage present |
| Explicit `clef-flash` | 200; response model `clef-flash` |
| Pins | Conflicting body selection produces the pinned model on each path |
| Structured inputs | Object/array state and structured instructions/criteria reach real inference successfully |
| Noul response | Number in `[0,1]`; no added confidence field |
| Choice response | Selected option belongs to criteria; probability keys match options; finite probabilities/confidence in `[0,1]` |
| Score response | Score in `[0, levels−1]`; legend/probability keys cover all levels; confidence in `[0,1]` |
| Invalid requests | Specified missing auth/wrong token → 401; unknown model, empty questions, missing state, one score level, 300 options → field-specific 422 |
| Limits | Oversized body → local 422; 64 score levels exercised against both real models |
| Image extension | Small valid image succeeds; structurally invalid image returns 422 |
| Real Jev client | Change base URL and key only; evaluate and list models through an official SDK |

Use a rounding tolerance when checking probability sums. Do not assert a particular model decision.

Quota/capacity translation is mock-tested locally. Record it as live **UNVERIFIED** unless a real relevant failure is observed; do not exhaust quota or overload the service merely to trigger it.

### 5. Deployment through `cf`

These are implementation-stage instructions, not commands executed during this review.

1. Install and pin tooling. The installed CLI inspected here is `cf 1.0.0-beta.6`; rediscover commands if the implementation uses another version.

   ```sh
   npm install --save-dev cf@latest wrangler@latest vitest@latest

   cf cli search "migrate project"
   cf cli search "deploy worker"
   cf cli search "add worker secret"
   ```

2. Migrate before running `cf dev`, `cf build`, or `cf deploy`.

   ```sh
   cf migrate wrangler.jsonc --bundler wrangler --dry-run
   cf migrate wrangler.jsonc --bundler wrangler
   ```

   Review generated `cloudflare.config.ts`, `wrangler.config.ts`, and package changes. Resolve migration TODOs; confirm the AI binding, observability, entrypoint, date, and workers.dev settings.

   The migration retains `wrangler.jsonc`. Treat generated cf configuration as authoritative for cf deployment. A dirty worktree can block migration; preserve existing work and use the documented `--force` only after reviewing its scope. No commit is needed solely for migration. [Migration documentation](https://developers.cloudflare.com/cf/wrangler/migrate/)

3. Add mode-dependent Worker names to generated configuration:

   ```js
   name: mode === "canary" ? "clef-proxy-canary" : "clef-proxy"
   ```

   Both modes need `AI` and `CLEF_TOKEN` bindings. Declare the latter with `bindings.secret()`, and keep its value outside configuration. [cf configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)

4. Load deployment credentials from the existing `.env`, without printing them:

   ```sh
   set +x
   set -a
   source ./.env
   set +a

   : "${CLOUDFLARE_ACCOUNT_ID:?missing account ID}"
   : "${CLOUDFLARE_API_TOKEN:?missing API token}"
   ```

   This assumes `.env` contains shell-compatible assignments. The Cloudflare API token authenticates deployment; `CLEF_TOKEN` authenticates proxy clients. Do not bind Cloudflare deployment credentials into the Worker. [cf unattended authentication](https://developers.cloudflare.com/cf/ci/)

5. Generate a separate client token and a secret-only deployment file:

   ```sh
   umask 077
   CLEF_TOKEN="$(openssl rand -hex 32)"
   export CLEF_TOKEN

   printf 'CLEF_TOKEN=%s\n' "$CLEF_TOKEN" > .clef-secrets.env
   ```

   This creates a 256-bit random token. Ignore `.clef-secrets.env`. After successful acceptance, update the ignored `.env` with exactly one `CLEF_TOKEN` assignment and the deployed URL.

6. Ensure the account has a registered workers.dev subdomain. Use the existing subdomain; if none exists, register one in Cloudflare Dashboard → Workers & Pages. CLI search did not identify a reliable registration command in the inspected version, so do not invent one. The URL is:

   ```text
   https://clef-proxy-canary.<account-subdomain>.workers.dev
   ```

   Setting `workers_dev: true` enables the Worker route; it does not replace account subdomain setup. [workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

7. Test and deploy the canary with the secret included in the initial deployment:

   ```sh
   npm test
   cf deploy --mode canary --dry-run
   cf deploy --mode canary --secrets-file .clef-secrets.env
   ```

   `--secrets-file` accepts dotenv or JSON. Pass the secret-only file, never the credential-containing `.env`.

8. For later explicit secret updates, the discovered command is:

   ```sh
   cf workers secrets update CLEF_TOKEN \
     --worker clef-proxy-canary \
     --type secret_text \
     --text "$CLEF_TOKEN"
   ```

   Prefer deployment with `--secrets-file` for initial setup and rotation alongside a deployment. Confirm the updated secret is active with an authenticated request.

9. Run `tests/live.mjs` against the canary. Deploy production only after acceptance:

   ```sh
   cf deploy --mode production --dry-run
   cf deploy --mode production --secrets-file .clef-secrets.env
   ```

   Repeat health, authentication, mixed inference, Flash, and pin checks against the production URL.

### 6. Risks and gotchas

- **Error compatibility:** The proposed envelope is concrete and SDK-readable; exact equality with Jev’s error bodies remains unverified. SPEC’s blanket 502 mapping also needs the explicit rate/capacity exceptions above to deliver the requested 429/529 behavior.
- **Validation compatibility:** SPEC says state accepts any JSON value, while Jev’s reference describes string/object/array. This plan follows SPEC. Score remains 2–64 as already decided, despite Jev documentation describing a smaller maximum.
- **Binding error shapes:** REST envelopes do not prove `AI.run` exception structure. Capture safe status/code metadata from canary failures and add fixtures. Avoid logging whole errors, request bodies, images, or authorization headers.
- **Token limits:** Both Cloudflare models advertise a 65,536-token context, and their schema says long text state can be truncated. Body bytes are not token counts. Do not implement character-based token estimates or promise oversized state always produces 422. [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- **Body limit:** Enforce 13 MiB in the proxy. Cloudflare’s platform limit is larger and plan-dependent; requests rejected by the edge before Worker execution can return platform 413 instead of proxy JSON. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- **Memory:** Bounded streaming limits intake, but decoded strings, parsed JSON, image data, and upstream serialization create additional copies. Avoid cloning the request or logging its body.
- **Deployment readiness:** A direct CLI inference fixture proves model access for that call, not deployed binding behavior. The Worker URL, secret binding, both model targets, and actual Jev SDK interoperability need live acceptance.
- **workers.dev:** Account registration and Worker route enablement are separate. Preserve the account’s existing subdomain; obtain the actual deployment URL from output rather than guessing.

Implementation order: configuration and fixtures → pure validators/mapping → authentication/router/upstream adapter → local tests → canary deployment → live acceptance → production deployment.

### 7. Decisions during implementation

- **Envelope superset decision (`/v1/models`):** Returns both `data: [...]` and `models: [...]` within `{ object: "list", data, models }`. This superset structure satisfies OpenAI-compatible model listing clients while preserving exact compatibility with Jev SDK variants that expect `.models`.
- **Release date decision (`release_date`):** Set to `'2026-10-04'`, corresponding to the date the Clef and Clef Flash models were live-verified through Workers AI. This avoids unverified claims of historical model release dates while providing a valid ISO 8601 YYYY-MM-DD string required by SDK consumers.
- **Proxy-defined error envelope:** The 4-field error envelope (`{ error: { type, code, message, param } }`) documented in Section 2 is proxy-defined to ensure deterministic SDK error parsing. Exact byte-for-byte parity with Jev upstream error bodies remains pending post-deployment live acceptance.