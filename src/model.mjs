// Загрузка и проверка канонических моделей: JSON-схема + семантика + правила стиля (Method & Style).
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ allErrors: true, useDefaults: true });
const schemas = {
  model: ajv.compile(JSON.parse(await readFile(join(here, '../schema/process-model.schema.json'), 'utf8'))),
  catalog: ajv.compile(JSON.parse(await readFile(join(here, '../schema/catalog.schema.json'), 'utf8')))
};

export const EVENTS = new Set(['startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent']);
export const GATEWAYS = new Set(['exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway']);
export const ACTIVITIES = new Set([
  'task', 'userTask', 'serviceTask', 'sendTask', 'receiveTask', 'manualTask', 'businessRuleTask', 'scriptTask', 'subProcess', 'callActivity'
]);

export async function loadJsonFiles(path) {
  const st = await stat(path);
  const files = st.isDirectory()
    ? (await readdir(path)).filter((f) => extname(f) === '.json').sort().map((f) => join(path, f))
    : [path];
  return Promise.all(files.map(async (file) => ({ file, data: JSON.parse(await readFile(file, 'utf8')) })));
}

const isCatalog = (d) => Array.isArray(d.processes) && !Array.isArray(d.nodes);

export async function loadModels(path) {
  return (await loadJsonFiles(path)).filter(({ data }) => !isCatalog(data));
}

function schemaIssues(validate, data) {
  if (validate(data)) return [];
  return validate.errors.map((e) => ({
    level: 'error',
    rule: 'schema',
    message: `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}${
      e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''
    }`
  }));
}

export function validateCatalog(catalog) {
  const issues = schemaIssues(schemas.catalog, catalog);
  if (issues.length) return issues;
  const ids = new Set();
  for (const p of catalog.processes) {
    if (ids.has(p.id)) issues.push({ level: 'error', rule: 'unique-id', message: `Повтор id процесса ${p.id}` });
    ids.add(p.id);
  }
  const order = { L0: 0, L1: 1, L2: 2, L3: 3 };
  const byId = new Map(catalog.processes.map((p) => [p.id, p]));
  for (const p of catalog.processes) {
    if (p.parent && !byId.has(p.parent)) issues.push({ level: 'error', rule: 'parent', message: `${p.id}: родитель ${p.parent} не найден` });
    else if (p.parent && order[byId.get(p.parent).level] >= order[p.level])
      issues.push({ level: 'warn', rule: 'hierarchy', message: `${p.id} (${p.level}) не глубже родителя ${p.parent} (${byId.get(p.parent).level})` });
    if (!p.sources?.length && p.confidence !== 'assumption')
      issues.push({ level: 'warn', rule: 'traceability', message: `${p.id}: нет ссылок на источник` });
  }
  return issues;
}

/**
 * Проверка одной модели. Возвращает [{level:'error'|'warn'|'info', rule, message, element}].
 * error — экспорт невозможен/некорректен; warn — нарушение стиля или полноты.
 */
export function validateModel(m) {
  const issues = schemaIssues(schemas.model, m);
  if (issues.length) return issues;

  const add = (level, rule, message, element) => issues.push({ level, rule, message, element });
  const ids = new Map();
  for (const x of [...(m.lanes ?? []), ...m.nodes, ...m.flows]) {
    if (ids.has(x.id)) add('error', 'unique-id', `Повторяющийся id "${x.id}"`, x.id);
    ids.set(x.id, x);
  }
  const nodes = new Map(m.nodes.map((n) => [n.id, n]));
  const laneIds = new Set((m.lanes ?? []).map((l) => l.id));
  const out = new Map(m.nodes.map((n) => [n.id, []]));
  const inc = new Map(m.nodes.map((n) => [n.id, []]));

  for (const f of m.flows) {
    const a = nodes.get(f.from);
    const b = nodes.get(f.to);
    if (!a) add('error', 'flow-ref', `Поток ${f.id}: источник "${f.from}" не найден`, f.id);
    if (!b) add('error', 'flow-ref', `Поток ${f.id}: цель "${f.to}" не найдена`, f.id);
    if (!a || !b) continue;
    out.get(a.id).push(f);
    inc.get(b.id).push(f);
    if (b.type === 'boundaryEvent') add('error', 'boundary-incoming', `Граничное событие ${b.id} не может иметь входящих потоков`, f.id);
  }

  for (const n of m.nodes) {
    const o = out.get(n.id);
    const i = inc.get(n.id);
    if (laneIds.size) {
      if (!n.lane && n.type !== 'boundaryEvent') add('error', 'lane', `${n.id}: не указана дорожка`, n.id);
      else if (n.lane && !laneIds.has(n.lane)) add('error', 'lane', `${n.id}: дорожка "${n.lane}" не найдена`, n.id);
    }
    if (n.type === 'boundaryEvent') {
      const host = nodes.get(n.attachedTo);
      if (!host || !ACTIVITIES.has(host.type)) add('error', 'boundary-host', `${n.id}: attachedTo должен ссылаться на активность`, n.id);
      if (!n.event || n.event === 'none') add('error', 'boundary-event', `${n.id}: у граничного события должен быть тип (timer/error/message...)`, n.id);
      if (!o.length) add('warn', 'boundary-outgoing', `${n.id}: у граничного события нет исходящего потока`, n.id);
    }
    if (n.type === 'startEvent' && i.length) add('error', 'start-incoming', `Стартовое событие ${n.id} имеет входящие потоки`, n.id);
    if (n.type === 'endEvent' && o.length) add('error', 'end-outgoing', `Конечное событие ${n.id} имеет исходящие потоки`, n.id);
    if (n.type !== 'startEvent' && n.type !== 'boundaryEvent' && !i.length)
      add('warn', 'no-incoming', `${n.id} «${n.name ?? ''}»: нет входящих потоков`, n.id);
    if (n.type !== 'endEvent' && !o.length) add('warn', 'no-outgoing', `${n.id} «${n.name ?? ''}»: нет исходящих потоков (тупик)`, n.id);
    if (n.event === 'timer' && !n.timer) add('warn', 'timer-value', `${n.id}: у таймера нет значения (timer: P3D, PT4H…)`, n.id);
    if ((n.type === 'callActivity' || n.type === 'subProcess') && !n.ref)
      add('warn', 'call-ref', `${n.id}: подпроцесс без ref — детализация не связана`, n.id);

    // --- стиль ---
    if (!n.name?.trim() && !(GATEWAYS.has(n.type) && i.length > 1 && o.length === 1))
      add('warn', 'label-required', `${n.id} (${n.type}): нет названия`, n.id);
    if (ACTIVITIES.has(n.type) && n.type !== 'callActivity' && n.type !== 'subProcess' && n.name) {
      const first = n.name.trim().split(/\s+/)[0].toLowerCase();
      if (/(ние|тие|ция|ка|ок)$/.test(first) && first.length > 4)
        add('warn', 'task-verb', `${n.id} «${n.name}»: задача должна называться «глагол + объект» (например «Согласовать договор»)`, n.id);
    }
    if (n.type === 'exclusiveGateway' && o.length > 1) {
      if (n.name && !n.name.trim().endsWith('?')) add('warn', 'gateway-question', `${n.id} «${n.name}»: шлюз-ветвление лучше формулировать вопросом`, n.id);
      const unnamed = o.filter((f) => !f.name && !f.default);
      if (unnamed.length) add('warn', 'branch-label', `${n.id}: ветки без подписи: ${unnamed.map((f) => f.id).join(', ')}`, n.id);
      if (o.filter((f) => f.default).length > 1) add('error', 'default-flow', `${n.id}: больше одного default-потока`, n.id);
    }
    if (GATEWAYS.has(n.type) && i.length > 1 && o.length > 1)
      add('warn', 'mixed-gateway', `${n.id}: шлюз одновременно сливает и ветвит — разделите на два`, n.id);
    if (GATEWAYS.has(n.type) && i.length <= 1 && o.length <= 1)
      add('warn', 'useless-gateway', `${n.id}: шлюз без ветвления/слияния`, n.id);
    if (n.type === 'eventBasedGateway') {
      for (const f of o) {
        const t = nodes.get(f.to);
        if (t && !(t.type === 'intermediateCatchEvent' || t.type === 'receiveTask'))
          add('error', 'event-gateway-target', `${n.id}: после событийного шлюза должны идти промежуточные события`, f.id);
      }
    }
    if (ACTIVITIES.has(n.type) && o.length > 1)
      add('warn', 'implicit-split', `${n.id}: несколько исходящих потоков из задачи — используйте явный шлюз`, n.id);
    if ((ACTIVITIES.has(n.type) || n.type === 'endEvent') && i.length > 1)
      add('warn', 'implicit-join', `${n.id}: несколько входящих потоков — используйте шлюз слияния`, n.id);
    if (!n.source && n.confidence !== 'assumption')
      add('info', 'traceability', `${n.id}: нет ссылки на источник (source) и не помечено как assumption`, n.id);
  }

  for (const f of m.flows) {
    const a = nodes.get(f.from);
    if (f.default && a && !['exclusiveGateway', 'inclusiveGateway'].includes(a.type) && !ACTIVITIES.has(a.type))
      add('error', 'default-flow', `${f.id}: default-поток допустим только из шлюза/активности`, f.id);
  }

  const starts = m.nodes.filter((n) => n.type === 'startEvent');
  const ends = m.nodes.filter((n) => n.type === 'endEvent');
  if (!starts.length) add('error', 'start-required', 'Нет стартового события');
  if (!ends.length) add('error', 'end-required', 'Нет конечного события');

  // Достижимость: из стартов (и граничных событий) — вперёд; до конечных — назад.
  const succ = (id) => [
    ...out.get(id).map((f) => f.to),
    ...m.nodes.filter((b) => b.type === 'boundaryEvent' && b.attachedTo === id).map((b) => b.id)
  ];
  const reach = new Set();
  const stack = starts.map((s) => s.id);
  while (stack.length) {
    const id = stack.pop();
    if (reach.has(id) || !nodes.has(id)) continue;
    reach.add(id);
    stack.push(...succ(id));
  }
  for (const n of m.nodes) if (starts.length && !reach.has(n.id)) add('warn', 'unreachable', `${n.id} «${n.name ?? ''}»: недостижим из старта`, n.id);

  const back = new Set();
  const bstack = ends.map((e) => e.id);
  const pred = (id) => [
    ...inc.get(id).map((f) => f.from),
    ...(nodes.get(id)?.type === 'boundaryEvent' ? [nodes.get(id).attachedTo] : [])
  ];
  while (bstack.length) {
    const id = bstack.pop();
    if (back.has(id) || !nodes.has(id)) continue;
    back.add(id);
    bstack.push(...pred(id));
  }
  for (const n of m.nodes)
    if (ends.length && reach.has(n.id) && !back.has(n.id)) add('warn', 'no-end', `${n.id} «${n.name ?? ''}»: из этого элемента нельзя дойти до конца`, n.id);

  if (m.level === 'L0' || m.level === 'L1') {
    const detailed = m.nodes.filter((n) => ['userTask', 'serviceTask', 'scriptTask', 'businessRuleTask'].includes(n.type));
    if (detailed.length > 3) add('warn', 'level-detail', `${m.level}: ${detailed.length} детальных задач — для обзорного уровня используйте подпроцессы/callActivity`);
  }
  if (m.nodes.filter((n) => ACTIVITIES.has(n.type)).length > 30)
    add('warn', 'too-big', 'Больше 30 активностей — разбейте на подпроцессы');

  return issues;
}

/** Проверки между моделями: ссылки ref, иерархия уровней. */
export function validateModelSet(models) {
  const issues = [];
  const byId = new Map(models.map(({ data }) => [data.id, data]));
  const order = { L0: 0, L1: 1, L2: 2, L3: 3 };
  for (const { data: m } of models) {
    for (const n of m.nodes ?? []) {
      if (!n.ref) continue;
      const child = byId.get(n.ref);
      if (!child) issues.push({ level: 'info', rule: 'ref-missing', message: `${m.id}/${n.id}: детализация ${n.ref} ещё не смоделирована` });
      else if (order[child.level] <= order[m.level])
        issues.push({ level: 'warn', rule: 'ref-level', message: `${m.id}/${n.id}: ${n.ref} (${child.level}) должен быть глубже ${m.level}` });
      else if (child.parent && child.parent !== m.id)
        issues.push({ level: 'warn', rule: 'ref-parent', message: `${n.ref}.parent = ${child.parent}, но вызывается из ${m.id}` });
      if (!child) continue;
      // граничная ошибка/эскалация на вызове должна быть брошена в детализации с тем же code
      for (const b of m.nodes.filter((x) => x.type === 'boundaryEvent' && x.attachedTo === n.id && ['error', 'escalation'].includes(x.event))) {
        const thrown = child.nodes.filter((x) => (x.type === 'endEvent' || x.type === 'intermediateThrowEvent') && x.event === b.event);
        if (!thrown.some((x) => (x.code ?? x.id) === (b.code ?? b.id)))
          issues.push({
            level: 'warn',
            rule: 'boundary-code',
            message: `${m.id}/${b.id}: ловит ${b.event} «${b.code ?? b.id}», но ${n.ref} не бросает событие с таким code${
              thrown.length ? ` (бросает: ${thrown.map((x) => x.code ?? x.id).join(', ')})` : ''
            }`
          });
      }
    }
    if (m.parent && byId.has(m.parent)) {
      const p = byId.get(m.parent);
      if (!p.nodes.some((n) => n.ref === m.id))
        issues.push({ level: 'warn', rule: 'parent-link', message: `${m.id}: родитель ${m.parent} не содержит подпроцесса с ref=${m.id}` });
    }
  }
  return issues;
}

export function iterSources(data) {
  const out = [];
  const visit = (owner, x) => x?.source && out.push({ owner, ...x.source });
  if (isCatalog(data)) for (const p of data.processes) for (const s of p.sources ?? []) out.push({ owner: p.id, ...s });
  else {
    for (const x of [...(data.lanes ?? []), ...data.nodes, ...data.flows]) visit(`${data.id}/${x.id}`, x);
    for (const g of data.gaps ?? []) visit(`${data.id}/${g.id}`, g);
  }
  return out;
}
