#!/usr/bin/env node
// bpmn-agent CLI: extract | catalog | validate | build | render | prompt | agent
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { extractDocument, toAnnotatedMarkdown } from './extract.mjs';
import { loadJsonFiles, validateCatalog } from './model.mjs';
import { catalogMarkdown } from './report.mjs';
import { renderPreview } from './render.mjs';
import { loadDocs, checkQuotes, quoteIssues, validateAll, buildAll } from './pipeline.mjs';
import { chatSystemPrompt, CHAT_PROMPT_PATH } from './agent/prompts.mjs';

const USAGE = `bpmn-agent — инструменты агента-аналитика

  extract  <файл...> [--out dir]          Документы (.md .txt .docx .pdf) → разделы с якорями [§id]
  catalog  <catalog.json> [--docs dir] [--out file]
                                          Проверка каталога БП (+ сверка цитат) → catalog.md
  validate <model.json|dir> [--docs dir]  Проверка моделей (+ сверка цитат с документами)
  build    <model.json|dir> [--out dir] [--formats generic,camunda7,camunda8,drawio]
           [--executable] [--docs dir] [--cdn]
                                          Экспорт + lint + preview.html + report.md
  render   <preview.html> [--out dir]     PNG каждой диаграммы (headless Edge/Chrome) для самопроверки
  prompt   [--out file]                   Собрать промпт для чат-нейросетей → prompts/bpmn-analyst.chat.md

  agent catalog <документы...> --work dir [--names "Процесс А; Процесс Б"]
  agent model   --work dir [--ids a,b | --all] [--levels L1,L2] [--formats ...] [--executable]
  agent run     <документы...> --work dir [--names ...] [--levels ...] [--formats ...]   (без контрольной точки)
      LLM: --provider anthropic|openai|deepseek|openrouter|ollama|lmstudio|openai-compatible
           --model <id> [--base-url url] [--json-mode] [--max-tokens N] [--effort high] [--retries 3]
           Ключ — в переменной окружения (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY,
           OPENROUTER_API_KEY, LLM_API_KEY). Также LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL.

  Форматы: generic (BPMN 2.0: stormBPMN и др.), camunda7, camunda8, drawio`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    formats: { type: 'string', short: 'f' },
    executable: { type: 'boolean', default: false },
    docs: { type: 'string' },
    quiet: { type: 'boolean', short: 'q', default: false },
    cdn: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
    // agent
    work: { type: 'string', short: 'w' },
    names: { type: 'string' },
    ids: { type: 'string' },
    all: { type: 'boolean', default: false },
    levels: { type: 'string' },
    provider: { type: 'string', short: 'p' },
    model: { type: 'string', short: 'm' },
    'base-url': { type: 'string' },
    'json-mode': { type: 'boolean', default: false },
    'max-tokens': { type: 'string' },
    effort: { type: 'string' },
    retries: { type: 'string' },
    'max-doc-chars': { type: 'string' }
  }
});
const [cmd, ...args] = positionals;
const log = (...a) => !opt.quiet && console.log(...a);
const ICON = { error: '❌', warn: '⚠ ', info: 'ℹ ' };
const count = (issues) => {
  const c = (l) => issues.filter((i) => i.level === l).length;
  return `ошибок ${c('error')}, замечаний ${c('warn')}, инфо ${c('info')}`;
};
const printIssues = (title, issues, showInfo = false) => {
  log(`\n${title}: ${count(issues)}`);
  for (const i of issues.filter((x) => showInfo || x.level !== 'info')) log(`  ${ICON[i.level]} [${i.rule}] ${i.message}`);
};
const list = (s) => (s ? s.split(/[;,]/).map((x) => x.trim()).filter(Boolean) : undefined);
const formatsOpt = (def) => list(opt.formats) ?? def;

async function cmdExtract() {
  if (!args.length) throw new Error('Укажите файлы');
  const out = opt.out ?? 'out/extracted';
  await mkdir(out, { recursive: true });
  for (const f of args) {
    const ex = await extractDocument(f);
    const base = join(out, basename(f, extname(f)));
    await writeFile(`${base}.sections.json`, JSON.stringify(ex, null, 2));
    await writeFile(`${base}.md`, toAnnotatedMarkdown(ex));
    log(`${f} → ${base}.md (${ex.sections.length} разделов)`);
  }
}

async function cmdCatalog() {
  const file = args[0];
  if (!file) throw new Error('Укажите catalog.json');
  const [{ data }] = await loadJsonFiles(file);
  const issues = validateCatalog(data);
  const docs = await loadDocs(opt.docs);
  if (docs.length && !issues.some((i) => i.rule === 'schema')) issues.push(...quoteIssues(checkQuotes(data, docs)));
  printIssues('Каталог', issues);
  if (issues.some((i) => i.rule === 'schema')) return 1;
  const out = opt.out ?? file.replace(/\.json$/, '.md');
  await writeFile(out, catalogMarkdown(data));
  log(`\n→ ${out} (${data.processes.length} процессов)`);
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

async function cmdValidate() {
  if (!args[0]) throw new Error('Укажите модель или папку');
  const { models, byId, setIssues } = await validateAll(args[0], await loadDocs(opt.docs));
  for (const { file, data } of models) printIssues(`${basename(file)} (${data.id})`, byId.get(data.id ?? file));
  if (setIssues.length) printIssues('Связи между уровнями', setIssues, true);
  return [...byId.values(), setIssues].flat().some((i) => i.level === 'error') ? 1 : 0;
}

function printBuild({ files, results, setIssues }) {
  for (const r of results) printIssues(`${r.skipped ? '✖' : '✔'} ${r.level} ${r.name} (${r.id})${r.skipped ? ' — пропущен' : ''}`, r.issues);
  if (setIssues.length) printIssues('Связи между уровнями', setIssues, true);
  log(`\nФайлы (${files.length}):`);
  for (const f of files) log(`  ${f}`);
  return results.some((r) => r.skipped) ? 1 : 0;
}

async function cmdBuild() {
  if (!args[0]) throw new Error('Укажите модель или папку');
  const res = await buildAll(args[0], {
    out: opt.out ?? 'out/build',
    formats: formatsOpt(['generic', 'camunda8', 'drawio']),
    executable: opt.executable,
    docs: await loadDocs(opt.docs),
    cdn: opt.cdn
  });
  return printBuild(res);
}

async function cmdRender() {
  if (!args[0]) throw new Error('Укажите preview.html');
  for (const f of await renderPreview(args[0], opt.out ?? join(dirname(args[0]), 'png'))) log(f);
}


async function cmdPrompt() {
  const out = opt.out ?? CHAT_PROMPT_PATH;
  await mkdir(dirname(out), { recursive: true });
  const text = chatSystemPrompt();
  await writeFile(out, text);
  log(`→ ${out} (${Math.round(text.length / 1000)} тыс. символов)`);
}

async function cmdAgent() {
  const [sub, ...docPaths] = args;
  const { createLLM } = await import('./agent/llm.mjs');
  const { runCatalog, runModels } = await import('./agent/run.mjs');
  if (!['catalog', 'model', 'run'].includes(sub)) throw new Error(`agent: укажите catalog | model | run\n\n${USAGE}`);
  const work = opt.work ?? 'bpmn-work';
  const llm = createLLM({
    provider: opt.provider,
    model: opt.model,
    baseUrl: opt['base-url'],
    jsonMode: opt['json-mode'],
    maxTokens: opt['max-tokens'] ? Number(opt['max-tokens']) : undefined,
    effort: opt.effort
  });
  const common = {
    llm,
    work,
    retries: opt.retries ? Number(opt.retries) : 3,
    maxDocChars: opt['max-doc-chars'] ? Number(opt['max-doc-chars']) : undefined,
    log
  };

  if (sub === 'catalog' || sub === 'run') {
    if (!docPaths.length) throw new Error('Укажите документы');
    const { catalog, issues, ok } = await runCatalog({ ...common, docPaths, names: list(opt.names) });
    printIssues('Каталог', issues);
    log(`\n📋 Каталог: ${catalog.processes.length} процессов, ${catalog.gaps?.length ?? 0} пробелов → ${join(work, 'catalog.md')}`);
    if (!ok) return 1;
    if (sub === 'catalog') {
      log(
        `\n⛔ Контрольная точка: проверьте ${join(work, 'catalog.md')}, проставьте status "confirmed" нужным процессам\n` +
          `   в ${join(work, 'catalog.json')} и запустите: agent model --work ${work} (или --all / --ids a,b)`
      );
      return 0;
    }
  }
  const res = await runModels({
    ...common,
    ids: list(opt.ids),
    all: sub === 'run' || opt.all,
    levels: list(opt.levels),
    formats: formatsOpt(['generic', 'drawio']),
    executable: opt.executable
  });
  const code = printBuild(res.build);
  if (res.failed.length) log(`\n⚠ С ошибками после исправлений: ${res.failed.join(', ')} — см. ${join(work, 'logs')}`);
  return res.failed.length ? 1 : code;
}

try {
  if (opt.help || !cmd) {
    console.log(USAGE);
    process.exit(0);
  }
  const run = { extract: cmdExtract, catalog: cmdCatalog, validate: cmdValidate, build: cmdBuild, render: cmdRender, prompt: cmdPrompt, agent: cmdAgent }[cmd];
  if (!run) throw new Error(`Неизвестная команда ${cmd}\n\n${USAGE}`);
  process.exitCode = (await run()) ?? 0;
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exitCode = 2;
}
