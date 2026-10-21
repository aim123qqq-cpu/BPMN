// Общие операции конвейера: документы, сверка цитат, валидация, сборка всех форматов.
// Используются CLI и встроенным агентом (src/agent).
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { extractDocument, findQuote } from './extract.mjs';
import { loadModels, validateModel, validateModelSet, iterSources } from './model.mjs';
import { layoutModel } from './layout.mjs';
import { toBpmnXml, PROFILES } from './export/bpmn.mjs';
import { toDrawioDiagram, toDrawioFile } from './export/drawio.mjs';
import { toPreviewHtml } from './export/preview.mjs';
import { lintBpmn } from './lint.mjs';
import { modelsReport } from './report.mjs';

export const DOC_EXT = ['.md', '.txt', '.docx', '.pdf'];
const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** Папка или файл(ы) документов → извлечённые документы. Понимает и готовые *.sections.json. */
export async function loadDocs(paths) {
  const list = [paths].flat().filter(Boolean);
  const docs = [];
  for (const p of list) {
    const files = (await stat(p)).isDirectory() ? (await readdir(p)).sort().map((f) => join(p, f)) : [p];
    const extracted = new Set(files.filter((f) => f.endsWith('.sections.json')).map((f) => f.slice(0, -'.sections.json'.length)));
    for (const f of files) {
      if (f.endsWith('.sections.json')) docs.push(JSON.parse(await readFile(f, 'utf8')));
      // размеченный .md рядом с .sections.json — производный файл extract, не исходный документ
      else if (extracted.has(f.slice(0, -extname(f).length))) continue;
      else if (DOC_EXT.includes(extname(f).toLowerCase())) docs.push(await extractDocument(f));
    }
  }
  return docs;
}

export function checkQuotes(data, docs) {
  const results = [];
  for (const s of iterSources(data)) {
    if (!s.quote) continue;
    const d = docs.find((x) => x.doc === s.doc || basename(x.doc, extname(x.doc)) === basename(s.doc, extname(s.doc)));
    if (!d) {
      results.push({ ...s, found: false, sectionMatches: false, reason: 'документ не найден' });
      continue;
    }
    const r = findQuote(d, s.quote, s.section);
    results.push({ ...s, found: r.found, sectionMatches: r.found && r.sectionMatches, foundIn: r.section });
  }
  return results;
}

export const quoteIssues = (checks) =>
  checks
    .filter((q) => !q.found || !q.sectionMatches)
    .map((q) => ({
      level: q.found ? 'warn' : 'error',
      rule: 'quote',
      message: q.found
        ? `${q.owner}: цитата найдена в §${q.foundIn}, а указан §${q.section}`
        : `${q.owner}: цитата не найдена в ${q.doc}${q.reason ? ` (${q.reason})` : ''}: «${q.quote.slice(0, 80)}»`
    }));

/** Проверка одной модели вместе со сверкой цитат. */
export function checkModel(data, docs = []) {
  const issues = validateModel(data);
  let checks = [];
  if (docs.length && !issues.some((i) => i.rule === 'schema')) {
    checks = checkQuotes(data, docs);
    issues.push(...quoteIssues(checks));
  }
  return { issues, checks };
}

export async function validateAll(path, docs = []) {
  const models = await loadModels(path);
  const byId = new Map();
  let allChecks = [];
  for (const { file, data } of models) {
    const { issues, checks } = checkModel(data, docs);
    allChecks = allChecks.concat(checks);
    byId.set(data.id ?? file, issues);
  }
  const ok = models.filter(({ data }) => !(byId.get(data.id) ?? []).some((i) => i.rule === 'schema'));
  const setIssues = validateModelSet(ok);
  return { models, ok, byId, setIssues, allChecks };
}

/**
 * Сборка всех форматов из папки моделей.
 * Возвращает { files, results: [{ id, name, level, file, skipped, issues }], setIssues }.
 */
export async function buildAll(path, { out = 'out/build', formats = ['generic', 'drawio'], executable = false, docs = [], cdn = false } = {}) {
  for (const f of formats) if (f !== 'drawio' && !PROFILES[f]) throw new Error(`Неизвестный формат ${f}`);
  await mkdir(out, { recursive: true });
  const { models, ok, byId, setIssues, allChecks } = await validateAll(path, docs);
  const files = [];
  const results = [];
  const built = [];
  const previewItems = [];

  for (const { file, data: m } of models) {
    const issues = byId.get(m.id ?? file);
    if (issues.some((i) => i.level === 'error')) {
      results.push({ id: m.id, name: m.name, level: m.level, file, skipped: true, issues });
      continue;
    }
    const layout = layoutModel(m);
    for (const fmt of formats) {
      if (fmt === 'drawio') {
        const p = join(out, `${m.id}.drawio`);
        await writeFile(p, toDrawioFile([toDrawioDiagram(m, layout)]));
        files.push(p);
        continue;
      }
      const { xml, warnings } = toBpmnXml(m, layout, { profile: fmt, executable });
      const p = join(out, `${m.id}${PROFILES[fmt].ext}`);
      await writeFile(p, xml);
      files.push(p);
      issues.push(...warnings.map((w) => ({ level: 'warn', rule: fmt, message: w })));
      issues.push(...(await lintBpmn(xml)).map((i) => ({ ...i, rule: `${fmt}:${i.rule}` })));
    }
    const { xml: previewXml } = toBpmnXml(m, layout, { profile: 'generic' });
    if (!formats.some((f) => f !== 'drawio')) issues.push(...(await lintBpmn(previewXml)).map((i) => ({ ...i, rule: `generic:${i.rule}` })));
    previewItems.push({
      id: m.id,
      name: m.name,
      level: m.level,
      xml: previewXml,
      assumptions: [...m.nodes, ...m.flows].filter((x) => x.confidence === 'assumption').map((x) => x.id),
      issues: issues.filter((i) => i.level !== 'info')
    });
    built.push({ m, layout });
    results.push({ id: m.id, name: m.name, level: m.level, file, skipped: false, issues });
  }

  built.sort((a, b) => LEVEL_ORDER[a.m.level] - LEVEL_ORDER[b.m.level]);
  if (formats.includes('drawio') && built.length > 1) {
    const p = join(out, 'all-processes.drawio');
    await writeFile(p, toDrawioFile(built.map(({ m, layout }) => toDrawioDiagram(m, layout))));
    files.push(p);
  }
  previewItems.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  if (previewItems.length) {
    const p = join(out, 'preview.html');
    await writeFile(p, toPreviewHtml(previewItems, { cdn }));
    files.push(p);
  }
  const reportPath = join(out, 'report.md');
  await writeFile(reportPath, modelsReport(ok.map((x) => x.data), byId, allChecks));
  files.push(reportPath);
  return { files, results, setIssues };
}
