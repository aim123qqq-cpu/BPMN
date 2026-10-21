// Промпты собираются из той же методики, что читают агенты (skills/bpmn-analyst) — единый источник правил.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripFrontmatter = (s) => s.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
export const CHAT_PROMPT_PATH = 'prompts/bpmn-analyst.chat.md';
const REFS = ['discovery', 'modeling-rules', 'gap-checklist', 'model-format'];

function references() {
  return REFS.map((r) => stripFrontmatter(read(`skills/bpmn-analyst/references/${r}.md`)).replace(/^# /m, '## ')).join('\n\n---\n\n');
}

function schemas() {
  const compact = (p) => JSON.stringify(JSON.parse(read(p)));
  return [
    '## JSON-схема catalog.json',
    '```json',
    compact('schema/catalog.schema.json'),
    '```',
    '',
    '## JSON-схема модели процесса (models/<id>.json)',
    '```json',
    compact('schema/process-model.schema.json'),
    '```'
  ].join('\n');
}

function example() {
  return [
    '## Эталон: модель L2 «Проведение закупки» (по синтетическому регламенту закупок)',
    'Ориентир по детальности, достоверности, цитатам, исключениям и пробелам. Не копируй содержание — только подход.',
    '```json',
    JSON.stringify(JSON.parse(read('samples/models/proc_purchase.json'))),
    '```'
  ].join('\n');
}

const ROLE = `# Роль

Ты — senior системный аналитик. Строишь из документации проверяемые модели бизнес-процессов в нотации BPMN 2.0:
каждый элемент прослеживается до пункта документа (дословная цитата), всё, чего в документе нет, помечено как
допущение (confidence: "assumption") и превращено в вопрос заказчику. Пиши по-русски (названия, вопросы, заметки);
id — латиницей.`;

/** Системный промпт встроенного агента (src/agent): модель отвечает JSON на задачи конвейера. */
export function pipelineSystemPrompt() {
  return [
    ROLE,
    `# Протокол работы

Ты работаешь внутри автоматического конвейера bpmn-agent. На каждом шаге получаешь документы (размечены якорями
[§S3.2]) и задачу. Отвечай **одним** блоком \`\`\`json без пояснений вокруг. Код проверит ответ (JSON-схема,
семантика BPMN, правила стиля, дословность цитат) и, если есть ошибки, пришлёт их — тогда верни исправленный
JSON **целиком**. Раскладку, экспорт в форматы и отчёты делает код — координаты не нужны.

Правила честности:
- не выдумывай шаги, роли, сроки и условия; нужен элемент для связности — confidence "assumption" + notes + gap;
- confidence "explicit" — только если это прямо написано в цитате; логический вывод — "inferred";
- source.quote — короткий (5–15 слов) **точный** фрагмент текста документа, source.section — id якоря без «§»;
- противоречия между разделами не разрешай молча — обе версии в notes/sla + gap с severity "high".`,
    references(),
    schemas(),
    example()
  ].join('\n\n');
}

/** Самодостаточный промпт для чат-нейросетей без инструментов (ChatGPT, GigaChat, YandexGPT, DeepSeek…). */
export function chatSystemPrompt() {
  return [
    '<!-- Сгенерировано: node src/cli.mjs prompt. Не редактируйте вручную — правьте skills/bpmn-analyst/ -->',
    ROLE,
    stripFrontmatter(read('skills/bpmn-analyst/chat-mode.md')),
    '# Справочники',
    references(),
    '# Формат файлов',
    schemas(),
    example()
  ].join('\n\n') + '\n';
}

/** Методика для MCP-клиентов (инструмент bpmn_start / prompt bpmn-analyst). */
export const MCP_TOPICS = ['all', 'workflow', 'discovery', 'modeling-rules', 'gap-checklist', 'model-format', 'schemas', 'example'];
export function mcpGuide(topic = 'all') {
  const ref = (r) => stripFrontmatter(read(`skills/bpmn-analyst/references/${r}.md`));
  const parts = {
    workflow: () => [ROLE, stripFrontmatter(read('skills/bpmn-analyst/mcp-mode.md'))].join('\n\n'),
    discovery: () => ref('discovery'),
    'modeling-rules': () => ref('modeling-rules'),
    'gap-checklist': () => ref('gap-checklist'),
    'model-format': () => ref('model-format'),
    schemas,
    example
  };
  if (topic !== 'all') return parts[topic]();
  return [parts.workflow(), '# Справочники', references(), '# Формат файлов', schemas(), example()].join('\n\n');
}

export function catalogTask({ names } = {}) {
  const mode = names?.length
    ? `Режим Б — по списку процессов пользователя:\n${names.map((n) => `- ${n}`).join('\n')}\n
Для каждого названия найди описание; не подменяй похожим процессом. Не найден — включи с notes «в документах не описан»,
coverage "mention" (если есть упоминание) и confidence "assumption". Процессы вне списка, без которых названные
непонятны (вызываются из них), можно добавить со status "proposed" и пометкой в notes.`
    : 'Режим А — найди все бизнес-процессы в документах (по разделу «Поиск процессов в документации»).';
  return `# Задача: каталог бизнес-процессов

${mode}

Верни catalog.json по схеме: documents (имена файлов документов — как в заголовке «doc:»), processes (иерархия
через parent, уровни L0–L3, trigger/result/owner/participants/systems, aliases, sources с дословными цитатами,
coverage, confidence, status "proposed"), gaps (по чек-листу пробелов; вопросы — готовые для заказчика).`;
}

export function modelTask({ proc, catalog, models }) {
  const byId = new Map(catalog.processes.map((p) => [p.id, p]));
  const children = catalog.processes.filter((p) => p.parent === proc.id);
  const parent = proc.parent ? byId.get(proc.parent) : null;
  const parentModel = parent ? models.get(parent.id) : null;
  const callsThis = parentModel?.nodes?.filter((n) => n.ref === proc.id) ?? [];
  const lines = [
    `# Задача: модель процесса «${proc.name}» (${proc.level})`,
    '',
    'Запись каталога (подтверждена пользователем):',
    '```json',
    JSON.stringify(proc, null, 1),
    '```'
  ];
  if (children.length)
    lines.push(
      '',
      'Детализации этого процесса в каталоге — вызывай их через callActivity с ref = id и именем, близким к названию:',
      ...children.map((c) => `- ${c.id} — ${c.name} (${c.level})`)
    );
  if (parentModel) {
    lines.push('', `Родительская модель ${parent.id} уже построена. Узлы, вызывающие этот процесс:`);
    for (const n of callsThis) {
      lines.push(`- ${n.id} «${n.name}»`);
      for (const b of parentModel.nodes.filter((x) => x.type === 'boundaryEvent' && x.attachedTo === n.id))
        lines.push(`  - родитель ловит ${b.event} «${b.name ?? ''}» с code "${b.code ?? b.id}" — брось его конечным событием с тем же code`);
    }
  }
  const relatedGaps = (catalog.gaps ?? []).filter((g) => g.process === proc.id);
  if (relatedGaps.length) lines.push('', 'Пробелы, уже найденные на уровне каталога (перенеси в gaps модели, привязав к узлам):', ...relatedGaps.map((g) => `- ${g.id}: ${g.text}`));
  lines.push(
    '',
    `Верни модель по схеме: id "${proc.id}", level "${proc.level}"${proc.parent ? `, parent "${proc.parent}"` : ''}, все исключения из документа,`,
    'дорожки — роли (для L0/L1 дорожки не нужны), у каждого узла source с дословной цитатой или confidence "assumption" + notes, gaps.'
  );
  return lines.join('\n');
}

export function repairTask(issues) {
  const shown = issues.filter((i) => i.level !== 'info').slice(0, 40);
  return `Проверка нашла проблемы — исправь и верни JSON целиком (один блок \`\`\`json):

${shown.map((i) => `- [${i.level}] ${i.rule}: ${i.message}`).join('\n')}

Подсказки: «цитата не найдена» — скопируй фрагмент из документа дословно (или убери quote и поставь confidence
"assumption"); «указан не тот раздел» — поправь section; замечания стиля (warn) исправь, если это не противоречит документу.`;
}
