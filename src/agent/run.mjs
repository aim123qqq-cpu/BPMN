// Встроенный агент: шаги ведёт код, модель отвечает JSON, код проверяет и при ошибках просит исправить.
// Работает с любой LLM (см. llm.mjs). Рабочая папка:
//   extracted/  — документы с якорями     catalog.json / catalog.md — каталог (контрольная точка)
//   models/     — модели процессов        out/ — форматы, preview.html, report.md
//   logs/       — все запросы и ответы модели (для разбора и аудита)
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { extractDocument, toAnnotatedMarkdown } from '../extract.mjs';
import { validateCatalog, validateModelSet } from '../model.mjs';
import { catalogMarkdown } from '../report.mjs';
import { loadDocs, checkQuotes, quoteIssues, checkModel, buildAll } from '../pipeline.mjs';
import { parseJsonResponse } from './llm.mjs';
import { pipelineSystemPrompt, catalogTask, modelTask, repairTask } from './prompts.mjs';

const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 };

function docsBlock(docs, maxChars) {
  const text = docs.map((d) => toAnnotatedMarkdown(d)).join('\n\n');
  if (maxChars && text.length > maxChars)
    throw new Error(
      `Документы занимают ${text.length} символов — больше лимита --max-doc-chars=${maxChars}. ` +
        'Увеличьте лимит (если модель позволяет) или разбейте работу по документам.'
    );
  return `# Документы\n\n${text}`;
}

function createLogger(work) {
  let n = 0;
  return async (label, request, response) => {
    await mkdir(join(work, 'logs'), { recursive: true });
    const file = join(work, 'logs', `${String(++n).padStart(3, '0')}-${label}.md`);
    await writeFile(file, `# ${label}\n\n## Запрос\n\n${request}\n\n## Ответ\n\n${response}\n`);
  };
}

/** Запрос JSON с циклом исправлений. Ошибки исправляются до retries раз, замечания (warn) — один раз. */
async function askJson({ llm, system, docs, task, validate, retries, label, logStep, log }) {
  const messages = [{ role: 'user', content: [{ text: docs, cache: true }, { text: task }] }];
  let last = { data: null, issues: [] };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const request = typeof messages.at(-1).content === 'string' ? messages.at(-1).content : task;
    const text = await llm.complete({ system, messages });
    await logStep(`${label}${attempt ? `-fix${attempt}` : ''}`, request, text);
    let issues;
    let data = null;
    try {
      data = parseJsonResponse(text);
      issues = validate(data);
    } catch (e) {
      issues = [{ level: 'error', rule: 'json', message: e.message }];
    }
    const errors = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');
    // последний разобранный JSON — это исправление предыдущего, он и считается текущим результатом
    if (data || !last.data) last = { data, issues };
    if (!errors.length && (!warns.length || attempt >= 1)) return { ...last, ok: true };
    if (attempt === retries) break;
    log(`  ↻ ${label}: ${errors.length} ошибок, ${warns.length} замечаний — прошу исправить (${attempt + 1}/${retries})`);
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: repairTask(issues) });
  }
  return { ...last, ok: !last.issues.some((i) => i.level === 'error') };
}

/** Шаг 1–2: документы → каталог. Останавливается на контрольной точке (status "proposed"). */
export async function runCatalog({ llm, docPaths, work, names, retries = 3, maxDocChars = 400000, log = console.log }) {
  await mkdir(join(work, 'extracted'), { recursive: true });
  const docs = [];
  for (const f of docPaths) {
    const ex = await extractDocument(f);
    const base = join(work, 'extracted', basename(f, extname(f)));
    await writeFile(`${base}.sections.json`, JSON.stringify(ex, null, 2));
    await writeFile(`${base}.md`, toAnnotatedMarkdown(ex));
    docs.push(ex);
    log(`📄 ${f}: ${ex.sections.length} разделов`);
  }
  log(`🤖 ${llm.name}: строю каталог процессов…`);
  const res = await askJson({
    llm,
    system: pipelineSystemPrompt(),
    docs: docsBlock(docs, maxDocChars),
    task: catalogTask({ names }),
    validate: (c) => {
      const issues = validateCatalog(c);
      if (!issues.some((i) => i.rule === 'schema')) issues.push(...quoteIssues(checkQuotes(c, docs)));
      return issues;
    },
    retries,
    label: 'catalog',
    logStep: createLogger(work),
    log
  });
  if (!res.data) throw new Error('Модель не вернула корректный каталог — см. logs/');
  await writeFile(join(work, 'catalog.json'), JSON.stringify(res.data, null, 2) + '\n');
  if (!res.issues.some((i) => i.rule === 'schema')) await writeFile(join(work, 'catalog.md'), catalogMarkdown(res.data));
  return { catalog: res.data, issues: res.issues, ok: res.ok };
}

/** Шаг 3–4: подтверждённый каталог → модели → форматы. */
export async function runModels({
  llm,
  work,
  ids,
  all = false,
  levels = ['L0', 'L1', 'L2', 'L3'],
  formats = ['generic', 'drawio'],
  executable = false,
  retries = 3,
  maxDocChars = 400000,
  log = console.log
}) {
  if (!existsSync(join(work, 'catalog.json'))) throw new Error(`В ${work} нет catalog.json — сначала запустите agent catalog <документы> --work ${work}`);
  const catalog = JSON.parse(await readFile(join(work, 'catalog.json'), 'utf8'));
  const docs = await loadDocs(join(work, 'extracted'));
  let selected;
  if (ids?.length) {
    selected = ids.map((id) => {
      const p = catalog.processes.find((x) => x.id === id);
      if (!p) throw new Error(`Процесса ${id} нет в каталоге`);
      return p;
    });
  } else if (all) {
    selected = catalog.processes.filter((p) => p.status !== 'rejected' && p.coverage !== 'mention' && levels.includes(p.level));
  } else {
    selected = catalog.processes.filter((p) => p.status === 'confirmed' && levels.includes(p.level));
    if (!selected.length)
      throw new Error(
        'В каталоге нет подтверждённых процессов. Проверьте catalog.md, проставьте status "confirmed" нужным процессам ' +
          'в catalog.json (или запустите с --all / --ids).'
      );
  }
  selected.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  const modelsDir = join(work, 'models');
  await mkdir(modelsDir, { recursive: true });
  const models = new Map();
  for (const f of existsSync(modelsDir) ? await readdir(modelsDir) : [])
    if (f.endsWith('.json')) {
      const m = JSON.parse(await readFile(join(modelsDir, f), 'utf8'));
      models.set(m.id, m);
    }

  const system = pipelineSystemPrompt();
  const block = docsBlock(docs, maxDocChars);
  const logStep = createLogger(work);
  const failed = [];
  for (const proc of selected) {
    log(`🤖 ${llm.name}: моделирую ${proc.level} «${proc.name}»…`);
    const res = await askJson({
      llm,
      system,
      docs: block,
      task: modelTask({ proc, catalog, models }),
      validate: (m) => {
        const { issues } = checkModel(m, docs);
        if (m.id !== proc.id) issues.push({ level: 'error', rule: 'id', message: `id модели должен быть "${proc.id}"` });
        if (!issues.some((i) => i.rule === 'schema')) {
          const set = validateModelSet([...[...models.values()].filter((x) => x.id !== m.id), m].map((data) => ({ data })));
          issues.push(...set.filter((i) => i.level === 'warn' && i.message.includes(m.id)));
        }
        return issues;
      },
      retries,
      label: `model-${proc.id}`,
      logStep,
      log
    });
    if (!res.data || res.issues.some((i) => i.rule === 'schema' || i.rule === 'json')) {
      failed.push(proc.id);
      if (res.data) await writeFile(join(work, 'logs', `${proc.id}.invalid.json`), JSON.stringify(res.data, null, 2));
      log(`  ✖ ${proc.id}: ответ не соответствует схеме модели — см. ${join(work, 'logs')}`);
      continue;
    }
    models.set(proc.id, res.data);
    await writeFile(join(modelsDir, `${proc.id}.json`), JSON.stringify(res.data, null, 2) + '\n');
    const errs = res.issues.filter((i) => i.level === 'error');
    if (errs.length) failed.push(proc.id);
    log(`  ${errs.length ? '✖' : '✔'} ${proc.id}: ошибок ${errs.length}, замечаний ${res.issues.filter((i) => i.level === 'warn').length}`);
  }

  const build = await buildAll(modelsDir, { out: join(work, 'out'), formats, executable, docs });
  return { models: [...models.keys()], failed, build };
}
