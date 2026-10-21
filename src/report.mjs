// Markdown-отчёты: каталог БП, пробелы/вопросы заказчику, трассировка «элемент → источник».
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const src = (s) => (s ? `${s.doc}${s.section ? ` §${s.section}` : ''}` : '—');
const SEV = { high: '🔴 высокая', medium: '🟠 средняя', low: '⚪ низкая' };
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};
const COV = { full: 'полное', partial: 'частичное', mention: 'упоминание' };
const STATUS = { proposed: 'предложен', confirmed: 'подтверждён', rejected: 'отклонён' };

export function catalogMarkdown(c) {
  const out = [`# ${c.title ?? 'Каталог бизнес-процессов'}`, ''];
  out.push('**Источники:** ' + c.documents.map((d) => `${d.title ?? d.doc}${d.version ? ` (${d.version})` : ''}`).join('; '), '');

  out.push('## Иерархия', '');
  const kids = new Map();
  for (const p of c.processes) {
    const k = p.parent ?? '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(p);
  }
  const walk = (parent, depth) => {
    for (const p of kids.get(parent) ?? []) {
      out.push(`${'  '.repeat(depth)}- **${p.level}** ${p.name} \`${p.id}\`${p.status !== 'confirmed' ? ` — _${STATUS[p.status]}_` : ''}`);
      walk(p.id, depth + 1);
    }
  };
  walk('', 0);
  const orphans = c.processes.filter((p) => p.parent && !c.processes.some((q) => q.id === p.parent));
  for (const p of orphans) out.push(`- ⚠ ${p.level} ${p.name} \`${p.id}\` (родитель ${p.parent} не найден)`);

  out.push('', '## Реестр', '');
  out.push('| ID | Ур. | Процесс | Триггер | Результат | Владелец | Участники | Покрытие | Источники | Статус |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const p of c.processes) {
    out.push(
      `| \`${p.id}\` | ${p.level} | ${cell(p.name)}${p.aliases?.length ? `<br><small>также: ${cell(p.aliases.join(', '))}</small>` : ''} | ${cell(p.trigger)} | ${cell(p.result)} | ${cell(p.owner)} | ${cell(
        (p.participants ?? []).join(', ')
      )} | ${COV[p.coverage] ?? '—'} | ${cell((p.sources ?? []).map(src).join('; '))} | ${STATUS[p.status]} |`
    );
  }
  if (c.gaps?.length) {
    out.push('', '## Пробелы и вопросы', '', '| # | Важность | Процесс | Что не так | Вопрос заказчику |', '|---|---|---|---|---|');
    for (const g of c.gaps) out.push(`| ${g.id} | ${SEV[g.severity] ?? '—'} | ${cell(g.process)} | ${cell(g.text)} | ${cell(g.question)} |`);
  }
  return out.join('\n') + '\n';
}

export function modelsReport(models, issuesById, quoteChecks = []) {
  const out = ['# Отчёт аналитика', ''];
  const total = { gaps: 0, assumptions: 0, noSource: 0 };
  const rows = [];
  for (const m of models) {
    const elems = [...m.nodes, ...m.flows.filter((f) => f.name || f.source || f.confidence)];
    const assumptions = elems.filter((e) => e.confidence === 'assumption');
    const noSource = m.nodes.filter((n) => !n.source && n.confidence !== 'assumption');
    total.gaps += m.gaps?.length ?? 0;
    total.assumptions += assumptions.length;
    total.noSource += noSource.length;
    const iss = issuesById.get(m.id) ?? [];
    rows.push(
      `| \`${m.id}\` | ${m.level} | ${cell(m.name)} | ${m.nodes.length} | ${m.gaps?.length ?? 0} | ${assumptions.length} | ${noSource.length} | ${
        iss.filter((i) => i.level === 'error').length
      } / ${iss.filter((i) => i.level === 'warn').length} |`
    );
  }
  out.push('| Процесс | Ур. | Название | Элементов | Пробелов | Допущений | Без источника | Ошибки / замечания |', '|---|---|---|---|---|---|---|---|', ...rows, '');

  const failed = quoteChecks.filter((q) => !q.found || !q.sectionMatches);
  if (quoteChecks.length) {
    out.push(`## Проверка цитат`, '', `Проверено цитат: ${quoteChecks.length}, не найдено в документах: ${quoteChecks.filter((q) => !q.found).length}, указан не тот раздел: ${quoteChecks.filter((q) => q.found && !q.sectionMatches).length}.`, '');
    if (failed.length) {
      out.push('| Элемент | Источник | Проблема | Цитата |', '|---|---|---|---|');
      for (const q of failed) out.push(`| ${q.owner} | ${src(q)} | ${q.found ? `цитата найдена в §${q.foundIn}` : '**не найдена**'} | ${cell(q.quote)} |`);
      out.push('');
    }
  }

  const gaps = models.flatMap((m) => (m.gaps ?? []).map((g) => ({ ...g, process: m.id, processName: m.name })));
  if (gaps.length) {
    const order = { high: 0, medium: 1, low: 2 };
    gaps.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    out.push('## Вопросы заказчику', '', '| # | Важность | Процесс | Пробел | Вопрос | Источник |', '|---|---|---|---|---|---|');
    for (const g of gaps)
      out.push(`| ${g.id} | ${SEV[g.severity] ?? '—'} | ${cell(g.processName)}${g.node ? ` / \`${g.node}\`` : ''} | ${cell(g.text)} | ${cell(g.question)} | ${src(g.source)} |`);
    out.push('');
  }

  out.push('## Допущения (требуют подтверждения)', '');
  let any = false;
  for (const m of models)
    for (const e of [...m.nodes, ...m.flows].filter((x) => x.confidence === 'assumption')) {
      any = true;
      out.push(`- **${m.name}** / \`${e.id}\` ${e.name ? `«${e.name}»` : ''}${e.notes ? ` — ${e.notes}` : ''}`);
    }
  if (!any) out.push('Нет.');
  out.push('');

  out.push('## Матрица трассировки', '');
  for (const m of models) {
    out.push(`### ${m.level} · ${m.name}`, '', '| Элемент | Тип | Дорожка | Источник | Достоверность | Цитата |', '|---|---|---|---|---|---|');
    const lanes = new Map((m.lanes ?? []).map((l) => [l.id, l.name]));
    for (const n of m.nodes)
      out.push(`| ${cell(n.name ?? n.id)} | ${n.type} | ${cell(lanes.get(n.lane) ?? '')} | ${src(n.source)} | ${n.confidence ?? '—'} | ${cell(n.source?.quote ?? '')} |`);
    out.push('');
  }

  out.push('## Замечания валидации', '');
  for (const m of models) {
    const iss = (issuesById.get(m.id) ?? []).filter((i) => i.level !== 'info');
    if (!iss.length) continue;
    out.push(`### ${m.name}`, '', ...iss.map((i) => `- ${i.level === 'error' ? '❌' : '⚠'} \`${i.rule}\` ${i.message}`), '');
  }
  out.splice(
    2,
    0,
    `**Итого:** ${plural(models.length, 'процесс', 'процесса', 'процессов')}, ${plural(total.gaps, 'пробел', 'пробела', 'пробелов')}, ${plural(total.assumptions, 'допущение', 'допущения', 'допущений')}, ${plural(total.noSource, 'элемент', 'элемента', 'элементов')} без источника.`,
    ''
  );
  return out.join('\n') + '\n';
}
