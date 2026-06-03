#!/usr/bin/env node
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const DEFAULT_MODELS = [
  "anthropic/claude-opus-4.8",
  "google/gemini-3.1-pro-preview",
  "deepseek/deepseek-v4-pro",
]

const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".venv",
  "__pycache__",
  "vendor",
  "tmp",
  "logs",
]

const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "number", description: "0 to 100 quality score for the audited artifact." },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          area: { type: "string" },
          issue: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
        required: ["severity", "area", "issue", "evidence", "recommendation", "files"],
      },
    },
    scenarioVerdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          caseName: { type: "string" },
          expectedBehavior: { type: "string" },
          verdict: { type: "string", enum: ["pass", "partial", "fail", "unclear"] },
          risk: { type: "string" },
        },
        required: ["caseName", "expectedBehavior", "verdict", "risk"],
      },
    },
    topFixes: { type: "array", items: { type: "string" } },
    suggestedTests: { type: "array", items: { type: "string" } },
  },
  required: ["score", "summary", "strengths", "findings", "scenarioVerdicts", "topFixes", "suggestedTests"],
}

const CONTRACT_TEXT = JSON.stringify({
  score: "number from 0 to 100",
  summary: "short audit summary grounded in the provided project",
  strengths: ["specific strengths found in the provided context"],
  findings: [
    {
      severity: "critical|major|minor",
      area: "audit area",
      issue: "specific issue",
      evidence: "file/function/branch evidence from provided context",
      recommendation: "concrete fix",
      files: ["relative/path"],
    },
  ],
  scenarioVerdicts: [
    {
      caseName: "tested scenario",
      expectedBehavior: "expected behavior",
      verdict: "pass|partial|fail|unclear",
      risk: "risk if any",
    },
  ],
  topFixes: ["ordered implementation tasks"],
  suggestedTests: ["specific tests to add or update"],
}, null, 2)

const args = parseArgs(process.argv.slice(2))

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  if (args.help || args.h) {
    printHelp()
    return
  }

  await loadEnvChain(args.env)

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured. Pass --env, set environment, or create .env.local/.env.")
  }

  if (args["list-models"]) {
    await listModels(args["list-models"])
    return
  }

  const modelCatalog = await getModelCatalog().catch(() => null)
  const modelMeta = Object.fromEntries((modelCatalog?.data ?? []).map((model) => [model.id, model]))
  const profileConfig = await loadModelProfiles(args["rank-config"])
  if (args["list-tasks"]) {
    console.log(Object.keys(profileConfig.profiles ?? {}).join("\n"))
    return
  }
  const selectedPanel = args.panel ?? profileConfig.default_panel ?? "basic"
  const selectedTask = args.task ?? inferTask(args.question ?? "", profileConfig)
  const panelSize = Number(profileConfig.panel_sizes?.[selectedPanel] ?? (selectedPanel === "expanded" ? 5 : 3))
  const models = splitCsv(args.models).length
    ? splitCsv(args.models)
    : selectModelsForTask({ task: selectedTask, panel: selectedPanel, profileConfig, modelMeta, modelCatalog })
  const mode = args.mode ?? (["code", "security", "data"].includes(selectedTask) ? "json" : "markdown")
  const structured = args.structured ?? "auto"
  const relevance = args.relevance ?? "normal"
  const title = slug(args.title ?? "external-model-audit")
  const outDir = args.out ?? "test-results/external-model-audits"
  const question = args.question ?? "Audit the provided artifact. Give concrete findings with file-level evidence."
  const maxTotalChars = Number(args.maxTotalChars ?? 120_000)
  const maxBatchChars = Number(args.maxBatchChars ?? 60_000)
  const maxFiles = Number(args.maxFiles ?? 80)
  const discoveredFiles = await resolveFiles({ maxFiles })
  if (!discoveredFiles.length) {
    throw new Error("No files selected. Use --files, --files-from, or --discover.")
  }

  const contextBuild = await buildContextBatches(discoveredFiles, maxTotalChars, maxBatchChars)
  const batches = contextBuild.batches
  for (const warning of contextBuild.warnings) console.warn(`context-warning: ${warning}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const results = []

  await mkdir(outDir, { recursive: true })
  const rawDir = path.join(outDir, `${title}-${stamp}-raw`)
  await mkdir(rawDir, { recursive: true })

  if (!splitCsv(args.models).length) {
    console.log(`auto-models task=${selectedTask} panel=${selectedPanel}: ${models.join(",")}`)
  }

  for (const model of models.slice(0, Number(args.maxModels ?? panelSize))) {
    const supports = modelMeta[model]?.supported_parameters ?? []
    const result = await runModelAudit(model, question, batches, {
      mode,
      structured,
      supports,
      relevance,
      maxTokens: Number(args.maxTokens ?? 6000),
      repairTokens: Number(args.repairTokens ?? 3500),
      repairInputChars: Number(args.repairInputChars ?? args.maxBatchChars ?? 70_000),
      temperature: Number(args.temperature ?? 0.1),
      providerPrefs: buildProviderPrefs(),
      timeoutMs: Number(args.timeoutMs ?? 120_000),
      rawDir,
    })
    results.push(result)
    console.log(`${model}: ${result.ok ? `ok ${result.audit ? `score=${result.audit.score}` : "markdown"}` : `failed ${result.error}`}`)
    await wait(Number(args.delayMs ?? 500))
  }

  const report = {
    generatedAt: new Date().toISOString(),
    title,
    question,
    mode,
    structured,
    relevance,
    task: selectedTask,
    panel: selectedPanel,
    modelSelection: {
      source: splitCsv(args.models).length ? "explicit" : "live-openrouter-catalog-plus-profile",
      catalogFetchedAt: new Date().toISOString(),
      profileUpdated: profileConfig.updated ?? null,
      rankConfig: args["rank-config"] ?? "bundled config/model_profiles.json",
    },
    models,
    files: discoveredFiles,
    batches: batches.map((batch) => ({ index: batch.index, contextChars: batch.context.length, files: batch.files })),
    maxTotalChars,
    maxBatchChars,
    contextWarnings: contextBuild.warnings,
    results,
    synthesis: synthesize(results),
    sources: {
      openrouterDocs: [
        "https://openrouter.ai/docs/api/reference/overview",
        "https://openrouter.ai/docs/guides/features/structured-outputs",
        "https://openrouter.ai/docs/guides/overview/models",
        "https://openrouter.ai/docs/guides/routing/provider-selection",
      ],
    },
  }

  const jsonPath = path.join(outDir, `${title}-${stamp}.json`)
  const mdPath = path.join(outDir, `${title}-${stamp}.md`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2))
  await writeFile(mdPath, makeMarkdown(report))

  console.log(JSON.stringify({ jsonPath, mdPath, rawDir, ok: results.filter((result) => result.ok).length, total: results.length }, null, 2))
}

async function runModelAudit(model, question, batches, options) {
  const started = Date.now()
  const batchResults = []

  for (const batch of batches) {
    const prompt = makePrompt(question, batch.context, options.mode, batches.length > 1 ? batch.index : null)
    const first = await chat(model, prompt, options)
    await writeRaw(options.rawDir, model, `batch-${batch.index}-first`, first)

    const parsed = options.mode === "markdown" ? null : extractJson(first.content)
    const validAudit = parsed && coerceAudit(parsed)
    if (first.ok && isAccepted({ audit: validAudit, markdown: first.content, mode: options.mode, relevance: options.relevance, files: batch.files })) {
      batchResults.push({
        batch: batch.index,
        ok: true,
        status: first.status,
        ms: Date.now() - started,
        costUsd: first.costUsd,
        usage: first.usage,
        audit: validAudit,
        markdown: options.mode === "markdown" ? first.content : null,
      })
      continue
    }

    if (first.ok && validAudit) {
      batchResults.push({
        batch: batch.index,
        ok: false,
        status: first.status,
        ms: Date.now() - started,
        costUsd: first.costUsd,
        usage: first.usage,
        audit: validAudit,
        error: `relevance gate rejected valid JSON audit (${options.relevance})`,
      })
      continue
    }

    if (options.mode === "markdown") {
      batchResults.push({
        batch: batch.index,
        ok: first.ok,
        status: first.status,
        ms: Date.now() - started,
        costUsd: first.costUsd,
        usage: first.usage,
        markdown: first.content,
        error: first.ok ? null : first.error,
      })
      continue
    }

    const repaired = await repairJson(model, first.content ?? first.raw ?? "", options)
    await writeRaw(options.rawDir, model, `batch-${batch.index}-repair`, repaired)
    const repairedAudit = coerceAudit(extractJson(repaired.content))

    batchResults.push({
      batch: batch.index,
      ok: Boolean(repaired.ok && isAccepted({ audit: repairedAudit, mode: "json", relevance: options.relevance, files: batch.files })),
      status: repaired.status ?? first.status,
      ms: Date.now() - started,
      costUsd: (first.costUsd ?? 0) + (repaired.costUsd ?? 0),
      usage: { first: first.usage, repair: repaired.usage },
      audit: repairedAudit,
      repaired: true,
      error: repaired.ok ? null : repaired.error ?? first.error ?? "Invalid JSON after repair",
      rawBeforeRepair: first.content?.slice(0, 6000) ?? first.raw?.slice(0, 6000),
    })
  }

  return mergeBatchResults(model, batchResults, Date.now() - started)
}

function makePrompt(question, context, mode, batchIndex) {
  const batchLine = batchIndex === null ? "" : `\nThis is context batch ${batchIndex}. Audit only this batch; cross-batch synthesis happens locally.`
  if (mode === "markdown") {
    return `Audit scope:
${question}${batchLine}

Rules:
- Return structured Markdown.
- Cite exact files/functions/branches from the context.
- Do not give generic advice.
- If evidence is insufficient, say "unclear" and explain what is missing.

Context:
${context}`
  }

  return `Audit scope:
${question}${batchLine}

Rules:
- Return only valid JSON.
- Use the contract shape below.
- Cite exact files/functions/branches in evidence.
- Do not give generic advice.
- Treat findings as hypotheses grounded in the provided context.
- If evidence is insufficient, mark verdict as unclear instead of inventing.

JSON contract:
${CONTRACT_TEXT}

Context:
${context}`
}

async function chat(model, prompt, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const body = {
      model,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens,
      messages: [
        {
          role: "system",
          content:
            options.mode === "markdown"
              ? "You are a precise senior audit reviewer. Be concrete and cite evidence."
              : "You are a precise senior audit reviewer. Return only JSON. If uncertain, mark verdict as unclear rather than inventing evidence.",
        },
        { role: "user", content: prompt },
      ],
    }

    const responseFormat = chooseResponseFormat(options.structured, options.supports, options.mode)
    if (responseFormat) body.response_format = responseFormat
    const provider = options.providerPrefs ?? {}
    if (Object.keys(provider).length) body.provider = provider

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE ?? "External model auditor",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    })

    const raw = await response.text()
    const payload = safeJson(raw)
    const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text

    return {
      ok: response.ok,
      id: payload?.id,
      status: response.status,
      raw,
      content: typeof content === "string" ? content : JSON.stringify(content ?? payload),
      finishReason: payload?.choices?.[0]?.finish_reason ?? payload?.choices?.[0]?.native_finish_reason ?? null,
      usage: payload?.usage,
      costUsd: payload?.usage?.cost ?? null,
      error: payload?.error?.message ?? payload?.error?.code,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

async function repairJson(model, rawOutput, options) {
  const repairPrompt = `The previous answer was not valid JSON or did not match the contract.
Do not add new analysis.
Do not change the substance.
Preserve all original findings, evidence, file references, ordering, and scenario verdicts. Only fix JSON syntax and contract shape.
Return only valid JSON matching this contract:
${CONTRACT_TEXT}

Previous answer:
${rawOutput.slice(0, options.repairInputChars ?? 32_000)}`
  const supportsResponseFormat = new Set(options.supports ?? []).has("response_format")
  return chat(model, repairPrompt, {
    ...options,
    mode: "json",
    structured: supportsResponseFormat ? "json_object" : "none",
    maxTokens: options.repairTokens,
  })
}

function chooseResponseFormat(structured, supports, mode) {
  if (mode === "markdown" || structured === "none") return null
  if (structured === "schema") {
    return { type: "json_schema", json_schema: { name: "external_model_audit", strict: true, schema: AUDIT_SCHEMA } }
  }
  if (structured === "json_object") return { type: "json_object" }
  const supported = new Set(supports ?? [])
  if (supported.has("response_format")) {
    return { type: "json_schema", json_schema: { name: "external_model_audit", strict: true, schema: AUDIT_SCHEMA } }
  }
  return null
}

function buildProviderPrefs() {
  const provider = {}
  if (args.zdr) provider.zdr = true
  if (args["require-parameters"]) provider.require_parameters = true
  if (args["provider-sort"]) provider.sort = args["provider-sort"]
  if (args["only-providers"]) provider.only = splitCsv(args["only-providers"])
  if (args["ignore-providers"]) provider.ignore = splitCsv(args["ignore-providers"])
  return provider
}

async function resolveFiles({ maxFiles }) {
  const specs = []
  specs.push(...parseFileSpecs(args.files))
  if (args["files-from"]) {
    const list = await readFile(args["files-from"], "utf8")
    specs.push(...parseFileSpecs(list.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).join(",")))
  }
  if (args.discover) {
    const discovered = await discoverFiles(process.cwd(), {
      patterns: splitCsv(args.discover),
      ignore: [...DEFAULT_IGNORE, ...splitCsv(args.ignore)],
      maxFiles,
      perFileChars: Number(args.perFileChars ?? 30_000),
    })
    specs.push(...discovered)
  }
  return uniqueBy(specs, (spec) => spec.path).slice(0, maxFiles)
}

async function discoverFiles(root, { patterns, ignore, maxFiles, perFileChars }) {
  const regexes = patterns.length ? patterns.map(globToRegExp) : [/\.(js|jsx|ts|tsx|py|go|rs|md|mdx|json|yaml|yml|css|scss|html)$/i]
  const found = []
  async function walk(dir) {
    if (found.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= maxFiles) break
      if (ignore.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && regexes.some((regex) => regex.test(rel))) {
        const info = await stat(full).catch(() => null)
        if (info && info.size <= Number(args.maxFileBytes ?? 500_000)) found.push({ path: rel, maxChars: perFileChars })
      }
    }
  }
  await walk(root)
  return found
}

async function buildContextBatches(fileSpecs, maxTotalChars, maxBatchChars) {
  const batches = []
  const warnings = []
  let current = { index: 1, files: [], context: "" }
  let usedTotal = 0

  for (const spec of fileSpecs) {
    if (usedTotal >= maxTotalChars) {
      warnings.push(`maxTotalChars=${maxTotalChars} reached before ${spec.path}; remaining files omitted`)
      break
    }
    const text = await readFile(spec.path, "utf8").catch((error) => `/* failed to read: ${error.message} */`)
    const remainingTotal = maxTotalChars - usedTotal
    const limit = Math.min(spec.maxChars, remainingTotal)
    const excerpt = text.slice(0, limit)
    if (text.length > limit) {
      warnings.push(`${spec.path} truncated from ${text.length} to ${limit} chars`)
    }
    const section = `## ${spec.path}\n\`\`\`\n${excerpt}\n\`\`\`\n`
    if (current.context && current.context.length + section.length > maxBatchChars) {
      batches.push(current)
      current = { index: batches.length + 1, files: [], context: "" }
    }
    current.context += `${section}\n`
    current.files.push(spec.path)
    usedTotal += excerpt.length
  }
  if (current.context) batches.push(current)
  return { batches, warnings }
}

async function loadEnvChain(explicitPath) {
  const paths = [explicitPath, ".env.local", ".env"].filter(Boolean)
  for (const envPath of paths) await loadEnv(envPath)
}

async function loadEnv(envPath) {
  const envText = await readFile(envPath, "utf8").catch(() => "")
  for (const line of envText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue
    const [key, ...valueParts] = trimmed.split("=")
    if (key && valueParts.length && !process.env[key]) {
      process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "")
    }
  }
}

async function loadModelProfiles(configPath) {
  const defaultPath = new URL("../config/model_profiles.json", import.meta.url)
  const text = await readFile(configPath ? path.resolve(configPath) : defaultPath, "utf8").catch(() => "")
  if (!text) {
    return {
      default_panel: "basic",
      panel_sizes: { basic: 3, expanded: 5 },
      profiles: { general: DEFAULT_MODELS },
      fallback: DEFAULT_MODELS,
      aliases: {},
    }
  }
  return JSON.parse(text)
}

function inferTask(question, profileConfig) {
  const text = String(question || "").toLowerCase()
  for (const [task, aliases] of Object.entries(profileConfig.aliases ?? {})) {
    if ((aliases ?? []).some((alias) => text.includes(String(alias).toLowerCase()))) return task
  }
  return "general"
}

function selectModelsForTask({ task, panel, profileConfig, modelMeta, modelCatalog }) {
  const size = Number(profileConfig.panel_sizes?.[panel] ?? (panel === "expanded" ? 5 : 3))
  const freshCandidates = discoverFreshCandidates(task, modelCatalog?.data ?? [])
  const candidates = [
    ...freshCandidates,
    ...(profileConfig.profiles?.[task] ?? []),
    ...(profileConfig.profiles?.general ?? []),
    ...(profileConfig.fallback ?? DEFAULT_MODELS),
  ]
  const selected = []
  const seenProviders = new Set()

  for (const model of candidates) {
    if (selected.length >= size) break
    if (!modelMeta[model] || selected.includes(model)) continue
    if (!isModelEligible(modelMeta[model])) continue
    const provider = model.split("/")[0].replace(/^~/, "")
    if (seenProviders.has(provider)) continue
    selected.push(model)
    seenProviders.add(provider)
  }

  for (const model of candidates) {
    if (selected.length >= size) break
    if (modelMeta[model] && isModelEligible(modelMeta[model]) && !selected.includes(model)) selected.push(model)
  }

  return selected.length ? selected : DEFAULT_MODELS.slice(0, size)
}

function discoverFreshCandidates(task, models) {
  const rankedFamilies = {
    general: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /deepseek.*v4.*pro/i,
      /qwen.*max/i,
      /mistral.*large/i,
    ],
    code: [
      /claude.*opus/i,
      /deepseek.*v4.*pro/i,
      /qwen.*coder/i,
      /gemini.*pro/i,
      /devstral|codestral/i,
      /qwen.*max/i,
    ],
    security: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /deepseek.*v4.*pro/i,
      /qwen.*max/i,
      /mistral.*large/i,
    ],
    marketing: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /qwen.*max/i,
      /deepseek.*v4.*pro/i,
      /mistral.*large/i,
    ],
    strategy: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /qwen.*max/i,
      /mistral.*large/i,
      /deepseek.*v4.*pro/i,
    ],
    ux: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /qwen.*max/i,
      /deepseek.*v4.*pro/i,
      /mistral.*large/i,
    ],
    legal: [
      /claude.*opus/i,
      /gemini.*pro/i,
      /mistral.*large/i,
      /deepseek.*v4.*pro/i,
      /qwen.*max/i,
    ],
    data: [
      /gemini.*pro/i,
      /claude.*opus/i,
      /deepseek.*v4.*pro/i,
      /qwen.*max/i,
      /mistral.*large/i,
    ],
  }
  const patterns = rankedFamilies[task] ?? rankedFamilies.general
  const available = models
    .filter(isModelEligible)

  const result = []
  for (const pattern of patterns) {
    const matches = available
      .filter((model) => pattern.test(`${model.id} ${model.name}`))
      .sort(compareFreshModels)
    for (const match of matches.slice(0, 2)) {
      if (!result.includes(match.id)) result.push(match.id)
    }
  }
  return result
}

function isModelEligible(model) {
  const input = model.input_modalities ?? model.architecture?.input_modalities ?? model.architecture?.modality ?? ["text"]
  const output = model.output_modalities ?? model.architecture?.output_modalities ?? ["text"]
  const inputList = Array.isArray(input) ? input : [String(input)]
  const outputList = Array.isArray(output) ? output : [String(output)]
  return (
    inputList.some((item) => String(item).toLowerCase().includes("text")) &&
    outputList.some((item) => String(item).toLowerCase().includes("text")) &&
    Number(model.context_length ?? model.top_provider?.context_length ?? 0) >= Number(args.minContext ?? 100000)
  )
}

function compareFreshModels(a, b) {
  const aText = `${a.id} ${a.name}`.toLowerCase()
  const bText = `${b.id} ${b.name}`.toLowerCase()
  const score = (model, text) => {
    let value = Number(model.created ?? 0) / 1_000_000
    if (text.includes("latest")) value += 5000
    if (text.includes("preview")) value += 500
    if (text.includes("pro")) value += 300
    if (text.includes("max")) value += 250
    if (text.includes("large")) value += 200
    if (text.includes("flash")) value -= 100
    if (text.includes("lite")) value -= 150
    if (text.includes("small")) value -= 150
    value += Math.min(Number(model.context_length ?? 0) / 100000, 20)
    return value
  }
  return score(b, bText) - score(a, aText)
}

async function getModelCatalog() {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  })
  if (!response.ok) throw new Error(`models endpoint failed ${response.status}`)
  return response.json()
}

async function listModels(query) {
  const catalog = await getModelCatalog()
  const needle = String(query).toLowerCase()
  for (const model of catalog.data.filter((item) => (`${item.id} ${item.name}`).toLowerCase().includes(needle)).slice(0, 100)) {
    console.log(`${model.id} | ${model.name} | ctx=${model.context_length} | params=${(model.supported_parameters ?? []).join(",")}`)
  }
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith("--")) continue
    const key = value.slice(2)
    const next = values[index + 1]
    if (!next || next.startsWith("--")) {
      result[key] = "1"
    } else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function parseFileSpecs(value) {
  return splitCsv(value).map((item) => {
    const splitAt = item.lastIndexOf(":")
    const hasLimit = splitAt > 0 && /^\d+$/.test(item.slice(splitAt + 1))
    const filePath = hasLimit ? item.slice(0, splitAt) : item
    return { path: filePath, maxChars: hasLimit ? Number(item.slice(splitAt + 1)) : Number(args.perFileChars ?? 30_000) }
  })
}

function splitCsv(value) {
  return value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : []
}

function extractJson(value) {
  if (!value || typeof value !== "string") return null
  const direct = safeJson(value)
  if (direct) return direct
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    const parsed = safeJson(fenced[1])
    if (parsed) return parsed
  }
  const firstBrace = value.indexOf("{")
  if (firstBrace < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = firstBrace; i < value.length; i++) {
    const char = value[i]
    if (escaped) {
      escaped = false
    } else if (char === "\\") {
      escaped = true
    } else if (char === '"') {
      inString = !inString
    } else if (!inString && char === "{") {
      depth++
    } else if (!inString && char === "}") {
      depth--
      if (depth === 0) return safeJson(value.slice(firstBrace, i + 1))
    }
  }
  return null
}

function safeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function coerceAudit(value) {
  if (!value || typeof value !== "object") return null
  return {
    score: Number.isFinite(Number(value.score)) ? Number(value.score) : 0,
    summary: String(value.summary ?? ""),
    strengths: toStringArray(value.strengths),
    findings: Array.isArray(value.findings) ? value.findings.map(coerceFinding).filter(Boolean) : [],
    scenarioVerdicts: Array.isArray(value.scenarioVerdicts) ? value.scenarioVerdicts.map(coerceVerdict).filter(Boolean) : [],
    topFixes: toStringArray(value.topFixes),
    suggestedTests: toStringArray(value.suggestedTests),
  }
}

function coerceFinding(value) {
  if (!value || typeof value !== "object") return null
  return {
    severity: ["critical", "major", "minor"].includes(value.severity) ? value.severity : "minor",
    area: String(value.area ?? ""),
    issue: String(value.issue ?? ""),
    evidence: String(value.evidence ?? ""),
    recommendation: String(value.recommendation ?? ""),
    files: toStringArray(value.files),
  }
}

function coerceVerdict(value) {
  if (!value || typeof value !== "object") return null
  return {
    caseName: String(value.caseName ?? ""),
    expectedBehavior: String(value.expectedBehavior ?? ""),
    verdict: ["pass", "partial", "fail", "unclear"].includes(value.verdict) ? value.verdict : "unclear",
    risk: String(value.risk ?? ""),
  }
}

function isAccepted({ audit, markdown, mode, relevance, files }) {
  if (mode === "markdown") {
    if (!markdown || markdown.trim().length <= 200) return false
    if (relevance === "off") return true
    const text = markdown.toLowerCase()
    const basenames = files.map((file) => path.basename(file).toLowerCase()).filter(Boolean)
    const paths = files.map((file) => normalizePath(file).toLowerCase())
    const fileHit = paths.some((file) => text.includes(file)) || basenames.some((name) => text.includes(name))
    if (relevance === "strict") return fileHit
    return fileHit || /evidence|file|function|line|risk|fix|recommend/i.test(markdown)
  }
  if (!audit || !audit.summary || !Array.isArray(audit.findings) || !Array.isArray(audit.topFixes)) return false
  if (relevance === "off") return true
  const fileSet = new Set(files.map((file) => normalizePath(file)))
  const basenames = new Set(files.map((file) => path.basename(file).toLowerCase()))
  const text = JSON.stringify(audit).toLowerCase()
  const fileHits = [...fileSet].filter((file) => text.includes(file.toLowerCase())).length
  const basenameHits = [...basenames].filter((name) => name && text.includes(name)).length
  const findingsWithEvidence = audit.findings.filter((finding) => finding.evidence && finding.evidence.length > 20).length
  const citedFiles = audit.findings.flatMap((finding) => finding.files ?? []).map((file) => String(file).toLowerCase()).filter(Boolean)
  const citedMatches = citedFiles.filter((file) => {
    const base = path.basename(file)
    return [...fileSet].some((known) => known.toLowerCase().includes(file) || file.includes(known.toLowerCase())) || basenames.has(base)
  }).length
  if (citedFiles.length && citedMatches === 0) return false
  if (relevance === "strict") return (fileHits > 0 || basenameHits > 0) && findingsWithEvidence > 0
  return fileHits > 0 || basenameHits > 0 || findingsWithEvidence >= Math.min(2, audit.findings.length)
}

function mergeBatchResults(model, batchResults, ms) {
  const okBatches = batchResults.filter((result) => result.ok)
  const audits = okBatches.map((result) => result.audit).filter(Boolean)
  const markdowns = okBatches.map((result) => result.markdown).filter(Boolean)
  const audit = audits.length
    ? {
        score: Math.round(audits.reduce((sum, item) => sum + item.score, 0) / audits.length),
        summary: audits.map((item, index) => `Batch ${okBatches[index]?.batch}: ${item.summary}`).join("\n"),
        strengths: unique(audits.flatMap((item) => item.strengths)),
        findings: audits.flatMap((item) => item.findings),
        scenarioVerdicts: audits.flatMap((item) => item.scenarioVerdicts),
        topFixes: unique(audits.flatMap((item) => item.topFixes)),
        suggestedTests: unique(audits.flatMap((item) => item.suggestedTests)),
      }
    : null
  return {
    model,
    ok: okBatches.length > 0,
    ms,
    costUsd: roundMoney(batchResults.reduce((sum, result) => sum + (result.costUsd ?? 0), 0)),
    usage: batchResults.map((result) => result.usage),
    audit,
    markdown: markdowns.join("\n\n---\n\n") || null,
    batches: batchResults,
    error: okBatches.length ? null : batchResults.map((result) => result.error).filter(Boolean).join("; ") || "all batches failed",
  }
}

function synthesize(results) {
  const ok = results.filter((result) => result.ok)
  const audited = ok.filter((result) => result.audit)
  const allFindings = audited.flatMap((result) =>
    result.audit.findings.map((finding) => ({ ...finding, model: result.model })),
  )
  const avgScore = audited.length ? Math.round(audited.reduce((sum, result) => sum + result.audit.score, 0) / audited.length) : 0

  return {
    avgScore,
    totalCostUsd: roundMoney(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0)),
    topFindings: allFindings.slice(0, 25),
    topFixes: unique(audited.flatMap((result) => result.audit.topFixes)).slice(0, 25),
    suggestedTests: unique(audited.flatMap((result) => result.audit.suggestedTests)).slice(0, 25),
    markdownModels: ok.filter((result) => result.markdown).map((result) => result.model),
  }
}

function makeMarkdown(report) {
  return `# External Model Audit: ${report.title}

Generated: ${report.generatedAt}

Question: ${report.question}

Mode: ${report.mode}  
Structured: ${report.structured}  
Relevance: ${report.relevance}

Models:
${report.models.map((model) => `- \`${model}\``).join("\n")}

Files:
${report.files.map((file) => `- \`${file.path}\` up to ${file.maxChars} chars`).join("\n")}

Batches:
${report.batches.map((batch) => `- batch ${batch.index}: ${batch.contextChars} chars, ${batch.files.length} files`).join("\n")}

## Synthesis

Average score: ${report.synthesis.avgScore}/100  
Estimated cost: $${report.synthesis.totalCostUsd.toFixed(6)}

### Top Fixes
${report.synthesis.topFixes.map((item) => `- ${item}`).join("\n") || "- none"}

### Suggested Tests
${report.synthesis.suggestedTests.map((item) => `- ${item}`).join("\n") || "- none"}

${report.results.map(formatResult).join("\n\n")}
`
}

function formatResult(result) {
  if (!result.ok) {
    return `## ${result.model}\n\nFailed: ${result.error ?? "unknown error"}`
  }

  if (result.markdown && !result.audit) {
    return `## ${result.model}\n\nLatency: ${result.ms} ms  \nCost: ${typeof result.costUsd === "number" ? `$${result.costUsd.toFixed(6)}` : "-"}\n\n${result.markdown}`
  }

  return `## ${result.model}

Score: ${result.audit.score}/100  
Latency: ${result.ms} ms  
Cost: ${typeof result.costUsd === "number" ? `$${result.costUsd.toFixed(6)}` : "-"}

${result.audit.summary}

### Strengths
${result.audit.strengths.map((item) => `- ${item}`).join("\n") || "- none"}

### Findings
${result.audit.findings
  .map(
    (finding) =>
      `- **${finding.severity.toUpperCase()} / ${finding.area}:** ${finding.issue}\n  - Evidence: ${finding.evidence}\n  - Fix: ${finding.recommendation}\n  - Files: ${finding.files.map((file) => `\`${file}\``).join(", ")}`,
  )
  .join("\n") || "- none"}

### Scenario Verdicts
${(result.audit.scenarioVerdicts ?? [])
  .map((item) => `- **${item.caseName}:** ${item.verdict}. ${item.expectedBehavior} Risk: ${item.risk}`)
  .join("\n") || "- none"}
`
}

async function writeRaw(rawDir, model, name, data) {
  const file = `${slug(model)}-${name}.json`
  await writeFile(path.join(rawDir, file), JSON.stringify(data, null, 2))
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

function uniqueBy(values, keyFn) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = keyFn(value)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }
  return out
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9а-яё-]+/giu, "-").replace(/^-+|-+$/g, "") || "audit"
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/")
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(escaped, "i")
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`Usage:
  node run_openrouter_audit.mjs --title audit-name --files file.ts:12000,lib/foo.ts:16000 --question "Audit security only"
  node run_openrouter_audit.mjs --discover "*.ts,*.tsx,*.md" --question "Audit UX copy" --mode markdown
  node run_openrouter_audit.mjs --list-models opus

Core options:
  --env PATH                    Load OPENROUTER_API_KEY from env file; also tries .env.local and .env
  --models CSV                  Explicit model IDs; bypasses auto-selection
  --task NAME                   Auto-select ranked model profile: general, code, security, marketing, strategy, ux, legal, data
  --panel basic|expanded        Auto model count: basic=3, expanded=5
  --list-tasks                  Show available task profiles
  --rank-config PATH            Override model profile config
  --files CSV                   file[:maxChars],file2[:maxChars]
  --files-from PATH             Newline list of file[:maxChars]
  --discover CSV                Discover matching files from cwd, e.g. "*.ts,*.tsx,*.md"
  --ignore CSV                  Extra directory/file names to ignore during discovery
  --question TEXT               Audit scope
  --mode json|markdown          JSON is best for code audits; markdown for strategy audits
  --structured auto|schema|json_object|none
  --relevance normal|strict|off
  --perFileChars N              Default chars per file when no file-specific limit is set, default 30000
  --maxTotalChars N             Total context budget, default 120000
  --maxBatchChars N             Split context into batches, default 60000
  --maxTokens N                 Completion budget per model, default 6000
  --repairTokens N              Completion budget for JSON repair, default 3500
  --repairInputChars N          Raw output chars passed to JSON repair, default maxBatchChars or 70000
  --temperature N               Sampling temperature, default 0.1
  --out DIR                     Output directory
  --zdr                         Request Zero Data Retention routing
  --require-parameters          Ask OpenRouter to route only to providers supporting requested params
`)
}
