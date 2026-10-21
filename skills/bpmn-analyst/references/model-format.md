# Формат файлов

Полные JSON-схемы: `<BPMN_AGENT>/schema/catalog.schema.json`, `<BPMN_AGENT>/schema/process-model.schema.json`.
Рабочий пример полного цикла: `<BPMN_AGENT>/samples/` (документ → каталог → 4 модели L1–L3).

## catalog.json

```json
{
  "title": "Каталог БП: закупки",
  "documents": [{ "doc": "reglament.docx", "title": "Регламент закупок", "version": "ред. 3" }],
  "processes": [
    {
      "id": "proc_purchase", "name": "Проведение закупки", "level": "L2", "parent": "proc_procurement",
      "trigger": "Заявка Инициатора в СЭД", "result": "Проект договора подготовлен",
      "owner": "Отдел закупок", "participants": ["Инициатор", "Отдел закупок"], "systems": ["СЭД"],
      "aliases": ["Закупочная процедура"],
      "sources": [{ "doc": "reglament.docx", "section": "S3.1", "quote": "Основанием для закупки является заявка" }],
      "coverage": "full", "confidence": "explicit", "status": "proposed", "notes": ""
    }
  ],
  "gaps": [{ "id": "G1", "severity": "high", "process": "proc_purchase", "text": "…", "question": "…?" }]
}
```

## models/<id>.json (фрагмент — часть узлов и потоков опущена)

```json
{
  "id": "proc_purchase", "name": "Проведение закупки", "level": "L2", "parent": "proc_procurement",
  "owner": "Отдел закупок", "pool": "ООО «Компания»",
  "lanes": [{ "id": "ln_init", "name": "Инициатор" }, { "id": "ln_proc", "name": "Отдел закупок" }],
  "nodes": [
    { "id": "s1", "type": "startEvent", "name": "Потребность возникла", "lane": "ln_init", "confidence": "inferred" },
    { "id": "t1", "type": "userTask", "name": "Оформить заявку", "lane": "ln_init", "system": "СЭД",
      "documents": [{ "name": "Заявка", "direction": "out" }], "sla": "1 рабочий день",
      "source": { "doc": "reglament.docx", "section": "S3.1", "quote": "заявка Инициатора, оформленная в СЭД" } },
    { "id": "g1", "type": "exclusiveGateway", "name": "Сумма свыше 500 000 руб.?", "lane": "ln_proc" },
    { "id": "c1", "type": "callActivity", "name": "Провести тендер", "lane": "ln_proc", "ref": "proc_tender" },
    { "id": "b1", "type": "boundaryEvent", "event": "error", "code": "TENDER_FAILED", "attachedTo": "c1", "name": "Тендер не состоялся" },
    { "id": "b2", "type": "boundaryEvent", "event": "timer", "timer": "P3D", "interrupting": false, "attachedTo": "t1", "name": "Прошло 3 дня" }
  ],
  "flows": [
    { "id": "f1", "from": "s1", "to": "t1" },
    { "id": "f5", "from": "g1", "to": "c1", "name": "Да", "expression": "amount > 500000" },
    { "id": "f6", "from": "g1", "to": "t9", "name": "Нет", "default": true }
  ],
  "gaps": [{ "id": "G2", "severity": "medium", "node": "b1", "text": "…", "question": "…?" }]
}
```

### Типы узлов

События: `startEvent`, `endEvent`, `intermediateCatchEvent`, `intermediateThrowEvent`, `boundaryEvent`
(+ `event`: `none|message|timer|error|signal|conditional|escalation|terminate`, `timer`, `code`, `attachedTo`, `interrupting`).

Активности: `task`, `userTask`, `serviceTask`, `sendTask`, `receiveTask`, `manualTask`, `businessRuleTask`,
`scriptTask`, `subProcess` (свёрнутый), `callActivity` (+ `ref`).

Шлюзы: `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`.

### Соглашения по id

- Процессы: `proc_<смысл>`; дорожки: `ln_<роль>`; узлы: `s*` старты, `e_*` концы, `t_*` задачи, `g_*` шлюзы,
  `c_*` вызовы, `b_*` граничные, `i_*` промежуточные; потоки `f1…fN`.
- id — латиница, цифры, `_`/`-`; начинаются с буквы. Они становятся id в BPMN — не меняй их без нужды
  между итерациями (ломает diff и импорт в инструментах).
- Граничные события `lane` не указывают — берут дорожку хоста.
