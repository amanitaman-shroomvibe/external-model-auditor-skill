# External Model Audit Protocol

## Why Audits Fail

Common failure modes:

- too many unrelated files in one prompt;
- generated/dependency files consume the context budget;
- strict JSON schema used on a provider/model that rejects `response_format`;
- strategy audits forced into JSON even though Markdown would preserve useful reasoning;
- project-specific relevance checks reject valid audits from another project;
- repair prompts cause the model to rewrite substance;
- valid JSON contains generic findings with no evidence;
- raw outputs are not persisted, so failures cannot be debugged.

## OpenRouter API Facts

- Chat completions use `POST https://openrouter.ai/api/v1/chat/completions`.
- Request/response shape is OpenAI Chat Completions-like, with OpenRouter-specific fields such as `models`, `route`, `provider`, and usage/cost metadata.
- Model metadata is available at `GET https://openrouter.ai/api/v1/models`; use it to confirm current model IDs, context length, pricing, and supported parameters.
- Structured output can be requested with `response_format`.
- JSON Schema mode is useful but should be conditional. Use model metadata and fallback to prompt-only JSON if needed.
- Provider preferences can include `zdr: true` for Zero Data Retention routing, but this can reduce provider availability.
- Returned generation IDs can be queried later through `/api/v1/generation?id=<id>` when historical stats are needed.

## Context Budgets

Recommended totals:

- small audit: 10k-25k chars;
- normal audit: 25k-60k chars;
- large audit: 60k-120k chars split with `--maxBatchChars`.

Runner defaults:

- `--perFileChars 30000`;
- `--maxTotalChars 120000`;
- `--maxBatchChars 60000`;
- `--maxTokens 6000`;
- `--repairTokens 3500`.

The JSON report includes `contextWarnings` when a file or the total context is truncated.

Per-file defaults:

- route/service file: 12k-20k;
- core domain logic: 18k-25k;
- UI component: 10k-18k;
- test file: 8k-14k;
- config: 4k-8k;
- docs/strategy: 10k-20k.

If feedback is generic, the context is usually too broad or the question is too vague.

## File Selection

Prefer explicit files:

```bash
node ~/.codex/skills/external-model-auditor/scripts/run_openrouter_audit.mjs \
  --files app/api/route.ts:18000,lib/core.ts:22000,tests/core.test.ts:12000 \
  --question "Audit correctness only."
```

For larger projects:

```bash
rg --files | rg '^(app|lib|server|tests)/.*\\.(ts|tsx|py|md)$' > /tmp/audit-files.txt
```

Never include:

- `.env*`, credentials, tokens, private keys;
- `node_modules`, `.next`, `dist`, `build`, `coverage`;
- large binaries, lockfiles unless dependency resolution is the scope;
- personal user/lead data.

## Output Modes

Use JSON mode for:

- code correctness;
- security;
- tests;
- API behavior;
- deployment risk;
- implementation planning.

Use Markdown mode for:

- product strategy;
- brand/marketing;
- business model;
- legal/document quality;
- broad UX narrative;
- skill quality review when exact file evidence is less important.

If `--mode` is omitted, the runner chooses JSON for `code`, `security`, and `data`; Markdown for other task profiles.

## JSON Contract

The runner uses this contract in JSON mode:

```json
{
  "score": 0,
  "summary": "",
  "strengths": [],
  "findings": [
    {
      "severity": "critical|major|minor",
      "area": "",
      "issue": "",
      "evidence": "",
      "recommendation": "",
      "files": []
    }
  ],
  "scenarioVerdicts": [
    {
      "caseName": "",
      "expectedBehavior": "",
      "verdict": "pass|partial|fail|unclear",
      "risk": ""
    }
  ],
  "topFixes": [],
  "suggestedTests": []
}
```

Keep custom contracts small. Large schemas increase provider failures.

## Relevance Gate

Universal relevance should not depend on one project’s domain words.

Normal mode accepts audits when:

- findings cite supplied file paths or basenames; or
- findings contain concrete evidence strings; or
- Markdown output cites supplied file paths/basenames or includes concrete evidence terms.

Strict mode requires either full path or basename evidence plus concrete finding evidence. Markdown mode also respects strict relevance; it is not accepted only by length. Off mode is for strategy artifacts where file names are not meaningful.

## Repair Strategy

First try deterministic extraction:

- direct JSON parse;
- fenced JSON block;
- balanced-brace extraction.

Then repair once:

```text
The previous answer was not valid JSON or did not match the contract.
Do not add new analysis.
Do not change the substance.
Return only valid JSON matching this contract.
```

If repair still fails, do not keep burning calls. Switch to `--structured none` or `--mode markdown`.

If raw output has `finishReason: "length"` and malformed JSON such as `Unterminated string`, the output was truncated. Increase `--maxTokens` and `--repairTokens` before retrying.

If the first answer is valid JSON but fails the relevance gate, do not repair it. Record it as `relevance gate rejected valid JSON audit` so the user can inspect the raw audit and adjust `--relevance`, `--files`, or the prompt.

## Model Roles

Use automatic panels first:

```bash
node "$AUDIT_RUNNER" --task code --panel basic ...
node "$AUDIT_RUNNER" --task marketing --panel expanded ...
```

The runner fetches OpenRouter `/api/v1/models` on every audit run. It discovers fresh candidates from the live catalog by model family and task direction, then merges them with `config/model_profiles.json`. This gives stable automation without scraping dynamic leaderboard pages and still allows newly released models to enter panels automatically.

Panel sizes:

- `basic`: 3 models for normal work;
- `expanded`: 5 models for high-stakes or uncertain work.

Profile signals:

- OpenRouter live catalog for availability, context, supported parameters, and pricing;
- OpenRouter rankings/usage signal when available;
- LMArena/WebDev Arena and public benchmark summaries as category signal;
- Artificial Analysis-style intelligence/quality/performance signal when available;
- local experience from prior audits.

Balanced manual panel:

- strongest arbiter: current Claude Opus;
- independent systems reviewer: current Gemini Pro or another frontier model;
- challenger/cost reviewer: DeepSeek V4 Pro, Mistral Large, Qwen, or another strong non-OpenAI model.

Use `--list-models <name>` to confirm exact IDs before manual runs. Use `--rank-config` to override panels for a project.

Fresh-candidate rules prioritize current `latest`, `pro`, `max`, `coder`, `large`, DeepSeek V4, Claude Opus, Gemini Pro, Qwen, Mistral, Devstral, and Codestral families, filtered by text support and minimum context. Provider diversity is enforced before duplicate providers are allowed.

Some OpenRouter model IDs begin with `~`, for example `~anthropic/claude-opus-latest`; this is part of the actual model ID, not a skill-specific priority marker.

## Synthesis Rules

Treat a finding as implementation-ready only when:

- two or more models find it and local inspection confirms it;
- one model finds it and code/tests prove it;
- it is a low-risk test or documentation improvement.

Do not implement:

- broad rewrites without evidence;
- legal/security claims not grounded in sources;
- changes outside the requested scope;
- model suggestions that would expose private data externally.

## Artifact Naming

Runner outputs:

```text
test-results/external-model-audits/<title>-<timestamp>.json
test-results/external-model-audits/<title>-<timestamp>.md
test-results/external-model-audits/<title>-<timestamp>-raw/
```

Store:

- models and exact IDs;
- prompt question;
- mode and structured-output mode;
- files and char limits;
- context batches;
- parsed audit or Markdown;
- raw outputs and repair outputs;
- cost, latency, usage.
