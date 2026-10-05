# clef-proxy

A lightweight, zero-runtime-dependency Cloudflare Worker proxy that serves as a drop-in replacement for the Jev (TypeSafe AI) System One API, backed natively by Cloudflare Workers AI Clef (`@cf/cloudflare/clef`) and Clef Flash (`@cf/cloudflare/clef-flash`).

## Drop-in Usage

Existing Jev clients can switch to `clef-proxy` without code refactoring (error-byte parity and official-SDK interoperability are verified at acceptance; see Known caveats). Change only:
1. **Base URL**: Point to your deployed Worker (e.g. `https://clef-proxy.<subdomain>.workers.dev`).
2. **API Key**: Pass your configured `CLEF_TOKEN` as `Authorization: Bearer <CLEF_TOKEN>`.

### Known caveats

> [!NOTE]
> **Compatibility Qualification**: Error response bodies use the proxy's envelope with Jev-compatible HTTP statuses and standard 4-property structure (`type`, `code`, `message`, `param`), rather than an established Jev documented standard. Exact byte-parity with Jev error bodies and official-SDK interoperability are verified at live acceptance testing.

### Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/v1/systemone` | `POST` | Bearer | Drop-in evaluation endpoint. Model selected via request body. |
| `/clef/v1/systemone` | `POST` | Bearer | Pinned evaluation route: forces execution on `@cf/cloudflare/clef`. |
| `/clef-flash/v1/systemone` | `POST` | Bearer | Pinned evaluation route: forces execution on `@cf/cloudflare/clef-flash`. |
| `/v1/models` | `GET` | Bearer | List available models matching the Jev SDK envelope (`object: "list"`). |
| `/healthz` | `GET` | None | Liveness check returning `{"status":"ok"}`. |

---

## Supported Models

The proxy accepts standard Jev model aliases and explicit Clef model identifiers:

| Requested Model | Target Upstream Model | Description |
|---|---|---|
| `jev-latest` | `@cf/cloudflare/clef` | Latest stable Clef decision model |
| `jev-preview` | `@cf/cloudflare/clef` | Clef decision model |
| `jev-1.x` (`jev-1.13`, `jev-1.13.0`, etc.) | `@cf/cloudflare/clef` | Versioned legacy Jev 1.x models |
| `clef` | `@cf/cloudflare/clef` | Explicit Clef selection |
| `clef-flash` | `@cf/cloudflare/clef-flash` | Explicit fast Clef Flash selection |
| *Other / Unknown* | *Rejected (422)* | Unrecognized model names return `invalid_model` error |

*Note: On path-pinned routes (`/clef/v1/systemone` and `/clef-flash/v1/systemone`), the route dictates the model selection, but `model` must still be provided as a string.*

### Model Listing Envelope (`GET /v1/models`)

The `/v1/models` endpoint returns an envelope superset supporting both OpenAI-style and Jev SDK consumers:

```json
{
  "object": "list",
  "data": [
    {
      "name": "clef",
      "description": "Cloudflare Clef decision model",
      "release_date": "2026-10-04"
    },
    {
      "name": "clef-flash",
      "description": "Cloudflare Clef Flash decision model",
      "release_date": "2026-10-04"
    }
  ],
  "models": [
    {
      "name": "clef",
      "description": "Cloudflare Clef decision model",
      "release_date": "2026-10-04"
    },
    {
      "name": "clef-flash",
      "description": "Cloudflare Clef Flash decision model",
      "release_date": "2026-10-04"
    }
  ]
}
```

*Note on `release_date`*: The `release_date` field reflects the proxy's live-verification date (`2026-10-04`), not an official Cloudflare release date.

---

## Limits

| Resource | Constraint | Local Error Trigger |
|---|---|---|
| **Body Size** | Max 13 MiB (13,631,488 bytes) | 422 `request_too_large` |
| **Questions Count** | 1 to 64 questions per request | 422 `invalid_field` (`questions`) |
| **Question ID** | `^[A-Za-z0-9_.-]{1,100}$` | 422 `invalid_field` (`questions.<id>`) |
| **Choice Options** | 1 to 255 options | 422 `invalid_field` (`questions.<id>.criteria`) |
| **Score Levels** | 2 to 10 ordered levels (upstream clef caps at 10) | 422 `invalid_field` (`questions.<id>.criteria`) |
| **Images** | Max 4 images, PNG/JPEG/WebP (`[data-URL string \| {content_type, base64}]`) | 422 `invalid_field` (`images` or `images[i]`) |
| **Image Size** | Max 4 MiB decoded/image, 8 MiB total | 422 `invalid_field` (`images` or `images[i]`) |

---

## Error Contract

Errors are returned with `Content-Type: application/json` and `Cache-Control: no-store`. Every error response includes all four properties:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_field",
    "message": "questions.severity.criteria: expected 2-10 levels",
    "param": "questions.severity.criteria"
  }
}
```

| HTTP Status | `type` | `code` | Description | `param` |
|---|---|---|---|---|
| **401** | `authentication_error` | `invalid_api_key` | Missing, malformed, or invalid Bearer token | `null` |
| **422** | `invalid_request_error` | `invalid_json` | Empty body or invalid JSON syntax | `"body"` |
| **422** | `invalid_request_error` | `request_too_large` | Body exceeds 13 MiB limit | `"body"` |
| **422** | `invalid_request_error` | `missing_field` | Required property missing | `<field>` |
| **422** | `invalid_request_error` | `invalid_field` | Incorrect type, count, or ID format | `<field>` |
| **422** | `invalid_request_error` | `invalid_model` | Unsupported model on unpinned route | `"model"` |
| **429** | `rate_limit_error` | `rate_limit_exceeded` | Upstream rate or quota limit reached | `null` |
| **529** | `overloaded_error` | `overloaded` | Upstream capacity exhaustion (internal code 3040 / 529) | `null` |
| **502** | `api_error` | `upstream_error` | Other upstream Workers AI failures | `null` |

*Validation errors follow a deterministic evaluation order: `body` &rarr; `state` &rarr; `model` &rarr; `questions` &rarr; `question entries` &rarr; `images`.*

---

## cURL Examples

Replace `$CLEF_URL` and `$CLEF_TOKEN` with your deployment values.

### 1. Noul (Binary Probability)

A `noul` question evaluates likelihood and outputs a single float in `[0, 1]`:

```bash
curl -s -X POST "$CLEF_URL/v1/systemone" \
  -H "Authorization: Bearer $CLEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef",
    "state": "Customer has made 4 failed payment attempts in 10 minutes.",
    "questions": {
      "is_fraud_risk": {
        "type": "noul",
        "instructions": "Is this activity indicative of fraudulent card testing?"
      }
    }
  }'
```

### 2. Choice (Categorization)

A `choice` question selects from 1–255 options, returning the selected choice, full probabilities, and a confidence score:

```bash
curl -s -X POST "$CLEF_URL/v1/systemone" \
  -H "Authorization: Bearer $CLEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef",
    "state": "The server returned 502 Bad Gateway during high load.",
    "questions": {
      "routing": {
        "type": "choice",
        "instructions": "Which on-call engineer should be paged?",
        "criteria": {
          "database": "Database read/write latency issues",
          "infrastructure": "Cluster capacity and gateway proxies",
          "application": "Application code crashes and exceptions"
        }
      }
    }
  }'
```

### 3. Score (Graded Severity)

A `score` question evaluates an ordered array of 2–10 level descriptions (upstream clef caps at 10 levels), returning the expected score, legend, probabilities, and confidence:

```bash
curl -s -X POST "$CLEF_URL/v1/systemone" \
  -H "Authorization: Bearer $CLEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef",
    "state": "Checkout service is completely unresponsive for all regions.",
    "questions": {
      "incident_severity": {
        "type": "score",
        "instructions": "Rate incident severity",
        "criteria": [
          "SEV-4: Minor non-customer impact",
          "SEV-3: Partial degraded performance",
          "SEV-2: Significant impact with workarounds",
          "SEV-1: Critical outage, total loss of core service"
        ]
      }
    }
  }'
```

### 4. Multimodal (Images Extension)

Requests may include an optional `images` array (max 4 images, PNG/JPEG/WebP) formatted as `[data-URL string | {content_type, base64}]`:

```bash
curl -s -X POST "$CLEF_URL/v1/systemone" \
  -H "Authorization: Bearer $CLEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef",
    "state": "Inspect UI screenshot for layout bugs.",
    "questions": {
      "has_overflow": {
        "type": "noul",
        "instructions": "Does the UI contain visible text or element overflow?"
      }
    },
    "images": [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      {
        "content_type": "image/jpeg",
        "base64": "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
      }
    ]
  }'
```

---

## Deployment

Deployed 2026-10-04 as a single Worker, `clef-proxy`, at
`https://clef-proxy.mangadl.workers.dev` (both models, selected by the
request's `model` field; no separate canary/production modes).

```bash
# Verify configuration without deploying
npm run deploy:check            # cf deploy --dry-run

# Deploy (uploads the Worker and the secrets in the file)
cf deploy --secrets-file .clef-secrets.env

# Live acceptance against the deployed Worker
CLEF_URL=https://clef-proxy.mangadl.workers.dev \
CLEF_TOKEN="$(grep '^CLEF_TOKEN=' .clef-secrets.env | cut -d= -f2)" \
node tests/live.mjs
```

`.clef-secrets.env` (gitignored) holds the client token in `.env` format;
`.env` also carries `CLEF_TOKEN`. Rotating the token: change it in `.env`,
copy to `.clef-secrets.env`, redeploy with `--secrets-file` — the upload
replaces the secret.

### Prerequisites
Before running deployment:
1. **Migration (`cf migrate`)**: Run `cf migrate wrangler.jsonc --bundler wrangler` to generate and verify `cloudflare.config.ts` and `wrangler.config.ts`.
2. **Mode-dependent worker names**: Configure distinct worker names in `cloudflare.config.ts` for canary (`clef-proxy-canary`) and production (`clef-proxy`).
3. **Secret binding (`CLEF_TOKEN`)**: Ensure `CLEF_TOKEN` is provisioned as an encrypted secret binding in Cloudflare Workers environment (e.g. via `cf secret put CLEF_TOKEN` or `--secrets-file`).

### Local Testing

Run all unit and mock tests with Vitest:

```bash
npm test
```

### Re-deploying and rotating the token

```bash
# Change CLEF_TOKEN in .env, then:
grep '^CLEF_TOKEN=' .env > .clef-secrets.env
cf deploy --secrets-file .clef-secrets.env
CLEF_URL=https://clef-proxy.mangadl.workers.dev \
CLEF_TOKEN="$(grep '^CLEF_TOKEN=' .clef-secrets.env | cut -d= -f2)" \
node tests/live.mjs
```

### Live Acceptance Verification

The acceptance suite (`tests/live.mjs`) runs real inference on both models
and is the post-deploy gate. It consumes `CLEF_URL` and `CLEF_TOKEN`.
