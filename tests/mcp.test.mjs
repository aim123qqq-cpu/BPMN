import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBpmnServer } from '../src/mcp/server.mjs';

const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([createBpmnServer().connect(a), client.connect(b)]);
  return client;
}

test('MCP: инструменты, prompt и методика', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['bpmn_build', 'bpmn_check_catalog', 'bpmn_check_model', 'bpmn_extract', 'bpmn_render', 'bpmn_start']);
  for (const t of tools) assert.ok(t.description.length > 60, `${t.name}: описание должно объяснять модели, когда звать инструмент`);
  const guide = textOf(await client.callTool({ name: 'bpmn_start', arguments: {} }));
  for (const s of ['bpmn_extract', 'bpmn_check_catalog', 'Контрольная точка', 'JSON-схема модели', 'Чек-лист пробелов']) assert.ok(guide.includes(s), s);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, 'bpmn-analyst');
  const p = await client.getPrompt({ name: 'bpmn-analyst', arguments: { documents: 'C:/docs/r.docx' } });
  assert.match(p.messages[0].content.text, /C:\/docs\/r\.docx/);
  await client.close();
});

test('MCP: полный цикл extract → каталог → модели → сборка', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bpmn-mcp-'));
  const client = await connect();
  try {
    const ex = textOf(await client.callTool({ name: 'bpmn_extract', arguments: { paths: [resolve('samples/docs/reglament-zakupok.md')], work_dir: work } }));
    assert.match(ex, /\[§S3\.2\]/);

    // искажённая цитата → ошибка, каталог не принят молча
    const catalog = JSON.parse(await readFile('samples/models/catalog.json', 'utf8'));
    const broken = structuredClone(catalog);
    broken.processes[0].sources[0].quote = 'такого текста нет';
    assert.match(textOf(await client.callTool({ name: 'bpmn_check_catalog', arguments: { catalog: broken, work_dir: work } })), /❌ \[quote\]/);
    // строка с JSON тоже принимается
    const ok = textOf(await client.callTool({ name: 'bpmn_check_catalog', arguments: { catalog: JSON.stringify(catalog), work_dir: work } }));
    assert.match(ok, /^Ошибок: 0, замечаний: 0/);
    assert.match(ok, /Сохранено: .*catalog\.json/);

    for (const id of ['proc_procurement', 'proc_purchase', 'proc_contract', 'proc_tender']) {
      const model = JSON.parse(await readFile(`samples/models/${id}.json`, 'utf8'));
      const res = textOf(await client.callTool({ name: 'bpmn_check_model', arguments: { model, work_dir: work } }));
      assert.match(res, /^Ошибок: 0, замечаний: 0/, `${id}: ${res}`);
    }
    const bad = textOf(await client.callTool({ name: 'bpmn_check_model', arguments: { model: { id: 'x', name: 'x', level: 'L9', nodes: [], flows: [] }, work_dir: work } }));
    assert.match(bad, /Не сохранено/);

    const build = textOf(await client.callTool({ name: 'bpmn_build', arguments: { work_dir: work, formats: ['generic', 'camunda8', 'drawio'] } }));
    assert.match(build, /Вопросы заказчику/);
    const out = await readdir(join(work, 'out'));
    for (const f of ['proc_purchase.bpmn', 'proc_purchase.c8.bpmn', 'all-processes.drawio', 'preview.html', 'report.md']) assert.ok(out.includes(f), f);
  } finally {
    await client.close();
    await rm(work, { recursive: true, force: true });
  }
});

test('MCP: настоящий stdio-процесс (как его запускает клиент)', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp/server.mjs')], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'bpmn-agent');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    const res = await client.callTool({ name: 'bpmn_start', arguments: { topic: 'workflow' } });
    assert.match(textOf(res), /Режим MCP/);
  } finally {
    await client.close();
  }
});
