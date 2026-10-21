#!/usr/bin/env node
// MCP-сервер bpmn-agent: инструменты аналитика для любого MCP-клиента
// (Claude Desktop/Code, Cursor, VS Code Copilot, Codex, Gemini CLI, Windsurf, LM Studio…).
// Думает модель клиента; сервер разбирает документы, проверяет JSON, сверяет цитаты, раскладывает и экспортирует.
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, basename, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { extractDocument, toAnnotatedMarkdown } from '../extract.mjs';
import { validateCatalog, validateModelSet } from '../model.mjs';
import { catalogMarkdown } from '../report.mjs';
import { loadDocs, checkQuotes, quoteIssues, checkModel, buildAll } from '../pipeline.mjs';
import { renderPreview } from '../render.mjs';
import { mcpGuide, MCP_TOPICS } from '../agent/prompts.mjs';

const pkg = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
const FORMATS = ['generic', 'camunda7', 'camunda8', 'drawio'];

export const defaultWorkDir = () => resolve(process.env.BPMN_WORK_DIR ?? join(homedir(), 'bpmn-work'));

const workDirArg = z.string().optional().describe('Рабочая папка проекта (абсолютный путь). По умолчанию — BPMN_WORK_DIR или ~/bpmn-work');
const jsonArg = (what) =>
  z
    .union([z.string(), z.record(z.string(), z.any())])
    .describe(`${what}: JSON-объект (или строка с JSON)`);

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });
const asObject = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const ICON = { error: '❌', warn: '⚠', info: 'ℹ' };
function formatIssues(issues, { info = false } = {}) {
  const shown = issues.filter((i) => info || i.level !== 'info');
  const c = (l) => issues.filter((i) => i.level === l).length;
  const head = `Ошибок: ${c('error')}, замечаний: ${c('warn')}, инфо: ${c('info')}`;
  return [head, ...shown.map((i) => `${ICON[i.level]} [${i.rule}] ${i.message}`)].join('\n');
}

async function docsFor(work, docs) {
  if (docs?.length) return loadDocs(docs.map((d) => resolve(d)));
  const dir = join(work, 'extracted');
  return existsSync(dir) ? loadDocs(dir) : [];
}

async function loadSavedModels(work) {
  const dir = join(work, 'models');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) out.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
  return out;
}

export function createBpmnServer() {
  const server = new McpServer({ name: 'bpmn-agent', version: pkg.version });

  server.registerTool(
    'bpmn_start',
    {
      title: 'Методика BPMN-аналитика',
      description:
        'НАЧНИ ЗДЕСЬ при любой задаче про бизнес-процессы/BPMN (найти процессы в документах, каталог БП, BPMN-схемы ' +
        'для stormBPMN/Camunda/draw.io, вопросы по пробелам в регламенте). Возвращает методику senior-аналитика: ' +
        'порядок работы с инструментами bpmn_*, правила моделирования, JSON-форматы каталога и модели, эталон.',
      inputSchema: { topic: z.enum(MCP_TOPICS).optional().describe('Раздел методики; по умолчанию all — всё сразу') },
      annotations: { readOnlyHint: true }
    },
    async ({ topic }) => text(mcpGuide(topic ?? 'all'))
  );

  server.registerTool(
    'bpmn_extract',
    {
      title: 'Разобрать документы',
      description:
        'Извлекает текст из документов (.md .txt .docx .pdf) и размечает пункты якорями [§S3.2] — на них ссылаются ' +
        'source.section в каталоге и моделях. Сохраняет разметку в work_dir/extracted (по ней потом сверяются цитаты). ' +
        'Возвращает размеченный текст — прочитай его целиком.',
      inputSchema: {
        paths: z.array(z.string()).min(1).describe('Абсолютные пути к файлам документов'),
        work_dir: workDirArg
      }
    },
    async ({ paths, work_dir }) => {
      const work = resolve(work_dir ?? defaultWorkDir());
      await mkdir(join(work, 'extracted'), { recursive: true });
      const parts = [];
      for (const p of paths) {
        const ex = await extractDocument(resolve(p));
        const base = join(work, 'extracted', basename(p, extname(p)));
        await writeFile(`${base}.sections.json`, JSON.stringify(ex, null, 2));
        const md = toAnnotatedMarkdown(ex);
        await writeFile(`${base}.md`, md);
        parts.push(md);
      }
      return text(`work_dir: ${work}\nДокументов: ${paths.length}\n\n${parts.join('\n\n')}`);
    }
  );

  server.registerTool(
    'bpmn_check_catalog',
    {
      title: 'Проверить и сохранить каталог БП',
      description:
        'Проверяет catalog.json (JSON-схема, иерархия, ссылки) и дословность цитат по документам из bpmn_extract. ' +
        'Если структура верна — сохраняет work_dir/catalog.json и catalog.md. Вызывай повторно после исправлений и ' +
        'после подтверждения процессов пользователем (status "confirmed").',
      inputSchema: {
        catalog: jsonArg('Каталог процессов (формат — bpmn_start, раздел model-format)'),
        work_dir: workDirArg,
        docs: z.array(z.string()).optional().describe('Пути к документам, если не вызывался bpmn_extract')
      }
    },
    async ({ catalog, work_dir, docs }) => {
      const work = resolve(work_dir ?? defaultWorkDir());
      let data;
      try {
        data = asObject(catalog);
      } catch (e) {
        return fail(`catalog — не JSON: ${e.message}`);
      }
      const issues = validateCatalog(data);
      const loaded = await docsFor(work, docs);
      if (!issues.some((i) => i.rule === 'schema')) issues.push(...quoteIssues(checkQuotes(data, loaded)));
      const lines = [formatIssues(issues)];
      if (!loaded.length) lines.push('ℹ Цитаты не проверены: нет документов (вызови bpmn_extract или передай docs).');
      if (!issues.some((i) => i.rule === 'schema')) {
        await mkdir(work, { recursive: true });
        await writeFile(join(work, 'catalog.json'), JSON.stringify(data, null, 2) + '\n');
        const md = catalogMarkdown(data);
        await writeFile(join(work, 'catalog.md'), md);
        lines.push(`\nСохранено: ${join(work, 'catalog.json')}, ${join(work, 'catalog.md')}\n\n${md}`);
      }
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'bpmn_check_model',
    {
      title: 'Проверить и сохранить модель процесса',
      description:
        'Проверяет модель одного процесса: JSON-схема, семантика BPMN (старт/конец, тупики, достижимость), стиль ' +
        'Method & Style, дословность цитат, связи с уже сохранёнными моделями (ref, parent, коды ошибок). Если ' +
        'структура верна — сохраняет work_dir/models/<id>.json. Ошибки (❌) исправь и вызови снова.',
      inputSchema: {
        model: jsonArg('Модель процесса (формат — bpmn_start, раздел model-format)'),
        work_dir: workDirArg,
        docs: z.array(z.string()).optional().describe('Пути к документам, если не вызывался bpmn_extract')
      }
    },
    async ({ model, work_dir, docs }) => {
      const work = resolve(work_dir ?? defaultWorkDir());
      let m;
      try {
        m = asObject(model);
      } catch (e) {
        return fail(`model — не JSON: ${e.message}`);
      }
      const loaded = await docsFor(work, docs);
      const { issues } = checkModel(m, loaded);
      const schemaOk = !issues.some((i) => i.rule === 'schema');
      let setIssues = [];
      if (schemaOk) {
        const others = (await loadSavedModels(work)).filter((x) => x.id !== m.id);
        setIssues = validateModelSet([...others, m].map((data) => ({ data })));
      }
      const lines = [formatIssues(issues)];
      if (!loaded.length) lines.push('ℹ Цитаты не проверены: нет документов (вызови bpmn_extract или передай docs).');
      if (setIssues.length) lines.push('\nСвязи между уровнями:', formatIssues(setIssues, { info: true }));
      if (schemaOk) {
        await mkdir(join(work, 'models'), { recursive: true });
        await writeFile(join(work, 'models', `${m.id}.json`), JSON.stringify(m, null, 2) + '\n');
        lines.push(`\nСохранено: ${join(work, 'models', `${m.id}.json`)}`);
      } else lines.push('\nНе сохранено: исправь ошибки схемы.');
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'bpmn_build',
    {
      title: 'Собрать схемы',
      description:
        'Собирает все сохранённые модели (work_dir/models) в выбранные форматы: generic = BPMN 2.0 для stormBPMN и ' +
        'любых BPMN-редакторов, camunda7, camunda8, drawio (+ all-processes.drawio со страницами по уровням). ' +
        'Также preview.html (просмотр офлайн) и report.md (вопросы заказчику, допущения, трассировка). ' +
        'Модели с ошибками пропускаются.',
      inputSchema: {
        work_dir: workDirArg,
        formats: z.array(z.enum(FORMATS)).optional().describe('По умолчанию generic и drawio'),
        executable: z.boolean().optional().describe('Для Camunda: исполняемые схемы (task types, условия)'),
        out_dir: z.string().optional().describe('Куда сохранить; по умолчанию work_dir/out')
      }
    },
    async ({ work_dir, formats, executable, out_dir }) => {
      const work = resolve(work_dir ?? defaultWorkDir());
      const modelsDir = join(work, 'models');
      if (!existsSync(modelsDir)) return fail(`Нет моделей в ${modelsDir} — сначала bpmn_check_model.`);
      const out = resolve(out_dir ?? join(work, 'out'));
      const res = await buildAll(modelsDir, {
        out,
        formats: formats?.length ? formats : ['generic', 'drawio'],
        executable: !!executable,
        docs: await docsFor(work)
      });
      const lines = [];
      for (const r of res.results) lines.push(`\n${r.skipped ? '✖ ПРОПУЩЕН' : '✔'} ${r.level} ${r.name} (${r.id})`, formatIssues(r.issues));
      if (res.setIssues.length) lines.push('\nСвязи между уровнями:', formatIssues(res.setIssues, { info: true }));
      lines.push(`\nФайлы (${res.files.length}):`, ...res.files.map((f) => `- ${f}`));
      const report = await readFile(join(out, 'report.md'), 'utf8');
      const questions = /## Вопросы заказчику[\s\S]*?(?=\n## )/.exec(report)?.[0];
      lines.push('', report.split('\n').slice(0, 3).join('\n'));
      if (questions) lines.push('', questions.trim());
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'bpmn_render',
    {
      title: 'Показать схемы картинками',
      description:
        'Рендерит схемы из preview.html в PNG (нужен установленный Chrome или Edge) и возвращает изображения — ' +
        'для визуальной самопроверки раскладки. Вызывай после bpmn_build, если умеешь смотреть изображения.',
      inputSchema: {
        work_dir: workDirArg,
        ids: z.array(z.string()).optional().describe('id процессов; по умолчанию все')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ work_dir, ids }) => {
      const work = resolve(work_dir ?? defaultWorkDir());
      const preview = join(work, 'out', 'preview.html');
      if (!existsSync(preview)) return fail(`Нет ${preview} — сначала bpmn_build.`);
      let shots;
      try {
        shots = await renderPreview(preview, join(work, 'out', 'png'));
      } catch (e) {
        return fail(`Не удалось отрисовать: ${e.message}`);
      }
      const chosen = shots.filter((f) => !ids?.length || ids.includes(basename(f, '.png')));
      const content = [];
      for (const f of chosen) {
        content.push({ type: 'text', text: `${basename(f, '.png')}: ${f}` });
        content.push({ type: 'image', data: (await readFile(f)).toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    }
  );

  server.registerPrompt(
    'bpmn-analyst',
    {
      title: 'BPMN-аналитик',
      description: 'Найти бизнес-процессы в документах и построить BPMN-схемы (stormBPMN, Camunda, draw.io)',
      argsSchema: {
        documents: z.string().optional().describe('Пути к документам'),
        processes: z.string().optional().describe('Названия процессов через «;» — если нужны конкретные')
      }
    },
    async ({ documents, processes }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              mcpGuide('all'),
              '---',
              'Работай по методике выше, используя инструменты bpmn_*.',
              documents ? `Документы: ${documents}` : 'Сначала спроси, какие документы разобрать.',
              processes ? `Нужны процессы: ${processes}` : 'Режим: найти все процессы.'
            ].join('\n\n')
          }
        }
      ]
    })
  );

  return server;
}

// запуск как stdio-сервера (MCP-клиент стартует этот файл)
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  // stdout принадлежит протоколу: любой случайный console.log библиотек уводим в stderr
  console.log = console.info = console.warn = (...a) => console.error(...a);
  await createBpmnServer().connect(new StdioServerTransport());
}
