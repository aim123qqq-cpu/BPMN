// Проверка сгенерированного XML: разбор bpmn-moddle (структура/схема) + bpmnlint (recommended).
import { createRequire } from 'node:module';
import { BpmnModdle } from 'bpmn-moddle';

const require = createRequire(import.meta.url);
const { Linter } = require('bpmnlint');
const NodeResolver = require('bpmnlint/lib/resolver/node-resolver');

export async function lintBpmn(xml) {
  // новый экземпляр на каждый файл: часть правил bpmnlint копит состояние между вызовами
  const linter = new Linter({ config: { extends: 'bpmnlint:recommended' }, resolver: new NodeResolver() });
  const moddle = new BpmnModdle();
  const issues = [];
  let rootElement;
  try {
    ({ rootElement } = await moddle.fromXML(xml, 'bpmn:Definitions').then((r) => {
      for (const w of r.warnings) issues.push({ level: 'error', rule: 'moddle', message: w.message });
      return r;
    }));
  } catch (e) {
    return [{ level: 'error', rule: 'moddle', message: `XML не разбирается: ${e.message}` }];
  }
  const results = await linter.lint(rootElement);
  for (const [rule, reports] of Object.entries(results)) {
    for (const r of reports) {
      issues.push({ level: r.category === 'error' ? 'error' : 'warn', rule: `bpmnlint/${rule}`, message: r.message, element: r.id });
    }
  }
  return issues;
}
