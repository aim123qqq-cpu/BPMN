import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSections, findQuote, extractDocument } from '../src/extract.mjs';
import { loadModels, validateModel, validateModelSet, validateCatalog, loadJsonFiles } from '../src/model.mjs';
import { layoutModel } from '../src/layout.mjs';
import { toBpmnXml, feelToJuel } from '../src/export/bpmn.mjs';
import { toDrawioDiagram } from '../src/export/drawio.mjs';
import { lintBpmn } from '../src/lint.mjs';

const MODELS = 'samples/models';
const minimal = () => ({
  id: 'p',
  name: 'Тест',
  level: 'L2',
  nodes: [
    { id: 's', type: 'startEvent', name: 'Старт' },
    { id: 't', type: 'task', name: 'Сделать работу' },
    { id: 'e', type: 'endEvent', name: 'Готово' }
  ],
  flows: [
    { id: 'f1', from: 's', to: 't' },
    { id: 'f2', from: 't', to: 'e' }
  ]
});

test('extract: нумерованные пункты и приложения становятся якорями', () => {
  const s = splitSections('# Регламент\n## 3. Закупка\n3.1. Инициатор подаёт заявку.\nПродолжение пункта.\n3.2. Руководитель согласует.\n## Приложение 1. Сроки\n| a | b |');
  const ids = s.map((x) => x.id);
  assert.ok(ids.includes('S3.1') && ids.includes('S3.2') && ids.includes('A1'), ids.join(','));
  const doc = { doc: 'x.md', sections: s };
  assert.deepEqual(findQuote(doc, 'инициатор  подаёт заявку', 'S3.1'), { found: true, section: 'S3.1', sectionMatches: true });
  assert.equal(findQuote(doc, 'такого текста нет').found, false);
});

test('extract: даты не считаются пунктами', () => {
  const s = splitSections('## 1. Общее\n01.02.2026 вступает в силу.');
  assert.ok(!s.some((x) => x.id.startsWith('S01')));
});

test('каталог примера валиден, цитаты находятся в документе', async () => {
  const [{ data }] = await loadJsonFiles(`${MODELS}/catalog.json`);
  assert.deepEqual(validateCatalog(data).filter((i) => i.level === 'error'), []);
  const doc = await extractDocument('samples/docs/reglament-zakupok.md');
  for (const p of data.processes) for (const src of p.sources ?? []) if (src.quote) assert.ok(findQuote(doc, src.quote).found, `${p.id}: ${src.quote}`);
});

test('модели примера: без ошибок и замечаний', async () => {
  const models = await loadModels(MODELS);
  assert.equal(models.length, 4);
  for (const { data } of models) {
    const bad = validateModel(data).filter((i) => i.level !== 'info');
    assert.deepEqual(bad, [], data.id);
  }
  assert.deepEqual(validateModelSet(models).filter((i) => i.level !== 'info'), []);
});

test('валидатор ловит структурные ошибки', () => {
  const m = minimal();
  m.flows.push({ id: 'f3', from: 't', to: 'nope' });
  m.nodes.push({ id: 'b', type: 'boundaryEvent', attachedTo: 's', event: 'timer', timer: 'P1D' });
  const rules = validateModel(m).map((i) => i.rule);
  assert.ok(rules.includes('flow-ref'));
  assert.ok(rules.includes('boundary-host'));

  const noEnd = minimal();
  noEnd.nodes.pop();
  noEnd.flows.pop();
  assert.ok(validateModel(noEnd).some((i) => i.rule === 'end-required'));

  const schema = minimal();
  schema.nodes[1].type = 'magicTask';
  assert.ok(validateModel(schema).some((i) => i.rule === 'schema'));
});

test('валидатор: правила стиля Method & Style', () => {
  const m = minimal();
  m.nodes[1].name = 'Согласование договора';
  assert.ok(validateModel(m).some((i) => i.rule === 'task-verb'));
});

test('межуровневая проверка: код ошибки в родителе и детализации', async () => {
  const models = await loadModels(MODELS);
  const tender = models.find((x) => x.data.id === 'proc_tender').data;
  tender.nodes.find((n) => n.id === 'e_failed').code = 'OTHER';
  assert.ok(validateModelSet(models).some((i) => i.rule === 'boundary-code'));
});

test('раскладка: фигуры не пересекаются, потоки ортогональны', async () => {
  for (const { data } of await loadModels(MODELS)) {
    const L = layoutModel(data);
    const boxes = data.nodes.filter((n) => n.type !== 'boundaryEvent').map((n) => [n.id, L.shapes.get(n.id)]);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, A] = boxes[i];
        const [b, B] = boxes[j];
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
        assert.ok(!overlap, `${data.id}: ${a} пересекается с ${b}`);
      }
    for (const [id, e] of L.edges)
      e.waypoints.slice(1).forEach((p, i) => {
        const q = e.waypoints[i];
        assert.ok(p.x === q.x || p.y === q.y, `${data.id}/${id}: диагональный сегмент`);
      });
  }
});

test('экспорт BPMN: все профили проходят bpmn-moddle и bpmnlint без ошибок', async () => {
  for (const { data } of await loadModels(MODELS)) {
    const L = layoutModel(data);
    for (const profile of ['generic', 'camunda7', 'camunda8'])
      for (const executable of [false, true]) {
        const { xml } = toBpmnXml(data, L, { profile, executable });
        const errors = (await lintBpmn(xml)).filter((i) => i.level === 'error');
        assert.deepEqual(errors, [], `${data.id} ${profile} exec=${executable}`);
      }
  }
});

test('экспорт BPMN: связь уровней и коды ошибок', async () => {
  const models = await loadModels(MODELS);
  const purchase = models.find((x) => x.data.id === 'proc_purchase').data;
  const c8 = toBpmnXml(purchase, layoutModel(purchase), { profile: 'camunda8' }).xml;
  assert.match(c8, /<zeebe:calledElement processId="proc_tender"/);
  assert.match(c8, /errorCode="TENDER_FAILED"/);
  const c7 = toBpmnXml(purchase, layoutModel(purchase), { profile: 'camunda7', executable: true }).xml;
  assert.match(c7, /calledElement="proc_tender"/);
  assert.match(c7, /\$\{amount &gt; 500000\}/);
});

test('FEEL → JUEL', () => {
  assert.equal(feelToJuel('approved = true'), 'approved == true');
  assert.equal(feelToJuel('a >= 1 and b != 2 or not(c)'), 'a >= 1 && b != 2 || !(c)');
});

test('экспорт draw.io: все элементы и ссылки на детализацию', async () => {
  for (const { data } of await loadModels(MODELS)) {
    const xml = toDrawioDiagram(data, layoutModel(data));
    assert.equal((xml.match(/<UserObject /g) ?? []).length, data.nodes.length, data.id);
    assert.equal((xml.match(/edge="1"/g) ?? []).length, data.flows.length, data.id);
    for (const n of data.nodes.filter((n) => n.ref)) assert.ok(xml.includes(`data:page/id,page_${n.ref}`));
  }
});

test('docx: HTML от mammoth → markdown с заголовками, списками и таблицами', async () => {
  const { htmlToMarkdown } = await import('../src/extract.mjs');
  const md = htmlToMarkdown(
    '<h2>3. Закупка</h2><p>3.1. Инициатор &amp; руководитель</p><ul><li>пункт</li></ul><table><tr><td><p>Этап</p></td><td>Срок</td></tr></table>'
  );
  assert.match(md, /^## 3\. Закупка$/m);
  assert.match(md, /^3\.1\. Инициатор & руководитель$/m);
  assert.match(md, /^- пункт$/m);
  assert.match(md, /^\| Этап \| Срок \|$/m);
  assert.ok(splitSections(md).some((s) => s.id === 'S3.1'));
});
