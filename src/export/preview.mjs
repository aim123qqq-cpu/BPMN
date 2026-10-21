// HTML-просмотр всех диаграмм (bpmn-js): вкладки по процессам, переход в детализацию по клику
// на callActivity, подсветка допущений, список замечаний валидации.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const BPMN_JS_CDN = 'https://unpkg.com/bpmn-js@18.31.0/dist';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// По умолчанию viewer встраивается в HTML: файл открывается без интернета (закрытые контуры).
function viewerAssets(cdn) {
  if (cdn)
    return (
      ['assets/diagram-js.css', 'assets/bpmn-js.css', 'assets/bpmn-font/css/bpmn.css'].map((p) => `<link rel="stylesheet" href="${BPMN_JS_CDN}/${p}">`).join('\n') +
      `\n<script src="${BPMN_JS_CDN}/bpmn-navigated-viewer.production.min.js"></script>`
    );
  const dist = join(dirname(createRequire(import.meta.url).resolve('bpmn-js/package.json')), 'dist');
  const read = (p) => readFileSync(join(dist, p), 'utf8');
  const css = ['assets/diagram-js.css', 'assets/bpmn-js.css', 'assets/bpmn-font/css/bpmn-embedded.css'].map(read).join('\n');
  const js = read('bpmn-navigated-viewer.production.min.js').replace(/<\/script/gi, '<\\/script');
  return `<style>${css}</style>\n<script>${js}</script>`;
}

export function toPreviewHtml(items, { title = 'BPMN — предпросмотр', cdn = false } = {}) {
  // items: [{ id, name, level, xml, assumptions: [ids], issues: [{level, message}] }]
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${viewerAssets(cdn)}
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --text:#1d2330; --muted:#667085; --line:#e3e6eb; --accent:#2f6fde; --warn:#b54708; --err:#c4320a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--text); background:var(--bg); display:flex; flex-direction:column; height:100vh; }
  header { padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  header h1 { font-size:15px; margin:0 12px 0 0; }
  .tab { border:1px solid var(--line); background:var(--panel); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; color:inherit; }
  .tab[aria-selected="true"] { border-color:var(--accent); color:var(--accent); font-weight:600; }
  .tab .lvl { color:var(--muted); font-size:12px; margin-right:4px; }
  main { flex:1; display:flex; min-height:0; }
  #canvas { flex:1; background:#fff; }
  aside { width:340px; overflow:auto; border-left:1px solid var(--line); background:var(--panel); padding:12px 16px; }
  aside h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:8px 0; }
  aside li { margin-bottom:6px; }
  .error { color:var(--err); } .warn { color:var(--warn); } .info { color:var(--muted); }
  .legend { font-size:12px; color:var(--muted); }
  .assumption .djs-visual > :first-child { stroke:#d6b656 !important; stroke-dasharray:6 3; fill:#fff2cc !important; }
  .call-link .djs-visual > :first-child { cursor:pointer; }
  @media (max-width: 800px) { main { flex-direction:column; } aside { width:auto; max-height:35vh; border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header><h1>${esc(title)}</h1><nav id="tabs"></nav></header>
<main><div id="canvas"></div><aside id="side"></aside></main>
<script>
const ITEMS = ${data};
const viewer = new BpmnJS({ container: '#canvas' });
const tabs = document.getElementById('tabs');
const side = document.getElementById('side');
const ids = new Set(ITEMS.map(i => i.id));
function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
async function show(id) {
  const item = ITEMS.find(i => i.id === id) || ITEMS[0];
  for (const b of tabs.children) b.setAttribute('aria-selected', b.dataset.id === item.id);
  await viewer.importXML(item.xml);
  const canvas = viewer.get('canvas');
  const reg = viewer.get('elementRegistry');
  canvas.zoom('fit-viewport');
  for (const a of item.assumptions) if (reg.get(a)) canvas.addMarker(a, 'assumption');
  reg.filter(e => e.type === 'bpmn:CallActivity').forEach(e => {
    const ref = e.businessObject.calledElement || (e.businessObject.extensionElements?.values || []).find(v => v.processId)?.processId
      || (e.businessObject.$attrs && e.businessObject.$attrs.calledElement);
    if (ids.has(ref)) { canvas.addMarker(e.id, 'call-link'); e.__ref = ref; }
  });
  const groups = { error: [], warn: [], info: [] };
  for (const i of item.issues) (groups[i.level] || groups.info).push(i);
  side.innerHTML = '<h2>' + esc(item.level + ' · ' + item.name) + '</h2>'
    + '<p class="legend">Жёлтый пунктир — допущение аналитика. Клик по подпроцессу с рамкой вызова — переход в детализацию.</p>'
    + ['error','warn','info'].map(l => groups[l].length ? '<h2>' + ({error:'Ошибки',warn:'Замечания',info:'Инфо'}[l]) + ' (' + groups[l].length + ')</h2><ul>'
      + groups[l].map(i => '<li class="' + l + '">' + esc(i.message) + '</li>').join('') + '</ul>' : '').join('')
    + (item.issues.length ? '' : '<p>Замечаний нет.</p>');
  history.replaceState(null, '', '#' + item.id);
}
viewer.on('element.click', e => { if (e.element.__ref) show(e.element.__ref); });
for (const i of ITEMS) {
  const b = document.createElement('button');
  b.className = 'tab'; b.dataset.id = i.id;
  b.innerHTML = '<span class="lvl">' + esc(i.level) + '</span>' + esc(i.name);
  b.onclick = () => show(i.id);
  tabs.appendChild(b);
}
show(location.hash.slice(1));
</script>
</body>
</html>
`;
}
