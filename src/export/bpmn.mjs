// Каноническая модель + раскладка → BPMN 2.0 XML с DI.
// Профили: generic (stormBPMN, Bizagi, Visio, любой BPMN 2.0), camunda7, camunda8.
import { ACTIVITIES, GATEWAYS } from '../model.mjs';

export const PROFILES = {
  generic: { label: 'BPMN 2.0 (stormBPMN и др.)', ext: '.bpmn' },
  camunda7: { label: 'Camunda 7', ext: '.c7.bpmn', ns: 'camunda', platform: ['Camunda Platform', '7.23.0'] },
  camunda8: { label: 'Camunda 8', ext: '.c8.bpmn', ns: 'zeebe', platform: ['Camunda Cloud', '8.7.0'] }
};

const NS = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  camunda: 'http://camunda.org/schema/1.0/bpmn',
  zeebe: 'http://camunda.org/schema/zeebe/1.0',
  modeler: 'http://camunda.org/schema/modeler/1.0'
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');

const CONF = { explicit: 'явно в документе', inferred: 'выведено из документа', assumption: 'ДОПУЩЕНИЕ аналитика' };

export function documentation(x) {
  const lines = [];
  if (x.description) lines.push(x.description);
  if (x.goal) lines.push(`Цель: ${x.goal}`);
  if (x.owner) lines.push(`Владелец: ${x.owner}`);
  if (x.system) lines.push(`Система: ${x.system}`);
  if (x.documents?.length)
    lines.push(`Документы: ${x.documents.map((d) => (d.direction ? `${d.name} (${d.direction === 'in' ? 'вход' : 'выход'})` : d.name)).join('; ')}`);
  if (x.sla) lines.push(`Норматив: ${x.sla}`);
  if (x.notes) lines.push(x.notes);
  if (x.source) lines.push(`Источник: ${x.source.doc}${x.source.section ? ` §${x.source.section}` : ''}${x.source.quote ? ` — «${x.source.quote}»` : ''}`);
  if (x.confidence) lines.push(`Достоверность: ${CONF[x.confidence]}`);
  return lines.join('\n');
}

export function toBpmnXml(m, layout, { profile = 'generic', executable = false } = {}) {
  const P = PROFILES[profile];
  if (!P) throw new Error(`Неизвестный профиль ${profile}`);
  const c7 = profile === 'camunda7';
  const c8 = profile === 'camunda8';
  const exec = executable && (c7 || c8);
  const warnings = [];

  const nodes = new Map(m.nodes.map((n) => [n.id, n]));
  const outgoing = new Map(m.nodes.map((n) => [n.id, []]));
  const incoming = new Map(m.nodes.map((n) => [n.id, []]));
  for (const f of m.flows) {
    outgoing.get(f.from)?.push(f);
    incoming.get(f.to)?.push(f);
  }

  const roots = [];
  const ns = ['bpmn', 'bpmndi', 'dc', 'di', 'xsi', ...(P.ns ? [P.ns, 'modeler'] : [])];
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions` +
    ns.map((k) => ` xmlns:${k}="${NS[k]}"`).join('') +
    attrs({
      id: `Definitions_${m.id}`,
      targetNamespace: 'http://bpmn.io/schema/bpmn',
      exporter: 'bpmn-agent',
      exporterVersion: '0.1.0',
      'modeler:executionPlatform': P.platform?.[0],
      'modeler:executionPlatformVersion': P.platform?.[1]
    }) +
    '>';

  const ext = (inner) => (inner ? `<bpmn:extensionElements>${inner}</bpmn:extensionElements>` : '');
  const doc = (x) => {
    const d = documentation(x);
    return d ? `<bpmn:documentation>${escText(d).replace(/\n/g, '&#10;')}</bpmn:documentation>` : '';
  };
  const expr = (e) => `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${escText(c8 ? `=${e}` : `\${${feelToJuel(e)}}`)}</bpmn:conditionExpression>`;

  const eventDef = (n) => {
    const id = `${n.id}_def`;
    const code = n.code ?? n.id;
    const rootName = n.code ?? (n.name || n.id);
    switch (n.event) {
      case 'message': {
        const msgId = `Message_${code}`;
        roots.push(
          `<bpmn:message${attrs({ id: msgId, name: rootName })}>${
            c8 && exec && n.type !== 'startEvent' && n.type !== 'endEvent' && n.type !== 'intermediateThrowEvent'
              ? ext('<zeebe:subscription correlationKey="=correlationKey" />')
              : ''
          }</bpmn:message>`
        );
        return n.type === 'endEvent' || n.type === 'intermediateThrowEvent'
          ? `<bpmn:messageEventDefinition${attrs({ id, messageRef: msgId })}>${c8 && exec ? ext(`<zeebe:taskDefinition type="${esc(code)}" />`) : ''}</bpmn:messageEventDefinition>`
          : `<bpmn:messageEventDefinition${attrs({ id, messageRef: msgId })} />`;
      }
      case 'timer': {
        const v = n.timer ?? '';
        const kind = /^R/.test(v) ? 'timeCycle' : /^\d{4}-\d{2}-\d{2}/.test(v) ? 'timeDate' : 'timeDuration';
        if (n.type === 'startEvent' && kind === 'timeDuration' && v) warnings.push(`${n.id}: стартовый таймер с длительностью ${v} — обычно нужен цикл (R/P1D) или дата`);
        return `<bpmn:timerEventDefinition${attrs({ id })}>${v ? `<bpmn:${kind} xsi:type="bpmn:tFormalExpression">${escText(v)}</bpmn:${kind}>` : ''}</bpmn:timerEventDefinition>`;
      }
      case 'error':
        roots.push(`<bpmn:error${attrs({ id: `Error_${code}`, name: rootName, errorCode: code })} />`);
        return `<bpmn:errorEventDefinition${attrs({ id, errorRef: `Error_${code}` })} />`;
      case 'signal':
        roots.push(`<bpmn:signal${attrs({ id: `Signal_${code}`, name: rootName })} />`);
        return `<bpmn:signalEventDefinition${attrs({ id, signalRef: `Signal_${code}` })} />`;
      case 'escalation':
        roots.push(`<bpmn:escalation${attrs({ id: `Escalation_${code}`, name: rootName, escalationCode: code })} />`);
        return `<bpmn:escalationEventDefinition${attrs({ id, escalationRef: `Escalation_${code}` })} />`;
      case 'conditional':
        if (c8) warnings.push(`${n.id}: условные события поддерживаются не во всех версиях Camunda 8 — проверьте версию движка`);
        return `<bpmn:conditionalEventDefinition${attrs({ id })}><bpmn:condition xsi:type="bpmn:tFormalExpression" /></bpmn:conditionalEventDefinition>`;
      case 'terminate':
        return `<bpmn:terminateEventDefinition${attrs({ id })} />`;
      default:
        return '';
    }
  };

  const taskExt = (n) => {
    if (n.type === 'callActivity' && n.ref) {
      if (c8) return `<zeebe:calledElement processId="${esc(n.ref)}" propagateAllChildVariables="false" />`;
      return '';
    }
    if (!exec) return '';
    if (c8) {
      if (['serviceTask', 'sendTask', 'scriptTask'].includes(n.type)) return `<zeebe:taskDefinition type="${esc(n.id)}" />`;
      if (n.type === 'userTask')
        return `<zeebe:userTask />${n.lane ? `<zeebe:assignmentDefinition candidateGroups="${esc(n.lane)}" />` : ''}`;
      if (n.type === 'businessRuleTask') return `<zeebe:calledDecision decisionId="${esc(n.id)}" resultVariable="${esc(n.id)}Result" />`;
      if (n.type === 'receiveTask') {
        roots.push(`<bpmn:message${attrs({ id: `Message_${n.id}`, name: n.name || n.id })}>${ext('<zeebe:subscription correlationKey="=correlationKey" />')}</bpmn:message>`);
      }
    }
    return '';
  };
  const taskAttrs = (n) => {
    const a = {};
    if (n.type === 'callActivity' && n.ref && !c8) a.calledElement = n.ref;
    if (n.type === 'receiveTask' && exec && c8) a.messageRef = `Message_${n.id}`;
    if (n.type === 'boundaryEvent') {
      a.attachedToRef = n.attachedTo;
      if (n.interrupting === false) a.cancelActivity = 'false';
    }
    if (exec && c7) {
      if (['serviceTask', 'sendTask'].includes(n.type)) Object.assign(a, { 'camunda:type': 'external', 'camunda:topic': n.id });
      if (n.type === 'userTask' && n.lane) a['camunda:candidateGroups'] = n.lane;
      if (n.type === 'businessRuleTask') a['camunda:decisionRef'] = n.id;
      if (n.type === 'scriptTask') a.scriptFormat = 'javascript';
    }
    const def = (outgoing.get(n.id) ?? []).find((f) => f.default);
    if (def && (GATEWAYS.has(n.type) || ACTIVITIES.has(n.type))) a.default = def.id;
    return a;
  };

  const flowNodeXml = m.nodes.map((n) => {
    // свёрнутый подпроцесс со ссылкой на детализацию экспортируется как вызов отдельной диаграммы
    const node = n.type === 'subProcess' && n.ref ? { ...n, type: 'callActivity' } : n;
    const io =
      (incoming.get(n.id) ?? []).map((f) => `<bpmn:incoming>${f.id}</bpmn:incoming>`).join('') +
      (outgoing.get(n.id) ?? []).map((f) => `<bpmn:outgoing>${f.id}</bpmn:outgoing>`).join('');
    const body = doc(n) + ext(taskExt(node)) + io + (n.event ? eventDef(n) : '') + (n.type === 'scriptTask' && exec && c7 ? '<bpmn:script />' : '');
    return `<bpmn:${node.type}${attrs({ id: n.id, name: n.name, ...taskAttrs(node) })}>${body}</bpmn:${node.type}>`;
  });

  const flowXml = m.flows.map((f) => {
    const src = nodes.get(f.from);
    const isSplit = src && ['exclusiveGateway', 'inclusiveGateway'].includes(src.type) && outgoing.get(src.id).length > 1;
    if (exec && isSplit && !f.default && !f.expression)
      warnings.push(`${f.id}: исполняемый режим — у ветки «${f.name ?? ''}» нет expression и она не default`);
    const body = doc(f) + (f.expression && !f.default ? expr(f.expression) : '');
    return `<bpmn:sequenceFlow${attrs({ id: f.id, name: f.name, sourceRef: f.from, targetRef: f.to })}>${body}</bpmn:sequenceFlow>`;
  });

  const laneXml = layout.hasLanes
    ? `<bpmn:laneSet id="LaneSet_${m.id}">` +
      m.lanes
        .map(
          (l) =>
            `<bpmn:lane${attrs({ id: l.id, name: l.name })}>${doc(l)}` +
            m.nodes
              .filter((n) => (n.type === 'boundaryEvent' ? nodes.get(n.attachedTo)?.lane : n.lane) === l.id)
              .map((n) => `<bpmn:flowNodeRef>${n.id}</bpmn:flowNodeRef>`)
              .join('') +
            '</bpmn:lane>'
        )
        .join('') +
      '</bpmn:laneSet>'
    : '';

  const procDoc = doc({ description: m.description, goal: m.goal, owner: m.owner });
  const processXml =
    `<bpmn:process${attrs({ id: m.id, name: m.name, isExecutable: exec ? 'true' : 'false' })}>` +
    (procDoc ? procDoc : '') +
    laneXml +
    flowNodeXml.join('') +
    flowXml.join('') +
    '</bpmn:process>';

  const collab = `<bpmn:collaboration id="Collaboration_${m.id}"><bpmn:participant${attrs({
    id: `Participant_${m.id}`,
    name: m.pool ?? m.name,
    processRef: m.id
  })} /></bpmn:collaboration>`;

  const bounds = (b) => `<dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />`;
  const label = (l) => (l ? `<bpmndi:BPMNLabel>${bounds(l)}</bpmndi:BPMNLabel>` : '');
  const di = [];
  di.push(`<bpmndi:BPMNShape id="Participant_${m.id}_di" bpmnElement="Participant_${m.id}" isHorizontal="true">${bounds(layout.pool)}</bpmndi:BPMNShape>`);
  if (layout.hasLanes)
    for (const l of layout.lanes) di.push(`<bpmndi:BPMNShape id="${l.id}_di" bpmnElement="${l.id}" isHorizontal="true">${bounds(l)}</bpmndi:BPMNShape>`);
  // граничные события рисуются после хоста
  const ordered = [...m.nodes.filter((n) => n.type !== 'boundaryEvent'), ...m.nodes.filter((n) => n.type === 'boundaryEvent')];
  for (const n of ordered) {
    const s = layout.shapes.get(n.id);
    if (!s) continue;
    const extra = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : n.type === 'subProcess' && !n.ref ? ' isExpanded="false"' : '';
    di.push(`<bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${extra}>${bounds(s)}${label(s.label)}</bpmndi:BPMNShape>`);
  }
  for (const f of m.flows) {
    const e = layout.edges.get(f.id);
    if (!e) continue;
    di.push(
      `<bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">` +
        e.waypoints.map((p) => `<di:waypoint x="${p.x}" y="${p.y}" />`).join('') +
        label(e.label) +
        '</bpmndi:BPMNEdge>'
    );
  }

  const xml =
    head +
    collab +
    [...new Set(roots)].join('') +
    processXml +
    `<bpmndi:BPMNDiagram id="Diagram_${m.id}"><bpmndi:BPMNPlane id="Plane_${m.id}" bpmnElement="Collaboration_${m.id}">${di.join('')}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>` +
    '</bpmn:definitions>\n';
  return { xml: prettyXml(xml), warnings };
}

// expression в модели пишется на FEEL (Camunda 8). Для Camunda 7 (JUEL) переводим простые конструкции:
// «=» → «==», and/or/not. Сложные FEEL-выражения (списки, функции) нужно писать для C7 вручную.
export function feelToJuel(e) {
  return e
    .replace(/(^|[^<>!=])=(?!=)/g, '$1==')
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/\bnot\s*\(/g, '!(');
}

// Простой отступ для читаемости diff'ов (в атрибутах переносы уже экранированы).
function prettyXml(xml) {
  let depth = 0;
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      if (/^<\//.test(line)) depth--;
      const out = '  '.repeat(Math.max(depth, 0)) + line;
      if (/^<[^/?!][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join('\n');
}
