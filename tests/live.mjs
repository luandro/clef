#!/usr/bin/env node

/**
 * tests/live.mjs — Post-deployment live acceptance test suite for clef-proxy.
 *
 * Usage:
 *   CLEF_URL=https://clef-proxy.<subdomain>.workers.dev CLEF_TOKEN=<token> node tests/live.mjs
 */

const baseUrl = process.env.CLEF_URL?.replace(/\/+$/, "");
const token = process.env.CLEF_TOKEN;

if (!baseUrl || !token) {
  console.error("Error: CLEF_URL and CLEF_TOKEN environment variables must be set.");
  console.error("Usage: CLEF_URL=https://<worker-url> CLEF_TOKEN=<secret> node tests/live.mjs");
  process.exit(1);
}

let passedCount = 0;
let failedCount = 0;

async function runCheck(name, fn) {
  try {
    process.stdout.write(`Running: ${name} ... `);
    await fn();
    console.log("PASS");
    passedCount++;
  } catch (err) {
    console.log(`FAIL\n  -> ${err.message}`);
    failedCount++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

async function main() {
  console.log(`\n=== Running Clef Live Acceptance Suite against ${baseUrl} ===\n`);

  // 1. Health check without authentication
  await runCheck("Health check (GET /healthz without auth)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.status === "ok", `Expected status: "ok", got ${JSON.stringify(json)}`);
  });

  // 2. Authentication check
  await runCheck("Authentication guard (missing token -> 401)", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "hi", model: "clef", questions: {} })
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    const json = await res.json();
    assert(json.error?.code === "invalid_api_key", `Expected invalid_api_key, got ${json.error?.code}`);
  });

  await runCheck("Authentication guard (wrong token -> 401)", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token-value",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ state: "hi", model: "clef", questions: {} })
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // 3. Models endpoint
  await runCheck("Models list (GET /v1/models with auth)", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.object === "list" || Array.isArray(json.models), "Missing list structure");
    const list = json.data || json.models;
    assert(Array.isArray(list) && list.length >= 2, "Expected at least 2 models");
    const names = list.map(m => m.name);
    assert(names.includes("clef"), "clef model missing");
    assert(names.includes("clef-flash"), "clef-flash model missing");
    for (const m of list) {
      assert(m.name && m.description && m.release_date, `Model entry missing fields: ${JSON.stringify(m)}`);
    }
  });

  // 4. Mixed request using jev-latest
  await runCheck("Mixed request using jev-latest (noul, choice, score)", async () => {
    const body = {
      model: "jev-latest",
      state: "Customer reported credit card billing failure. They are frustrated.",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Is this inquiry urgent?"
        },
        category: {
          type: "choice",
          instructions: "Select the department",
          criteria: {
            billing: "Invoices and card charges",
            tech: "Server or API errors",
            general: "Other inquiries"
          }
        },
        severity: {
          type: "score",
          instructions: "Rate customer frustration level",
          criteria: ["Calm", "Annoyed", "Frustrated", "Extremely angry"]
        }
      }
    };

    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.model === "clef", `Expected model: "clef", got ${json.model}`);
    assert(json.answers && typeof json.answers === "object", "Missing answers object");

    // A4: answers must have EXACTLY the sent question ids
    const sentIds = Object.keys(body.questions).sort();
    const answerIds = Object.keys(json.answers).sort();
    assert(
      JSON.stringify(answerIds) === JSON.stringify(sentIds),
      `Answers keys (${answerIds.join(",")}) must exactly equal sent question IDs (${sentIds.join(",")})`
    );

    // A4: both usage.input_tokens and usage.output_tokens must be present numbers
    assert(
      json.usage &&
      typeof json.usage.input_tokens === "number" &&
      typeof json.usage.output_tokens === "number",
      "Both usage.input_tokens and usage.output_tokens must be present numbers"
    );

    // Noul assertions: number in [0, 1], no confidence field
    const noulAns = json.answers.is_urgent;
    assert(noulAns && noulAns.type === "noul", "Missing noul answer");
    assert(typeof noulAns.noul === "number" && noulAns.noul >= 0 && noulAns.noul <= 1, "noul value not in [0, 1]");
    assert(noulAns.confidence === undefined, "noul should not have confidence field");

    // Choice assertions: option belongs to criteria, probabilities in [0, 1], confidence in [0, 1]
    const choiceAns = json.answers.category;
    assert(choiceAns && choiceAns.type === "choice", "Missing choice answer");
    const criteriaKeys = Object.keys(body.questions.category.criteria).sort();
    assert(criteriaKeys.includes(choiceAns.choice), `Invalid choice: ${choiceAns.choice}`);
    assert(choiceAns.probabilities, "Missing choice probabilities");

    // A4: choice probabilities keys must exactly equal criteria keys
    const probKeys = Object.keys(choiceAns.probabilities).sort();
    assert(
      JSON.stringify(probKeys) === JSON.stringify(criteriaKeys),
      `Choice probabilities keys (${probKeys.join(",")}) must exactly equal criteria keys (${criteriaKeys.join(",")})`
    );

    let probSum = 0;
    for (const opt of criteriaKeys) {
      const p = choiceAns.probabilities[opt];
      assert(typeof p === "number" && p >= 0 && p <= 1, `Invalid probability for ${opt}: ${p}`);
      probSum += p;
    }
    assert(Math.abs(probSum - 1.0) < 0.05, `Probability sum not approximately 1.0: ${probSum}`);
    assert(typeof choiceAns.confidence === "number" && choiceAns.confidence >= 0 && choiceAns.confidence <= 1, "Invalid choice confidence");

    // Score assertions: score in [0, levels - 1], probabilities cover all levels
    const scoreAns = json.answers.severity;
    assert(scoreAns && scoreAns.type === "score", "Missing score answer");
    const levelsCount = body.questions.severity.criteria.length;
    assert(typeof scoreAns.score === "number" && scoreAns.score >= 0 && scoreAns.score <= levelsCount - 1, `Score not in [0, ${levelsCount - 1}]: ${scoreAns.score}`);
    assert(scoreAns.legend && typeof scoreAns.legend === "object", "Missing score legend");
    assert(scoreAns.probabilities && typeof scoreAns.probabilities === "object", "Missing score probabilities");

    // A4: legend and probabilities keys must be EXACTLY the strings '0'..String(n-1) (no extra, none missing)
    const expectedScoreKeys = Array.from({ length: levelsCount }, (_, i) => String(i)).sort();
    const actualLegendKeys = Object.keys(scoreAns.legend).sort();
    const actualProbKeys = Object.keys(scoreAns.probabilities).sort();
    assert(
      JSON.stringify(actualLegendKeys) === JSON.stringify(expectedScoreKeys),
      `Score legend keys (${actualLegendKeys.join(",")}) must be exactly '0'..String(n-1) (${expectedScoreKeys.join(",")})`
    );
    assert(
      JSON.stringify(actualProbKeys) === JSON.stringify(expectedScoreKeys),
      `Score probabilities keys (${actualProbKeys.join(",")}) must be exactly '0'..String(n-1) (${expectedScoreKeys.join(",")})`
    );

    // every probability value a number in [0,1], legend values strings equal to the criteria entries sent
    for (let i = 0; i < levelsCount; i++) {
      const k = String(i);
      const probVal = scoreAns.probabilities[k];
      assert(
        typeof probVal === "number" && probVal >= 0 && probVal <= 1,
        `Score probability value for '${k}' must be number in [0, 1], got: ${probVal}`
      );
      const legVal = scoreAns.legend[k];
      const sentCriteria = body.questions.severity.criteria[i];
      assert(
        typeof legVal === "string" && legVal === sentCriteria,
        `Score legend value for '${k}' must be string equal to criteria entry ("${sentCriteria}"), got: "${legVal}"`
      );
    }
    assert(typeof scoreAns.confidence === "number" && scoreAns.confidence >= 0 && scoreAns.confidence <= 1, "Invalid score confidence");
  });

  // 5. Explicit clef-flash selection
  await runCheck("Explicit clef-flash request", async () => {
    const body = {
      model: "clef-flash",
      state: "Quick status verification",
      questions: {
        quick_check: { type: "noul", instructions: "Is status ok?" }
      }
    };
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.model === "clef-flash", `Expected model: "clef-flash", got ${json.model}`);
  });

  // 6. Path pinning
  await runCheck("Path pinning: /clef/v1/systemone forces clef", async () => {
    const res = await fetch(`${baseUrl}/clef/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef-flash", // Body requests clef-flash, but path forces clef
        state: "Testing pin",
        questions: { q: { type: "noul", instructions: "test" } }
      })
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.model === "clef", `Expected model to be pinned to "clef", got ${json.model}`);
  });

  await runCheck("Path pinning: /clef-flash/v1/systemone forces clef-flash", async () => {
    const res = await fetch(`${baseUrl}/clef-flash/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "jev-latest", // Body requests jev-latest (clef), but path forces clef-flash
        state: "Testing pin",
        questions: { q: { type: "noul", instructions: "test" } }
      })
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.model === "clef-flash", `Expected model to be pinned to "clef-flash", got ${json.model}`);
  });

  // 7. Structured state, array state, and structured instructions/criteria
  await runCheck("Structured state (object) and structured instructions/criteria values", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: { user: "alice", action: "refund", items: [1, 2, 3] },
        questions: {
          structured_q: {
            type: "choice",
            instructions: { context: "Review user history", rule: "Only recent purchases" },
            criteria: {
              approved: { text: "Approve refund", risk: "low" },
              denied: { text: "Deny refund", risk: "high" }
            }
          }
        }
      })
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.answers?.structured_q, "Missing answer for structured instructions/criteria");
  });

  await runCheck("Array state acceptance", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: ["audit_log", { event_id: 101, severity: "high" }, [1, 2, 3]],
        questions: {
          requires_attention: { type: "noul", instructions: "Does this event require human attention?" }
        }
      })
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const json = await res.json();
    assert(json.answers?.requires_attention, "Missing answer for array state check");
  });

  // 8. Validation rejection checks
  await runCheck("Validation: Unknown model -> 422 invalid_model", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "unknown-model",
        state: "test",
        questions: { q: { type: "noul", instructions: "test" } }
      })
    });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
    const json = await res.json();
    assert(json.error?.code === "invalid_model", `Expected invalid_model, got ${json.error?.code}`);
  });

  await runCheck("Validation: Missing state -> 422 missing_field", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        questions: { q: { type: "noul", instructions: "test" } }
      })
    });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
    const json = await res.json();
    assert(json.error?.code === "missing_field" && json.error?.param === "state");
  });

  await runCheck("Validation: Empty questions -> 422 invalid_field", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: "test",
        questions: {}
      })
    });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
  });

  await runCheck("Validation: Single score level -> 422 invalid_field", async () => {
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: "test",
        questions: {
          bad_score: {
            type: "score",
            instructions: "Rate",
            criteria: ["Single level"]
          }
        }
      })
    });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
  });

  await runCheck("Validation: Choice with 300 options -> 422 invalid_field", async () => {
    const crit = {};
    for (let i = 0; i < 300; i++) crit[`opt_${i}`] = `Description ${i}`;
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: "test",
        questions: {
          too_many: {
            type: "choice",
            instructions: "Choose",
            criteria: crit
          }
        }
      })
    });
    assert(res.status === 422, `Expected 422, got ${res.status}`);
  });

  // 9. Boundary limits: 64 score levels
  await runCheck("Limits: Maximum 64 score levels", async () => {
    const lv64 = Array.from({ length: 64 }, (_, i) => `Level ${i}`);
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: "Testing max 64 score levels",
        questions: {
          deep_score: {
            type: "score",
            instructions: "Evaluate score",
            criteria: lv64
          }
        }
      })
    });
    assert(res.status === 200, `Expected 200 for 64 score levels, got ${res.status}`);
  });

  await runCheck("Limits: Explicit clef-flash with 64 score levels", async () => {
    const lv64 = Array.from({ length: 64 }, (_, i) => `Flash Level ${i}`);
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef-flash",
        state: "Testing max 64 score levels on clef-flash",
        questions: {
          flash_score: {
            type: "score",
            instructions: "Evaluate score flash",
            criteria: lv64
          }
        }
      })
    });
    assert(res.status === 200, `Expected 200 for clef-flash 64 score levels, got ${res.status}`);
    const json = await res.json();
    assert(json.model === "clef-flash", `Expected model: "clef-flash", got ${json.model}`);
    assert(json.answers?.flash_score, "Missing answer for clef-flash 64 score levels");
  });

  // 10. Images smoke test
  await runCheck("Images extension smoke test (tolerant: 200 or 422 recorded)", async () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const res = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "clef",
        state: "Inspect image pixels",
        questions: {
          is_dark: { type: "noul", instructions: "Is the image dark?" }
        },
        images: [{ mime: "image/png", data: tinyPng }]
      })
    });

    if (res.status === 200) {
      const json = await res.json();
      assert(json.answers?.is_dark, "Missing answer for image test");
      console.log(" [Images supported (200)]");
    } else if (res.status === 422) {
      const json = await res.json();
      console.log(` [Images returned 422: ${json.error?.code || "unsupported"} - recorded outcome, not failing run]`);
    } else {
      throw new Error(`Unexpected status for images smoke test: ${res.status}`);
    }
  });

  console.log(`\n=== Live Suite Complete: ${passedCount} passed, ${failedCount} failed ===\n`);
  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unexpected live test error:", err);
  process.exit(1);
});
