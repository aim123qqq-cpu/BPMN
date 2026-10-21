// Каноническая модель + раскладка → draw.io (mxGraph XML) с фигурами из библиотеки BPMN draw.io.
// Каждый процесс — отдельная страница; callActivity ссылается на страницу детализации.
import { documentation } from './bpmn.mjs';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

const TASK = 'shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;container=1;expand=0;collapsible=0;';
const EVENT =
  'shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;whiteSpace=wrap;';
const GATEWAY =
  'shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;whiteSpace=wrap;';
const MARKER = {
  task: 'abstract', userTask: 'user', serviceTask: 'service', sendTask: 'send', receiveTask: 'receive',
  manualTask: 'manual', businessRuleTask: 'businessRule', scriptTask: 'script'
};
const OUTLINE = { startEvent: 'standard', endEvent: 'end', intermediateCatchEvent: 'catching', intermediateThrowEvent: 'throwing' };
const GW = {
  exclusiveGateway: 'outline=none;symbol=none;gwType=exclusive;',
  parallelGateway: 'outline=none;symbol=none;gwType=parallel;',
  inclusiveGateway: 'outline=end;symbol=general;',
  eventBasedGateway: 'outline=catching;symbol=multiple;'
};

export const pageId = (id) => `page_${id}`;

// позиция внешней подписи (из раскладки) → стиль draw.io
const LABEL_POS = {
  below: 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;',
  above: 'verticalLabelPosition=top;verticalAlign=bottom;labelPosition=center;align=center;',
  topLeft: 'verticalLabelPosition=top;verticalAlign=bottom;labelPosition=left;align=right;spacingRight=-12;',
  topRight: 'verticalLabelPosition=top;verticalAlign=bottom;labelPosition=right;align=left;spacingLeft=-12;',
  bottomLeft: 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=left;align=right;spacingRight=-12;',
  bottomRight: 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=right;align=left;spacingLeft=-12;',
  right: 'verticalLabelPosition=middle;verticalAlign=middle;labelPosition=right;align=left;'
};

function styleFor(n, shape) {
  let s;
  if (MARKER[n.type]) s = `${TASK}taskMarker=${MARKER[n.type]};`;
  else if (n.type === 'callActivity' || (n.type === 'subProcess' && n.ref)) s = `${TASK}bpmnShapeType=call;isLoopSub=1;`;
  else if (n.type === 'subProcess') s = `${TASK}taskMarker=abstract;isLoopSub=1;`;
  else if (GW[n.type]) s = GATEWAY + GW[n.type];
  else {
    const outline = n.type === 'boundaryEvent' ? (n.interrupting === false ? 'boundNonint' : 'boundInt') : OUTLINE[n.type];
    const ev = n.event ?? 'none';
    const symbol = ev === 'none' ? (n.type === 'endEvent' ? 'terminate2' : 'general') : ev;
    s = `${EVENT}outline=${outline};symbol=${symbol};`;
  }
  if (shape?.label) s = s.replace(/verticalLabelPosition=bottom;|verticalAlign=top;|align=center;/g, '') + LABEL_POS[shape.label.pos] + `labelWidth=${shape.label.w};`;
  if (n.confidence === 'assumption') s += 'dashed=1;fillColor=#fff2cc;strokeColor=#d6b656;';
  return s;
}

export function toDrawioDiagram(m, layout) {
  const cells = ['<mxCell id="0" />', `<mxCell id="1" parent="0" />`];
  const P = layout.pool;
  const poolId = `${m.id}__pool`;
  cells.push(
    `<mxCell id="${poolId}" value="${esc(m.pool ?? m.name)}" style="swimlane;html=1;horizontal=0;startSize=30;collapsible=0;whiteSpace=wrap;fontStyle=1;" vertex="1" parent="1">` +
      `<mxGeometry x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" as="geometry" /></mxCell>`
  );
  const parentOf = new Map();
  if (layout.hasLanes) {
    for (const l of layout.lanes) {
      cells.push(
        `<mxCell id="${m.id}__${l.id}" value="${esc(l.name)}" style="swimlane;html=1;horizontal=0;startSize=30;collapsible=0;whiteSpace=wrap;fillColor=none;fontStyle=0;" vertex="1" parent="${poolId}">` +
          `<mxGeometry x="${l.x - P.x}" y="${l.y - P.y}" width="${l.w}" height="${l.h}" as="geometry" /></mxCell>`
      );
      parentOf.set(l.id, { id: `${m.id}__${l.id}`, x: l.x, y: l.y });
    }
  }
  const cellId = (id) => `${m.id}__${id}`;
  const nodes = new Map(m.nodes.map((n) => [n.id, n]));

  const ordered = [...m.nodes.filter((n) => n.type !== 'boundaryEvent'), ...m.nodes.filter((n) => n.type === 'boundaryEvent')];
  for (const n of ordered) {
    const s = layout.shapes.get(n.id);
    if (!s) continue;
    let parent;
    if (n.type === 'boundaryEvent') {
      const h = layout.shapes.get(n.attachedTo);
      parent = { id: cellId(n.attachedTo), x: h.x, y: h.y };
    } else parent = (layout.hasLanes && parentOf.get(n.lane)) || { id: poolId, x: P.x, y: P.y };
    const ref = n.type === 'callActivity' || n.type === 'subProcess' ? n.ref : null;
    const attrs = {
      label: n.name ?? '',
      tooltip: documentation(n),
      bpmnType: n.type,
      bpmnId: n.id,
      confidence: n.confidence,
      sourceDoc: n.source?.doc,
      sourceSection: n.source?.section,
      system: n.system,
      link: ref ? `data:page/id,${pageId(ref)}` : undefined
    };
    cells.push(
      `<UserObject id="${cellId(n.id)}"${Object.entries(attrs)
        .filter(([, v]) => v)
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join('')}>` +
        `<mxCell style="${styleFor(n, s)}" vertex="1" parent="${parent.id}">` +
        `<mxGeometry x="${s.x - parent.x}" y="${s.y - parent.y}" width="${s.w}" height="${s.h}" as="geometry" /></mxCell></UserObject>`
    );
  }

  for (const f of m.flows) {
    const e = layout.edges.get(f.id);
    const s = layout.shapes.get(f.from);
    const t = layout.shapes.get(f.to);
    if (!e || !s || !t) continue;
    const a = e.waypoints[0];
    const b = e.waypoints.at(-1);
    const rel = (p, box) => [(p.x - box.x) / box.w, (p.y - box.y) / box.h].map((v) => +v.toFixed(3));
    const [ex, ey] = rel(a, s);
    const [nx, ny] = rel(b, t);
    let style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=blockThin;endFill=1;fontSize=11;labelBackgroundColor=#ffffff;exitX=${ex};exitY=${ey};exitDx=0;exitDy=0;entryX=${nx};entryY=${ny};entryDx=0;entryDy=0;`;
    if (f.default) style += 'startArrow=dash;startFill=0;startSize=6;';
    else if (f.expression && !nodes.get(f.from)?.type.endsWith('Gateway')) style += 'startArrow=diamondThin;startFill=0;startSize=10;';
    if (f.confidence === 'assumption') style += 'dashed=1;strokeColor=#d6b656;';
    const mid = e.waypoints.slice(1, -1);
    cells.push(
      `<mxCell id="${cellId(f.id)}" value="${esc(f.name)}" style="${style}" edge="1" parent="1" source="${cellId(f.from)}" target="${cellId(f.to)}">` +
        `<mxGeometry relative="1"${f.name ? ' x="-0.6"' : ''} as="geometry">` +
        (mid.length ? `<Array as="points">${mid.map((p) => `<mxPoint x="${p.x}" y="${p.y}" />`).join('')}</Array>` : '') +
        `</mxGeometry></mxCell>`
    );
  }

  return (
    `<diagram id="${pageId(m.id)}" name="${esc(`${m.level} · ${m.name}`)}">` +
    `<mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${P.x + P.w + 40}" pageHeight="${P.y + P.h + 40}" math="0" shadow="0">` +
    `<root>${cells.join('')}</root></mxGraphModel></diagram>`
  );
}

export function toDrawioFile(diagrams) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="bpmn-agent" agent="bpmn-agent 0.1.0">\n${diagrams.join('\n')}\n</mxfile>\n`;
}
