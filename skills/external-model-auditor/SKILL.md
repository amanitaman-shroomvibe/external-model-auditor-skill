---
name: external-model-auditor
description: Reliable audits with third-party models through OpenRouter chat APIs from any project. Use when the user asks to audit code, product logic, UX, SEO, security, legal/document quality, marketing strategy, business decisions, or skill quality with external models such as Claude Opus, Gemini, DeepSeek, Mistral, Qwen, or other non-local models; especially when context size, JSON formatting, multi-model synthesis, or project portability matter.
---

# External Model Auditor

Use this skill to run disciplined multi-model audits through OpenRouter without losing results to bad context selection, invalid JSON, project-specific assumptions, or model/provider quirks.

## Core Rules

1. Define one audit scope per pass: security, UX, product logic, SEO, legal quality, marketing strategy, model routing, deployment, or skill quality.
2. Prefer automatic model selection by task. Basic panel uses 3 ranked models; expanded panel uses 5 ranked models. Override with `--models` only when the user names exact models.
3. Use the bundled runner from the project root whenever possible. It is portable across projects and writes raw outputs, parsed results, Markdown, costs, context batches, and synthesis.
4. Choose output mode intentionally:
   - `--mode json` for code, security, tests, implementation findings.
   - `--mode markdown` for strategy, product direction, brand/marketing, or ambiguous business reviews.
5. Keep context targeted. Prefer `--files`/`--files-from` for critical files; use `--discover` only when the project is small or patterns are narrow.
6. Never send secrets, `.env`, credential files, personal lead data, or large generated folders.
7. Treat model findings as hypotheses. Implement only convergent or locally verified findings.
8. Save artifacts and cite them in the final answer.

## OpenRouter Ground Rules

The runner follows current OpenRouter behavior:

- Chat completions are sent to `https://openrouter.ai/api/v1/chat/completions`.
- Models are checked through `https://openrouter.ai/api/v1/models`.
- `response_format` is used only when requested or supported by model metadata.
- `provider.zdr` is optional via `--zdr`; do not force it when availability matters more than ZDR.
- Usage/cost from the completion body is persisted. Raw responses are also saved.

## Standard Commands

For portable shell snippets, set the runner path once:

```bash
AUDIT_RUNNER="${CODEX_HOME:-$HOME/.codex}/skills/external-model-auditor/scripts/run_openrouter_audit.mjs"
node "$AUDIT_RUNNER" --list-models opus
```

Model IDs change over time. Before important audits, confirm exact IDs with `--list-models <name>` and replace examples when needed.

Targeted JSON audit:

```bash
node "$AUDIT_RUNNER" \
  --title security-auth \
  --task security \
  --panel basic \
  --files app/api/auth/route.ts:20000,lib/auth.ts:18000,middleware.ts:10000 \
  --question "Audit only authentication and authorization. Cite concrete file-level evidence." \
  --out test-results/external-model-audits \
  --mode json \
  --structured auto
```

Large project with a file list:

```bash
rg --files | rg '^(app|lib|server|tests)/.*\\.(ts|tsx|py|md)$' > /tmp/audit-files.txt
node "$AUDIT_RUNNER" \
  --files-from /tmp/audit-files.txt \
  --question "Audit product logic only. Ignore styling and marketing." \
  --task code \
  --panel expanded \
  --maxTotalChars 90000 \
  --maxBatchChars 45000
```

Strategy/marketing audit:

```bash
node "$AUDIT_RUNNER" \
  --discover "*.md,*.tsx,*.html" \
  --question "Audit positioning and conversion strategy. Return prioritized recommendations." \
  --task marketing \
  --panel expanded \
  --mode markdown \
  --structured none
```

Find current model IDs:

```bash
node "$AUDIT_RUNNER" --list-models opus
node "$AUDIT_RUNNER" --list-models deepseek
node "$AUDIT_RUNNER" --list-tasks
```

## Automatic Model Panels

The runner fetches OpenRouter `/api/v1/models` on every audit run. It first discovers fresh candidates from the live catalog by model family and task direction, then merges them with `config/model_profiles.json`. This means newly released `latest`, `pro`, `max`, `coder`, `large`, or task-relevant models can enter the panel without editing the config.

Task profiles:

- `general`: broad artifact audit.
- `code`: coding, architecture, frontend/backend, tests.
- `security`: auth, privacy, secrets, compliance risk.
- `marketing`: ads, SEO, conversion, positioning, brand.
- `strategy`: product/business/monetization/roadmap.
- `ux`: UI, usability, landing pages, design quality.
- `legal`: legal/document/policy quality.
- `data`: analytics, attribution, dashboards, metrics.

Panel sizes:

- `--panel basic`: 3 models, default for normal audits.
- `--panel expanded`: 5 models, for important or high-uncertainty decisions.

If `--task` is omitted, the runner infers the task from `--question`. If no profile matches, it uses `general`.

Use `--rank-config path/to/model_profiles.json` to override the matrix for a company/project.

Use `--minContext N` to require a minimum context window when selecting fresh candidates. Default is `100000`.

## Runner Options That Prevent Common Failures

- `--mode markdown`: avoids JSON failures for high-level strategy audits.
- If `--mode` is omitted, the runner uses JSON for `code`, `security`, and `data`; Markdown for other task profiles.
- `--task` / `--panel`: automatically choose the best available model panel for the audit direction.
- `--models`: bypass automatic selection when exact models are required.
- `--structured auto`: asks for JSON Schema only when the live model catalog says `response_format` is supported; otherwise sends no `response_format` and relies on prompt + extraction/repair.
- `--structured none`: never sends `response_format`; safest fallback when a provider rejects structured-output parameters.
- `--relevance off`: use only when auditing non-code artifacts where file-level references are not expected.
- `--relevance strict`: use when every finding must cite supplied files.
- `--perFileChars`: default source excerpt size per file is `30000`.
- `--maxBatchChars`: splits context into smaller per-model requests.
- `--maxTokens` / `--repairTokens`: increase these when raw outputs show `finishReason: "length"` or malformed truncated JSON.
- `--repairInputChars`: controls how much raw model output is sent to the JSON repair pass.
- `--temperature`: controls model sampling, default `0.1`.
- `--zdr`: restricts routing to Zero Data Retention endpoints when privacy matters.
- `--require-parameters`: ask OpenRouter to route only to providers supporting requested parameters.

## Workflow

1. Inspect project structure and choose scope.
2. Build a file list with `rg --files`; exclude generated, dependency, secret, and binary files.
3. Run the external audit with the correct mode.
4. Open the generated `.md` and `.json`.
5. Verify findings locally against code, tests, build, rendered UI, docs, or business artifacts.
6. Implement only verified changes.
7. Rerun relevant local checks.

## Failure Handling

- Invalid JSON: rerun with `--structured none` or `--mode markdown`.
- Model unavailable: use `--list-models <name>` and replace the model ID.
- Context too large: lower `--maxTotalChars`, use `--maxBatchChars`, or replace `--discover` with a curated `--files-from`.
- Context unexpectedly missing: inspect `contextWarnings` in the JSON report; the runner records file and total-budget truncation.
- Generic findings: narrow `--question`; require specific inclusions/exclusions and file-level evidence.
- Valid but wrong-domain audit: rerun with `--relevance strict` and a narrower file set.
- Strict relevance accepts either full paths or basenames with concrete evidence; Markdown mode also respects strict relevance.
- Provider rejects parameters: remove `--require-parameters`, use `--structured none`, or switch model.

See `references/protocol.md` for detailed guardrails and prompt patterns.
