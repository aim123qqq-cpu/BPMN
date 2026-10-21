# bpmn-agent — инструкции для AI-агентов

Этот файл читают Codex, Cursor, GitHub Copilot, Gemini CLI, Claude Code и другие агенты, поддерживающие AGENTS.md.

## Если пользователь просит работу аналитика

Найти бизнес-процессы в документах, составить каталог БП, построить BPMN-схемы (stormBPMN, Camunda, draw.io),
детализировать процесс, подготовить вопросы по пробелам в регламенте — **прочитай
[skills/bpmn-analyst/SKILL.md](skills/bpmn-analyst/SKILL.md) и работай строго по нему.** Справочники —
в `skills/bpmn-analyst/references/`. Инструменты — `node src/cli.mjs <extract|catalog|validate|build|render>`.

Без терминала (только чат) — работай по [skills/bpmn-analyst/chat-mode.md](skills/bpmn-analyst/chat-mode.md).

## Если пользователь просит доработать сам инструмент

- Node ≥ 20, ESM (`.mjs`), без сборки. Установка: `npm install`. Тесты: `npm test` — должны проходить.
- `src/` — CLI и экспортёры; `src/agent/` — встроенный агент для любых LLM (OpenAI-совместимые API, Anthropic);
  `schema/` — JSON-схемы каталога и модели; `samples/` — эталонный пример (регламент → каталог → 4 модели).
- Каноническая модель (`schema/process-model.schema.json`) — единственный источник для всех форматов: новый
  формат = новый экспортёр из модели + раскладки, а не правка других экспортёров.
- После изменения методики в `skills/` пересобери промпт для чатов: `node src/cli.mjs prompt` (тест проверяет,
  что `prompts/` актуальны).
- Изменения раскладки проверяй глазами: `npm run demo` и `node src/cli.mjs render out/demo/preview.html`.
