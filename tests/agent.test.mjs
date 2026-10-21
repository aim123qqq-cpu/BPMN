import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLLM, parseJsonResponse } from '../src/agent/llm.mjs';
import { runCatalog, runModels } from '../src/agent/run.mjs';
import { chatSystemPrompt, pipelineSystemPrompt, CHAT_PROMPT_PATH } from '../src/agent/prompts.mjs';

const sample = async (name) => JSON.parse(await readFile(`samples/models/${name}.json`, 'utf8'));
const lastText = (messages) => {
  const c = messages.at(-1).content;
  return typeof c === 'string' ? c : c.map((b) => b.text).join('\n');
};

test('parseJsonResponse: fenced-блок, голый JSON, мусор вокруг', () => {
  assert.deepEqual(parseJsonResponse('Вот:\n```json\n{"a":1}\n```\nготово'), { a: 1 });
  assert.deepEqual(parseJsonResponse('ответ {"a":{"b":2}} конец'), { a: { b: 2 } });
  assert.throws(() => parseJsonResponse('нет json'), /нет JSON/);
  assert.throws(() => parseJsonResponse('```json\n{"a":}\n```'), /корректным JSON/);
});

test('createLLM: пресеты и понятные ошибки', () => {
  assert.equal(createLLM({ provider: 'anthropic', apiKey: 'x' }).name, 'anthropic:claude-opus-5-5');
  assert.throws(() => createLLM({ provider: 'ollama' }), /укажите модель/);
  assert.throws(() => createLLM({ provider: 'openai-compatible', model: 'm' }), /base-url/);
  assert.throws(() => createLLM({ provider: 'nope' }), /Неизвестный провайдер/);
});

test('OpenAI-совместимый клиент: формат запроса и ответа', async () => {
  let seen;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{"ok":true}\n```' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const llm = createLLM({ provider: 'openai-compatible', model: 'local-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, apiKey: 'k', jsonMode: true });
    const text = await llm.complete({ system: 'SYS', messages: [{ role: 'user', content: [{ text: 'DOCS', cache: true }, { text: 'TASK' }] }] });
    assert.deepEqual(parseJsonResponse(text), { ok: true });
    assert.equal(seen.url, '/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer k');
    assert.equal(seen.body.model, 'local-model');
    assert.deepEqual(seen.body.messages, [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'DOCS\n\nTASK' }
    ]);
    assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  } finally {
    server.close();
  }
});

test('промпты собраны из методики; prompts/ актуален', async () => {
  const sys = pipelineSystemPrompt();
  for (const s of ['Поиск процессов', 'Правила моделирования', 'Чек-лист пробелов', 'JSON-схема модели']) assert.ok(sys.includes(s), s);
  assert.equal(await readFile(CHAT_PROMPT_PATH, 'utf8'), chatSystemPrompt(), 'запустите: node src/cli.mjs prompt');
});

test('агент: каталог с исправлением цитаты → модели → все форматы (подставная LLM)', async () => {
  const work = await mkdtemp(join(tmpdir(), 'bpmn-agent-test-'));
  const catalog = await sample('catalog');
  const calls = [];
  const llm = {
    name: 'fake',
    async complete({ system, messages }) {
      const task = lastText(messages.slice(0, 1)); // исходная задача диалога
      const isRepair = messages.length > 1;
      calls.push(isRepair ? `repair: ${lastText(messages)}` : task);
      assert.ok(system.includes('senior системный аналитик'));
      if (task.includes('Задача: каталог')) {
        if (isRepair) return JSON.stringify(catalog);
        // первая попытка — искажённая цитата: конвейер должен попросить исправить
        const broken = structuredClone(catalog);
        broken.processes[0].sources[0].quote = 'этой фразы в документе нет';
        return '```json\n' + JSON.stringify(broken) + '\n```';
      }
      const id = /Верни модель по схеме: id "([^"]+)"/.exec(task)[1];
      return '```json\n' + JSON.stringify(await sample(id)) + '\n```';
    }
  };
  try {
    const cat = await runCatalog({ llm, docPaths: ['samples/docs/reglament-zakupok.md'], work, log: () => {} });
    assert.equal(cat.ok, true);
    assert.equal(cat.catalog.processes.length, 9);
    assert.ok(existsSync(join(work, 'catalog.md')));
    assert.equal(calls.length, 2, 'одна попытка исправления');

    await assert.rejects(runModels({ llm, work, log: () => {} }), /нет подтверждённых/);

    const ids = ['proc_procurement', 'proc_purchase', 'proc_contract', 'proc_tender'];
    const before = calls.length;
    const res = await runModels({ llm, work, ids, formats: ['generic', 'camunda8', 'drawio'], log: () => {} });
    assert.deepEqual(res.failed, []);
    assert.equal(calls.length - before, 4, `эталонные модели не должны требовать исправлений: ${calls.slice(before).filter((c) => c.startsWith('repair')).join('\n')}`);
    assert.equal(res.build.results.filter((r) => !r.skipped).length, 4);
    const out = await readdir(join(work, 'out'));
    for (const f of ['proc_purchase.bpmn', 'proc_purchase.c8.bpmn', 'all-processes.drawio', 'preview.html', 'report.md']) assert.ok(out.includes(f), f);
    // родитель построен раньше детализации, и в задачу детализации передан код ошибки родителя
    const tenderTask = calls.find((t) => t.includes('id "proc_tender"'));
    assert.match(tenderTask, /code "TENDER_FAILED"/);
    assert.ok((await readdir(join(work, 'logs'))).length >= 6);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
