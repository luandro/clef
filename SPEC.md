# SPEC — Jev-compatible clef / clef-flash API proxy (Cloudflare Worker)

Goal: drop-in replacement for the Jev (TypeSafe AI) System One API.
Client changes only the base URL and the API key. Paths, request bodies,
response bodies, and error shapes must be identical to Jev.

## Verified research facts

### Jev API
- Endpoints: `POST /v1/systemone` (evaluation), `GET /v1/models` (list models).
- Auth: `Authorization: Bearer <API_KEY>` on every request.
- Request: `{state, model, questions}` — all three required.
- `state`: string, object, or array (any JSON value).
- `model`: `jev-latest`, `jev-preview`, or versioned `jev-1.13.0`.
- `questions`: map of id to question, 1–64 entries, ids match
  `^[A-Za-z0-9_.-]{1,100}$`.
- Question types and answers:
  - noul: `{type:"noul", instructions, criteria?}` →
    `{type:"noul", noul: 0..1}` — single number, no confidence field.
  - choice: `{type:"choice", instructions, criteria}` where criteria is a
    map of option → description (1–255 options) →
    `{type:"choice", choice, probabilities, confidence}`.
  - score: `{type:"score", instructions, criteria}` where criteria is an
    ordered array of level descriptions (2–64 levels) →
    `{type:"score", score, legend, probabilities, confidence}`.
- Response: `{model, answers, usage:{input_tokens, output_tokens}}`.
- Errors: 401 invalid key, 422 body validation failure (names the offending
  field), 429 rate limit (honor retry-after), 529 overloaded.
- Images are a clef extension: `images: [{data: base64, mime}]`, max 4
  images, whole-body cap 13 MiB.

## Cloudflare clef / clef-flash
- Workers AI models `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`.
- They speak the same System One request/response shape natively.
  Live-verified response from `cf ai run @cf/cloudflare/clef`:
  `{"model":"clef","answers":{"urgent":{"type":"noul","noul":0.9709}}, "usage":{"input_tokens":363,"output_tokens":0}}`
- Worker-native call path is `env.AI.run(model, body)`; no account id needed.
- REST equivalent:
  `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef`
  with the same body and Bearer auth.

## Model mapping (proxy behavior)
- `jev-latest`, `jev-preview`, `jev-1.13.0`, any `jev-1.x` versioned id → clef.
- `clef` → clef. `clef-flash` → clef-flash (explicit selection).
- Anything else → 422 with invalid-model error.
- The proxy must accept the Jev model names verbatim so existing clients
  keep working; `clef` and `clef-flash` are accepted as explicit overrides.

## Design

One Worker serves both models. The `model` field selects the model; the URL
stays the same. A path-pinned variant forces the model regardless of body:
`POST /clef/v1/systemone` and `POST /clef-flash/v1/systemone`.

Routes:
- `POST /v1/systemone` — drop-in evaluation endpoint.
- `POST /clef/v1/systemone`, `POST /clef-flash/v1/systemone` — path-pinned.
- `GET /v1/models` — Jev-format model list (clef + clef-flash entries).
- `GET /healthz` — liveness, unauthenticated, no upstream call.

Handler flow for the evaluation endpoint:
1. Auth guard on all routes except /healthz.
2. Parse JSON body (reject > 13 MiB → 413-style 422).
3. Validate shape: state present; model maps; questions map 1–64 with valid
   ids; per-type shape checks (noul instructions; choice criteria map 1–255
   options; score criteria array 2–64 levels). Shape checks only — upstream
   stays the semantic authority.
4. Map model to `clef` or `clef-flash`, rewrite body.model.
5. Call env.AI.run(upstream, body).
6. Return upstream JSON verbatim as the response body. Upstream already
   reports `model` correctly ("clef" / "clef-flash"), so no response rewrite
   is needed.
7. Upstream throw → Jev-style error JSON. Any upstream failure maps to
   502 api_error with the upstream message, except validation errors we
   already catch locally.

## Auth
- CLEF_TOKEN is a Worker secret. Clients send it as `Authorization: Bearer <CLEF_TOKEN>`.
- Compare via SHA-256 of both sides plus constant-time byte compare.

## Config
- wrangler.jsonc: name `clef-proxy`, main `src/index.js`, `ai` binding named
  `AI`, workers.dev enabled, observability on.
- No runtime dependencies.

## Test plan
- Deploy canary first, then live-test, keep if green (workers.dev URL is the
  publish target).
- GET /v1/models with auth → 200, lists clef and clef-flash.
- POST /v1/systemone model=jev-latest, mixed noul/choice/score → 200; an
  answer for every question id; usage present; noul in [0,1]; choice.choice
  within criteria keys; probabilities keys match criteria keys.
- POST model=clef-flash → 200 and response.model == "clef-flash".
- Missing Authorization header → 401; wrong token → 401.
- Unknown model → 422; empty questions → 422; missing state → 422;
  score with a single level → 422; choice with 300 options → 422.
- Object state (structured) → 200.
- Path-pinned routes return the pinned model.
- GET /healthz → 200 no auth.

## Deliverables
- `src/index.js` — worker (routing, auth, validation, mapping, upstream, errors).
- `wrangler.jsonc`, `package.json`, `.gitignore`, `README.md`.
- Deployed workers.dev URL + CLEF_TOKEN recorded in `.env`.

## Decisions already made (do not re-litigate in review)
- Constant-time token compare via SHA-256 + byte compare: yes.
- Response passthrough with no rewrite: yes.
- Score levels 2–64: yes.
- Path pinning included: yes.
- First known good: 2026-10-04
