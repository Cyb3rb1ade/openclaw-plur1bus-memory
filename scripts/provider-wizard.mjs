#!/usr/bin/env node
/**
 * scripts/provider-wizard.mjs — i18n-konformer Provider-Wizard.
 *
 * Named exports (for tests): buildWizardOptions, formatWizardOption
 * When run directly: interactive wizard → JSON on stdout
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const { t, resolveLocale } = await import(join(__dir, "../lib/i18n.js"));

const lang = resolveLocale();
const tone = "default";
const rl = createInterface({ input: stdin, output: stdout });

const RERANKER_OPTIONS = [
  { key: "cohere",             i18nLabel: "setup.reranker.option.cohere",    i18nHelp: "setup.reranker.option.cohere_help" },
  { key: "local-transformers", i18nLabel: "setup.reranker.option.local_bge", i18nHelp: "setup.reranker.option.local_bge_help" },
  { key: "disabled",           i18nLabel: "setup.reranker.option.disabled",  i18nHelp: "setup.reranker.option.disabled_help" },
  { key: "advanced",           i18nLabel: "setup.reranker.option.advanced",  i18nHelp: "setup.reranker.option.advanced_help" },
];

const EMBEDDING_OPTIONS = [
  { key: "openai",             i18nLabel: "setup.embedding.option.openai",   i18nHelp: "setup.embedding.option.openai_help" },
  { key: "local-transformers", i18nLabel: "setup.embedding.option.local_e5", i18nHelp: "setup.embedding.option.local_e5_help" },
];

const ADVANCED_RERANKER_MODELS = [
  "Alibaba-NLP/gte-reranker-modernbert-base",
  "jinaai/jina-reranker-v2-base-multilingual",
  "mixedbread-ai/mxbai-rerank-base-v2",
];

export function buildWizardOptions(type, { lang: _l = "en" } = {}) {
  if (type === "reranker") return RERANKER_OPTIONS;
  if (type === "embedding") return EMBEDDING_OPTIONS;
  return [];
}

export function formatWizardOption(type, key, { lang: l = "en" } = {}) {
  const options = type === "reranker" ? RERANKER_OPTIONS : EMBEDDING_OPTIONS;
  const opt = options.find(o => o.key === key);
  if (!opt?.i18nLabel) return key;
  return t(opt.i18nLabel, { lang: l, tone: "default" });
}

async function askLine(prompt) {
  return (await rl.question(prompt)).trim();
}

async function wizardEmbedding() {
  console.error(t("setup.embedding.title", { lang, tone }));
  console.error(t("setup.embedding.description", { lang, tone }));
  console.error("");
  for (let i = 0; i < EMBEDDING_OPTIONS.length; i++) {
    const opt = EMBEDDING_OPTIONS[i];
    console.error(`[${i + 1}] ${t(opt.i18nLabel, { lang, tone })}`);
    console.error(`    ${t(opt.i18nHelp, { lang, tone })}`);
  }
  let choice;
  while (true) {
    choice = await askLine("[1/2]: ");
    if (choice === "1" || choice === "2") break;
    console.error(t("setup.reranker.invalid_choice", { lang, tone }));
  }
  if (choice === "1") {
    console.error(t("setup.embedding.api_key_ask", { lang, tone }));
    const keyChoice = await askLine("[1/2]: ");
    if (keyChoice === "2") {
      const literal = await askLine("Enter key: ");
      return { provider: "openai", apiKey: literal, model: "text-embedding-3-large", dimensions: 3072 };
    }
    return { provider: "openai", apiKeyEnv: "OPENAI_API_KEY", model: "text-embedding-3-large", dimensions: 3072 };
  } else {
    return { provider: "local-transformers", model: "intfloat/multilingual-e5-small", dimensions: 384 };
  }
}

async function wizardReranker() {
  console.error(t("setup.reranker.title", { lang, tone }));
  console.error(t("setup.reranker.description", { lang, tone }));
  console.error("");
  for (let i = 0; i < RERANKER_OPTIONS.length; i++) {
    const opt = RERANKER_OPTIONS[i];
    console.error(`[${i + 1}] ${t(opt.i18nLabel, { lang, tone })}`);
    console.error(`    ${t(opt.i18nHelp, { lang, tone })}`);
  }
  let choice;
  while (true) {
    choice = await askLine("[1/2/3/4]: ");
    if (["1", "2", "3", "4"].includes(choice)) break;
    console.error(t("setup.reranker.invalid_choice", { lang, tone }));
  }
  if (choice === "1") {
    const keyChoice = await askLine("COHERE_API_KEY [1] env-ref / [2] literal: ");
    let cfg;
    if (keyChoice === "2") {
      const literal = await askLine("Enter key: ");
      cfg = { provider: "cohere", apiKey: literal, model: "rerank-v3.5", candidates: 20, timeoutMs: 5000, fallbackOnError: true, fallbackProvider: "disabled" };
    } else {
      cfg = { provider: "cohere", apiKeyEnv: "COHERE_API_KEY", model: "rerank-v3.5", candidates: 20, timeoutMs: 5000, fallbackOnError: true, fallbackProvider: "disabled" };
    }
    console.error(t("setup.reranker.cohere_fallback_ask", { lang, tone }));
    const fb = await askLine("[1/2]: ");
    if (fb === "2") {
      cfg.fallbackProvider = "local-transformers";
      cfg.fallbackModel = "BAAI/bge-reranker-v2-m3";
      console.error(t("setup.reranker.lazy_load_notice", { lang, tone, vars: { sizeMb: "570" } }));
    }
    return cfg;
  } else if (choice === "2") {
    console.error(t("setup.reranker.local_cpu_warning", { lang, tone }));
    console.error(t("setup.reranker.lazy_load_notice", { lang, tone, vars: { sizeMb: "570" } }));
    return { provider: "local-transformers", model: "BAAI/bge-reranker-v2-m3", candidates: 20, timeoutMs: 5000, fallbackOnError: true };
  } else if (choice === "3") {
    return { provider: "disabled", enabled: false, candidates: 20 };
  } else {
    for (let i = 0; i < ADVANCED_RERANKER_MODELS.length; i++) {
      console.error(`  [${String.fromCharCode(97 + i)}] ${ADVANCED_RERANKER_MODELS[i]}`);
    }
    const adv = await askLine("[a/b/c]: ");
    const idx = adv.charCodeAt(0) - 97;
    if (idx >= 0 && idx < ADVANCED_RERANKER_MODELS.length) {
      console.error(t("setup.reranker.local_cpu_warning", { lang, tone }));
      return { provider: "local-transformers", model: ADVANCED_RERANKER_MODELS[idx], candidates: 20, timeoutMs: 5000, fallbackOnError: true };
    }
    return { provider: "disabled", enabled: false, candidates: 20 };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const embedding = await wizardEmbedding();
    const reranker = await wizardReranker();
    rl.close();
    process.stdout.write(JSON.stringify({ embedding, reranker }, null, 2) + "\n");
    process.exit(0);
  } catch (e) {
    rl.close();
    console.error(`[wizard] Fehler: ${e.message}`);
    process.exit(1);
  }
}
