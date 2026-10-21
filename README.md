# bpmn-agent

AI-агент уровня senior системного аналитика: находит бизнес-процессы в документации и строит BPMN-диаграммы
уровней L0–L3 с экспортом в **stormBPMN** (BPMN 2.0), **Camunda 7**, **Camunda 8** и **draw.io**.

Работает с **любой нейросетью**:
- как **MCP-сервер** для любого клиента с поддержкой MCP: Claude Desktop/Code, Cursor, VS Code Copilot, Codex,
  Gemini CLI, Windsurf, LM Studio. API-ключи не нужны: думает модель вашего клиента;
- как навык для AI-агентов (через AGENTS.md);
- как промпт для обычного чата (ChatGPT, GigaChat, YandexGPT, DeepSeek);
- как самостоятельный агент через API любой модели, включая локальные.

## Принцип

Нейросеть делает работу аналитика: читает документы, выделяет процессы, моделирует, ищет пробелы.
Детерминированный Node-инструментарий делает всё остальное: проверки, сверку цитат, раскладку, экспорт и отчёты.
Поэтому качество схем не зависит от того, умеет ли модель рисовать XML.

```
Документы (.md .txt .docx .pdf)
   │ extract — разделы с якорями [§S3.2]
   ▼
Каталог БП (catalog.json) ── проверка схемы + сверка цитат с документом → catalog.md
   │ ⛔ подтверждение пользователем
   ▼
Модели процессов (models/*.json) ── структура, стиль Method & Style, связи уровней, цитаты
   │ build
   ▼
*.bpmn (stormBPMN) · *.c7.bpmn · *.c8.bpmn · *.drawio · all-processes.drawio · preview.html · report.md
```

- **Одна каноническая модель** → все форматы с одинаковой геометрией.
- **Трассируемость**: у каждого элемента есть источник (документ, пункт, дословная цитата). Цитаты сверяются
  с документом автоматически, поэтому выдуманная цитата — это ошибка валидации.
- **Честность**: всё, чего нет в документе, помечается как допущение (на схемах — жёлтый пунктир) и превращается
  в вопрос заказчику в `report.md`.

## Установка

```bash
git clone https://github.com/aim123qqq-cpu/BPMN.git bpmn-agent
cd bpmn-agent
npm install
npm test
npm run demo      # пример: регламент закупок → 4 схемы L1–L3 во всех форматах → out/demo/
```

Нужен Node.js ≥ 20. Откройте `out/demo/preview.html` (работает без интернета) и `out/demo/report.md`.

## Способы запуска

### 1. MCP-сервер (рекомендуется)

Подключите сервер в своём клиенте и попросите обычными словами, например: «найди бизнес-процессы в
`C:/docs/регламент.docx` и построй схемы для stormBPMN». Клиент сам вызовет `bpmn_start`, получит методику и
дальше будет работать инструментами:

| Инструмент | Что делает |
|---|---|
| `bpmn_start` | Методика аналитика: порядок работы, правила, JSON-форматы, эталон |
| `bpmn_extract` | Документы (.md .txt .docx .pdf) → текст с якорями `[§S3.2]` |
| `bpmn_check_catalog` | Проверка каталога + сверка цитат → `catalog.json`, `catalog.md` |
| `bpmn_check_model` | Проверка модели процесса (BPMN, стиль, цитаты, связи уровней) → `models/<id>.json` |
| `bpmn_build` | Сборка: stormBPMN/BPMN 2.0, Camunda 7/8, draw.io, `preview.html`, `report.md` |
| `bpmn_render` | PNG схем для визуальной самопроверки (нужен Chrome или Edge) |

Ещё есть prompt `bpmn-analyst` (в клиентах, которые поддерживают MCP prompts, — через «/»).

Результаты сохраняются в рабочую папку: `BPMN_WORK_DIR`, по умолчанию `~/bpmn-work`. Ниже `<путь>` — это папка,
куда вы склонировали репозиторий (используйте прямые слэши: `C:/Users/me/bpmn-agent`).

**Claude Desktop** — Settings → Developer → Edit Config (`claude_desktop_config.json`).
**Cursor** — `~/.cursor/mcp.json`. **Gemini CLI** — `~/.gemini/settings.json`.
**Windsurf** — `~/.codeium/windsurf/mcp_config.json`. **LM Studio** (локальные модели) — Program → Edit `mcp.json`:

```json
{
  "mcpServers": {
    "bpmn-agent": {
      "command": "node",
      "args": ["<путь>/src/mcp/server.mjs"],
      "env": { "BPMN_WORK_DIR": "C:/Users/me/bpmn-work" }
    }
  }
}
```

**Claude Code:** `claude mcp add bpmn-agent -- node <путь>/src/mcp/server.mjs`. Если открыть папку репозитория,
сервер подхватится сам из `.mcp.json`.

**VS Code (Copilot, agent mode):** в папке репозитория сервер подхватится из `.vscode/mcp.json`. Для других папок
добавьте в их `.vscode/mcp.json`:

```json
{ "servers": { "bpmn-agent": { "type": "stdio", "command": "node", "args": ["<путь>/src/mcp/server.mjs"] } } }
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.bpmn-agent]
command = "node"
args = ["<путь>/src/mcp/server.mjs"]
```

ChatGPT подключает только удалённые MCP-серверы (по HTTPS), а этот сервер локальный. Для ChatGPT используйте
способ 3 (промпт).

### 2. AI-агент с доступом к файлам, без MCP

Откройте папку в Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI или другом агенте и попросите:

> Найди все бизнес-процессы в `docs/регламент.docx`, построй каталог и схемы L1–L2 для stormBPMN и draw.io

> Построй BPMN L2 для процессов «Приём заявки» и «Возврат товара» по документам из `docs/`, Camunda 8, исполняемые

Агент найдёт методику сам: через [AGENTS.md](AGENTS.md) (Codex, Cursor, Copilot и др.), `CLAUDE.md` и
`.claude/skills` (Claude Code) или `GEMINI.md` (Gemini CLI). Вся методика лежит в
[skills/bpmn-analyst/](skills/bpmn-analyst/) — одно место для всех агентов.

### 3. Обычный чат с нейросетью (без установки агента)

1. Вставьте в чат содержимое [prompts/bpmn-analyst.chat.md](prompts/bpmn-analyst.chat.md) — как системный промпт или
   первое сообщение (в ChatGPT — Custom GPT / Project instructions, в Claude.ai — Project instructions).
2. Пришлите текст документа. Лучше разметить его заранее: `node src/cli.mjs extract регламент.docx`, а потом
   отправить полученный `.md`.
3. Нейросеть вернёт `catalog.json`, затем по одной модели на каждый процесс. Сохраните их и соберите схемы:

```bash
node src/cli.mjs catalog catalog.json --docs docs/
node src/cli.mjs build models --docs docs/ --formats generic,drawio --out out
```

Если `build` нашёл ошибки, отправьте его вывод обратно в чат: нейросеть исправит модель.

### 4. Встроенный агент через API любой модели (автоматизация без человека)

Шаги ведёт код, а от модели требуется только JSON. Поэтому tool calling не нужен и подходят и слабые,
и локальные модели. Ошибки валидации и неточные цитаты автоматически отправляются модели на исправление.

```bash
# шаг 1: документы → каталог (контрольная точка)
node src/cli.mjs agent catalog docs/регламент.docx --work work --provider anthropic

# проверьте work/catalog.md, проставьте "status": "confirmed" нужным процессам в work/catalog.json

# шаг 2: модели → все форматы
node src/cli.mjs agent model --work work --formats generic,camunda8,drawio

# или всё сразу, без контрольной точки
node src/cli.mjs agent run docs/*.docx --work work --levels L1,L2 --provider deepseek --model deepseek-chat
```

| `--provider` | API | Ключ (переменная окружения) |
|---|---|---|
| `anthropic` (по умолчанию, модель `claude-opus-5-5`) | Anthropic, официальный SDK | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter (сотни моделей: Qwen, Llama, Gemini, Mistral…) | `OPENROUTER_API_KEY` |
| `ollama` / `lmstudio` | локальные модели | — |
| `openai-compatible` + `--base-url` | любой OpenAI-совместимый API: YandexGPT, vLLM, GigaChat через шлюз и т.п. | `LLM_API_KEY` |

Для всех провайдеров, кроме `anthropic`, укажите `--model`. Полезные опции: `--json-mode` (если API поддерживает
`response_format`), `--max-tokens`, `--retries`, `--max-doc-chars`. Все запросы и ответы модели сохраняются
в `work/logs/`.

У моделей Claude, которые это поддерживают (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1), включён серверный
fallback: если классификатор безопасности отклонит запрос, Anthropic автоматически повторит его на подходящей
модели. Учтите это при подсчёте расходов.

## CLI

```
node src/cli.mjs extract  <файлы...> [--out dir]
node src/cli.mjs catalog  <catalog.json> [--docs dir] [--out file]
node src/cli.mjs validate <model.json|dir> [--docs dir]
node src/cli.mjs build    <model.json|dir> [--out dir] [--formats generic,camunda7,camunda8,drawio] [--executable] [--docs dir] [--cdn]
node src/cli.mjs render   <preview.html> [--out dir]        # PNG через headless Edge/Chrome
node src/cli.mjs prompt   [--out file]                      # пересобрать промпт для чатов
node src/cli.mjs agent    catalog|model|run ...             # встроенный агент (см. выше)
```

## Форматы

| Формат | Файл | Импорт | Особенности |
|---|---|---|---|
| `generic` | `*.bpmn` | stormBPMN, Bizagi, Visio, bpmn.io, любой BPMN 2.0 | Чистый BPMN 2.0 + DI; источник и достоверность — в `documentation` |
| `camunda7` | `*.c7.bpmn` | Camunda Modeler / Engine 7 | `calledElement`; с `--executable`: external tasks, candidateGroups, условия JUEL |
| `camunda8` | `*.c8.bpmn` | Camunda Modeler / Zeebe | `zeebe:calledElement`; с `--executable`: job types, Camunda user tasks, FEEL |
| `drawio` | `*.drawio`, `all-processes.drawio` | draw.io / diagrams.net | Фигуры BPMN-библиотеки draw.io; страница на процесс, `callActivity` — ссылка на страницу детализации |

## Структура

```
skills/bpmn-analyst/           методика аналитика — единый источник для всех нейросетей
  SKILL.md, mcp-mode.md, chat-mode.md   режим агента / MCP / чата
  references/                  поиск процессов, правила моделирования, чек-лист пробелов, форматы
AGENTS.md, CLAUDE.md, GEMINI.md, .claude/skills/   точки входа для разных агентов
prompts/bpmn-analyst.chat.md   собранный промпт для чатов (генерируется: npm run prompt)
schema/                        JSON-схемы каталога и модели процесса
src/mcp/server.mjs             MCP-сервер (инструменты bpmn_* для любого MCP-клиента)
src/agent/                     встроенный агент: клиенты LLM, промпты, конвейер
src/                           extract, валидация, раскладка, экспорт, lint, отчёты, render
samples/                       синтетический регламент + эталонные каталог и модели
```

## Ограничения

- Один пул на диаграмму: внешние участники моделируются `sendTask`/`receiveTask`, без message flow между пулами.
- Документы на схеме не рисуются отдельными фигурами (data objects): они хранятся в атрибутах задач.
- Импорт в **stormBPMN** проверен только на соответствие стандарту (bpmn-moddle, bpmnlint). Реальный импорт нужно
  проверить в вашем инструменте.
- Сканы PDF без текстового слоя (нужен OCR) не поддерживаются.
- Встроенный агент протестирован на подставной модели. Качество на реальных моделях зависит от модели: слабым
  локальным моделям может понадобиться больше циклов исправления (`--retries`).
