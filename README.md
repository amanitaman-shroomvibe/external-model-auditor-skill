# External Model Auditor Skill

Codex skill for reliable external audits through OpenRouter. It selects fresh models from the live OpenRouter catalog, runs task-specific audit panels, normalizes JSON or Markdown output, filters unsupported findings, and writes reproducible audit artifacts.

## What It Does

- Audits code, security, marketing, UX, legal, data, strategy, and general project work.
- Uses OpenRouter Chat Completions with `OPENROUTER_API_KEY` from the environment.
- Refreshes model metadata at each run instead of relying only on a static model list.
- Builds basic 3-model and expanded 5-model panels by task.
- Supports JSON or Markdown audit modes.
- Preserves raw model outputs for debugging while rejecting findings that cite files outside the supplied context.
- Warns when context was truncated, so audit confidence is explicit.

## Install

Copy the skill folder into your Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R skills/external-model-auditor "$HOME/.codex/skills/external-model-auditor"
```

Set your OpenRouter key before running audits:

```bash
export OPENROUTER_API_KEY="..."
```

## Usage

Trigger the skill in Codex with requests such as:

- "Audit this project with external models"
- "Run a 5-model security audit"
- "Review this marketing strategy through OpenRouter"
- "Audit this skill with the best current models"

The bundled runner can also be used directly:

```bash
node skills/external-model-auditor/scripts/run_openrouter_audit.mjs \
  --prompt "Audit for correctness, security, and missing tests." \
  --files src/index.ts \
  --task code \
  --panel expanded
```

## Repository Layout

```text
skills/
  external-model-auditor/
    SKILL.md
    agents/openai.yaml
    config/model_profiles.json
    references/protocol.md
    scripts/run_openrouter_audit.mjs
```

Generated audit outputs are intentionally excluded from this repository.

## License

MIT
