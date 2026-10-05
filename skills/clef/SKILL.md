---
name: clef
description: >
  Call clef/clef-flash — the Jev-compatible System One API proxy on Cloudflare
  Workers (base URL https://clef-proxy.mangadl.workers.dev) — instead of the
  Jev (TypeSafe AI) API. Use when a task needs typed decisions: noul
  (yes/no probability), choice (pick one option with probabilities), or score
  (probability-weighted rating) over text or JSON state. Use when the user
  says "Jev", "TypeSafe", "System One", "typed decision", "noul/choice/score",
  asks to classify, route, rate or gate something programmatically, or has
  code or skills that call api.typesafe.ai. Also use to find and migrate
  existing Jev calls or Jev skills to this proxy.
license: MIT
---

# clef — Jev-compatible typed decisions on Cloudflare

`clef` and `clef-flash` (Cloudflare Workers AI models) behind a
Jev-compatible proxy. A client that called the Jev API keeps working with
only two changes: the base URL and the API key. Paths, request bodies,
response bodies, and error statuses match the Jev System One API.

Official Jev docs: https://docs.typesafe.ai (Markdown: append `.md` to a
page path). The proxy implements the same System One contract. When this
skill and the live docs disagree on Jev semantics, trust the live docs for
Jev semantics and this skill for the proxy's differences (below).

## Endpoint and auth

- Base URL: `https://clef-proxy.mangadl.workers.dev`
- Auth: `Authorization: Bearer $CLEF_TOKEN` on every request.
- The token lives in this repo's `.env` (`CLEF_TOKEN=...`) and in
  `~/.agents`-visible repos as needed; source it, never hardcode it:

```sh
set -a; source /path/to/clef/repo/.env; set +a
```

- Token rotation: edit `CLEF_TOKEN` in the repo's `.env`, then redeploy the
  Worker (README §Deployment) — the upload replaces the secret.

## Calling it

`POST {base}/v1/systemone` with `{state, model, questions}` — all three
required. `state` is any JSON value (string, object, array). `model`:

| Send | Served by |
| --- | --- |
| `jev-latest`, `jev-preview`, `jev-1.x.y` | clef |
| `clef` | clef (explicit) |
| `clef-flash` | clef-flash (explicit, faster) |
| anything else | 422 invalid_model |

Path pins force the model regardless of the body:
`POST {base}/clef/v1/systemone` → clef,
`POST {base}/clef-flash/v1/systemone` → clef-flash.
`GET {base}/v1/models` lists both. `GET {base}/healthz` is unauthenticated.

## Question types and answers

Questions map id → question; 1–64 per request, ids `[A-Za-z0-9_.-]{1,100}`.
Answers come back under the same ids in `answers`, with
`usage: {input_tokens, output_tokens}` at the top level.

- **noul** — `{type: "noul", instructions: "yes/no question"}`
  (optional `criteria: {true: "...", false: "..."}`) →
  `{type: "noul", noul: 0.0..1.0}`. A single probability, no confidence.
- **choice** — `{type: "choice", instructions, criteria: {option: description}}`
  (1–255 options) → `{type: "choice", choice, probabilities, confidence}`.
  `probabilities` keys equal the criteria keys.
- **score** — `{type: "score", instructions, criteria: [level descriptions]}`
  (2–10 levels on this proxy — see caveats) →
  `{type: "score", score, legend, probabilities, confidence}`. `legend` and
  `probabilities` are keyed by level index as strings ("0", "1", …).

Optional `images` (clef extension, absent from Jev): array of max 4 entries,
each a `data:image/png;base64,...` string or
`{content_type: "image/png", base64: "..."}`; 4 MiB per image, 8 MiB total
decoded; whole body ≤ 13 MiB.

## curl example

```sh
curl -sS "$CLEF_URL/v1/systemone" \
  -H "Authorization: Bearer $CLEF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Checkout has been failing for every customer for the last hour.",
    "model": "jev-latest",
    "questions": {
      "urgent":  {"type": "noul",  "instructions": "Is this urgent?"},
      "team":    {"type": "choice", "instructions": "Which team?",
                  "criteria": {"billing": "Payments", "technical": "Outages"}},
      "severity": {"type": "score", "instructions": "How severe?",
                   "criteria": ["No impact", "Minor", "Major", "Critical"]}
    }
  }'
```

## Caveats vs the real Jev API

1. **Score levels: 2–10, not 2–64.** Upstream clef rejects more than 10
   score levels (upstream 422s; live-verified 2026-10-04). The proxy
   rejects 11+ locally with 422 before spending the upstream call. If a
   migrated Jev question uses more than 10 levels, split it into several
   questions or merge levels.
2. **Error bodies are the proxy envelope.** Statuses match Jev
   (401 invalid key, 422 validation, 429 rate limit, 529 overloaded, 502
   upstream) and every error body has
   `{error: {type, code, message, param}}`, but byte-parity with Jev's
   exact error JSON is unverified.
3. **The response `model` field reports `clef` or `clef-flash`**, never a
   `jev-x.y.z` version. Log it, don't parse it as a Jev version.
4. **`/v1/models` `release_date`** is the proxy's verification date
   (2026-10-04), not an official Cloudflare release date.
5. **Answers/limits otherwise identical**: choice ≤ 255 options, ids ≤ 100
   chars, 64 questions max, usage always present.

## Finding and migrating existing Jev calls

When asked to migrate Jev usage to this proxy (or when you discover Jev
calls while working):

1. Search for Jev usage. In skills and code:
   `grep -rli 'api.typesafe.ai\|TYPESAFE_API_KEY\|jev-latest\|jev-preview\|v1/systemone'`
   over the relevant directories (for example `~/.agents/skills`,
   `~/.claude/skills`, the current repo).
2. Repoint, changing only two things:
   - base URL: `https://api.typesafe.ai` → the proxy base URL
   - key env var: `TYPESAFE_API_KEY` → `CLEF_TOKEN`
   Leave `model` strings like `jev-latest` untouched — the proxy maps them.
3. Check every migrated `score` question: more than 10 criteria levels will
   now 422 (caveat 1) — split or merge levels before migrating.
4. If the code reads the response `model` field expecting a `jev-` version
   (caveat 3), adjust that comparison.
5. Smoke-test one real request before declaring the migration procedure
   complete.

## Installing this skill (~/.agents and ~/.claude)

Canonical store: `~/.agents/skills/`. `~/.claude/skills` is a symlink to
`~/.agents/skills`, so installing there serves both (and any other agent
reading the open Agent Skills standard).

```sh
# from this repo
ln -s "$PWD/skills/clef" ~/.agents/skills/clef
readlink ~/.claude/skills          # verify the ~/.claude symlink is intact
ls ~/.claude/skills/clef/SKILL.md  # verify visibility
```

If `~/.claude/skills` is not a symlink to `~/.agents/skills`, fix that first
per the open Agent Skills standard (directory symlink, never a copy).

## Checking for an existing Jev skill (setup-time check)

Before creating a new skill, check whether a Jev or TypeSafe skill already
exists and adjust it instead of duplicating:

```sh
grep -rli 'api.typesafe.ai\|TYPESAFE_API_KEY\|jev-latest' ~/.agents/skills/ 2>/dev/null
```

- No hits — install this skill fresh (section above).
- Hits that only USE Jev (call `api.typesafe.ai`) — repoint them to the
  proxy per "Finding and migrating existing Jev calls"; keep this skill too
  as the proxy reference.
- A full Jev skill (documents the Jev API itself) — repoint its base URL and
  key, add this proxy's caveats section to it, and link to this skill.
