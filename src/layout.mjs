// Детерминированная раскладка: колонки = ранг (длиннейший путь), строки внутри дорожек,
// ортогональные потоки. Одна геометрия используется всеми экспортёрами.
import { EVENTS, GATEWAYS } from './model.mjs';

const SIZE = { event: [36, 36], gateway: [50, 50], activity: [110, 80] };
const POOL_HEADER = 30;
const LANE_HEADER = 30;
const COL_GAP = 90;
const ROW_H = 120;
const LANE_PAD = 10;
const ORIGIN = { x: 40, y: 40 };

// Активности растут по длине названия (≈14 символов в строке), чтобы текст не налезал на маркеры.
export const sizeOf = (type, name = '') => {
  if (EVENTS.has(type)) return SIZE.event;
  if (GATEWAYS.has(type)) return SIZE.gateway;
  const lines = Math.ceil(name.length / 14);
  const marker = type === 'callActivity' || type === 'subProcess' ? 14 : 0;
  return [SIZE.activity[0], Math.max(SIZE.activity[1], lines * 15 + 24 + marker)];
};

export function layoutModel(m) {
  const nodes = new Map(m.nodes.map((n) => [n.id, n]));
  const flowNodes = m.nodes.filter((n) => n.type !== 'boundaryEvent');
  const boundaries = m.nodes.filter((n) => n.type === 'boundaryEvent' && nodes.has(n.attachedTo));
  const anchor = (id) => (nodes.get(id)?.type === 'boundaryEvent' ? nodes.get(id).attachedTo : id);

  // --- ранги ---
  const adj = new Map(flowNodes.map((n) => [n.id, []]));
  for (const f of m.flows) {
    const a = anchor(f.from);
    if (adj.has(a) && adj.has(f.to)) adj.get(a).push({ to: f.to, flow: f });
  }
  const backFlows = new Set();
  const color = new Map();
  const roots = [...flowNodes.filter((n) => n.type === 'startEvent'), ...flowNodes];
  for (const r of roots) {
    if (color.has(r.id)) continue;
    const stack = [[r.id, 0]];
    color.set(r.id, 1);
    while (stack.length) {
      const top = stack.at(-1);
      const edges = adj.get(top[0]);
      if (top[1] >= edges.length) {
        color.set(top[0], 2);
        stack.pop();
        continue;
      }
      const { to, flow } = edges[top[1]++];
      if (color.get(to) === 1) backFlows.add(flow.id);
      else if (!color.has(to)) {
        color.set(to, 1);
        stack.push([to, 0]);
      }
    }
  }
  const rank = new Map(flowNodes.map((n) => [n.id, 0]));
  const indeg = new Map(flowNodes.map((n) => [n.id, 0]));
  for (const [, es] of adj) for (const e of es) if (!backFlows.has(e.flow.id)) indeg.set(e.to, indeg.get(e.to) + 1);
  const queue = flowNodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const e of adj.get(id)) {
      if (backFlows.has(e.flow.id)) continue;
      rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }

  // --- дорожки и строки ---
  const lanes = m.lanes?.length ? m.lanes : [{ id: '__default', name: '' }];
  const laneOf = (n) => (m.lanes?.length ? n.lane ?? lanes[0].id : '__default');
  const row = new Map();
  const predRows = new Map(flowNodes.map((n) => [n.id, []]));
  const maxRank = Math.max(0, ...rank.values());
  const byRank = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of topo) byRank[rank.get(id)].push(nodes.get(id));
  const laneRows = new Map(lanes.map((l) => [l.id, 1]));

  for (const col of byRank) {
    const cells = new Map();
    for (const n of col) {
      const k = laneOf(n);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(n);
    }
    for (const [laneId, list] of cells) {
      const desired = (n) => {
        const ps = predRows.get(n.id).filter((p) => p.lane === laneId).map((p) => p.row);
        return ps.length ? Math.min(...ps) : 0;
      };
      list.sort((a, b) => desired(a) - desired(b));
      let next = 0;
      for (const n of list) {
        const r = Math.max(desired(n), next);
        row.set(n.id, r);
        next = r + 1;
        laneRows.set(laneId, Math.max(laneRows.get(laneId), r + 1));
      }
    }
    for (const n of col) {
      for (const e of adj.get(n.id)) {
        if (backFlows.has(e.flow.id)) continue;
        const fromBoundary = nodes.get(e.flow.from).type === 'boundaryEvent';
        predRows.get(e.to).push({ lane: laneOf(n), row: row.get(n.id) + (fromBoundary ? 1 : 0) });
      }
    }
  }
  // недостижимые (вне topo из-за циклов без входа) — в конец
  for (const n of flowNodes) if (!row.has(n.id)) row.set(n.id, laneRows.get(laneOf(n)) - 1);

  // --- геометрия ---
  const colW = byRank.map((col) => Math.max(SIZE.event[0], ...col.map((n) => sizeOf(n.type, n.name)[0])));
  const colX = [];
  let x = ORIGIN.x + POOL_HEADER + LANE_HEADER + 40;
  for (const w of colW) {
    colX.push(x);
    x += w + COL_GAP;
  }
  const poolW = x - COL_GAP + 40 - ORIGIN.x;
  const laneBox = new Map();
  let y = ORIGIN.y;
  for (const l of lanes) {
    const h = laneRows.get(l.id) * ROW_H + 2 * LANE_PAD;
    laneBox.set(l.id, { id: l.id, name: l.name, x: ORIGIN.x + POOL_HEADER, y, w: poolW - POOL_HEADER, h });
    y += h;
  }
  const pool = { x: ORIGIN.x, y: ORIGIN.y, w: poolW, h: y - ORIGIN.y };

  const shapes = new Map();
  for (const n of flowNodes) {
    const [w, h] = sizeOf(n.type, n.name);
    const r = rank.get(n.id);
    const lb = laneBox.get(laneOf(n));
    const cx = colX[r] + colW[r] / 2;
    const cy = lb.y + LANE_PAD + row.get(n.id) * ROW_H + ROW_H / 2;
    shapes.set(n.id, box(cx - w / 2, cy - h / 2, w, h, n.type));
  }
  const perHost = new Map();
  for (const b of boundaries) {
    const host = shapes.get(b.attachedTo);
    const i = perHost.get(b.attachedTo) ?? 0;
    perHost.set(b.attachedTo, i + 1);
    const [w, h] = SIZE.event;
    shapes.set(b.id, box(host.x + host.w - 28 - w / 2 - i * 42, host.y + host.h - h / 2, w, h, b.type));
  }

  // --- потоки: перебираем варианты маршрута, берём первый без пересечения фигур ---
  const edges = new Map();
  const backCount = new Map();
  const allShapes = [...shapes.entries()];
  const hits = (wp, skip) =>
    wp.slice(1).some((b, i) => {
      const a = wp[i];
      const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      return allShapes.some(([id, r]) => !skip.has(id) && x2 > r.x + 2 && x1 < r.x + r.w - 2 && y2 > r.y + 2 && y1 < r.y + r.h - 2);
    });
  const pick = (cands, skip) => cands.find((wp) => !hits(wp, skip)) ?? cands[0];

  for (const f of m.flows) {
    const s = shapes.get(f.from);
    const t = shapes.get(f.to);
    if (!s || !t) continue;
    const src = nodes.get(f.from);
    const dst = nodes.get(f.to);
    const skip = new Set([f.from, f.to, src.type === 'boundaryEvent' ? src.attachedTo : null]);
    const R = s.x + s.w;
    const sb = s.y + s.h;
    const tb = t.y + t.h;
    const rs = rank.get(anchor(f.from));
    const rt = rank.get(f.to);
    const gapAfter = (r) => colX[r] + colW[r] + COL_GAP / 2;
    const gapBefore = (r) => colX[r] - COL_GAP / 2;
    let wp;
    if (backFlows.has(f.id) || rt <= rs) {
      const lb = laneBox.get(laneOf(src.type === 'boundaryEvent' ? nodes.get(src.attachedTo) : src));
      const k = backCount.get(lb.id) ?? 0;
      backCount.set(lb.id, k + 1);
      if (t.cy > sb) {
        const yc = t.y - 16 - k * 6; // цель ниже — входим сверху
        wp = pick([[pt(s.cx, sb), pt(s.cx, yc), pt(t.cx, yc), pt(t.cx, t.y)]], skip);
      } else if (tb < s.y) {
        const yc = tb + 16 + k * 6; // цель выше — входим снизу
        wp = pick([[pt(s.cx, s.y), pt(s.cx, yc), pt(t.cx, yc), pt(t.cx, tb)]], skip);
      } else {
        const yc = Math.min(Math.max(sb, tb) + 16 + k * 6, lb.y + lb.h - 4); // одна строка — под фигурами
        wp = [pt(s.cx, sb), pt(s.cx, yc), pt(t.cx, yc), pt(t.cx, tb)];
      }
    } else if (src.type === 'boundaryEvent') {
      wp = pick(
        [
          [pt(s.cx, sb), pt(s.cx, t.cy), pt(t.x, t.cy)],
          [pt(s.cx, sb), pt(s.cx, sb + 16), pt(gapBefore(rt), sb + 16), pt(gapBefore(rt), t.cy), pt(t.x, t.cy)]
        ].filter((c) => c[1].y >= sb),
        skip
      );
    } else {
      const sy = t.cy > s.cy ? sb : s.y;
      const ty = s.cy < t.cy ? t.y : tb;
      const cands = [];
      if (Math.abs(s.cy - t.cy) < 1) cands.push([pt(R, s.cy), pt(t.x, t.cy)]);
      if (GATEWAYS.has(src.type)) cands.push([pt(s.cx, sy), pt(s.cx, t.cy), pt(t.x, t.cy)]);
      if (GATEWAYS.has(dst.type)) cands.push([pt(R, s.cy), pt(t.cx, s.cy), pt(t.cx, ty)]);
      for (const mx of [gapBefore(rt), gapAfter(rs)]) cands.push([pt(R, s.cy), pt(mx, s.cy), pt(mx, t.cy), pt(t.x, t.cy)]);
      if (GATEWAYS.has(src.type)) {
        const mx = gapAfter(rs);
        cands.push([pt(s.cx, sy), pt(s.cx, sy + (sy === sb ? 14 : -14)), pt(mx, sy + (sy === sb ? 14 : -14)), pt(mx, t.cy), pt(t.x, t.cy)]);
      }
      wp = pick(cands.map((c) => c.filter((p, i) => i === 0 || p.x !== c[i - 1].x || p.y !== c[i - 1].y)), skip);
    }
    edges.set(f.id, { waypoints: wp, label: f.name ? labelFor(wp, f.name) : null });
  }

  // --- подписи событий и шлюзов: первая позиция без пересечений с потоками, фигурами и другими подписями ---
  const segs = [...edges.values()].flatMap((e) => e.waypoints.slice(1).map((b, i) => [e.waypoints[i], b]));
  const placed = [];
  const free = (r) =>
    !segs.some(([a, b]) => Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h) &&
    ![...shapes.values(), ...placed].some((q) => q.x < r.x + r.w && q.x + q.w > r.x && q.y < r.y + r.h && q.y + q.h > r.y);
  for (const [id, s] of shapes) {
    const n = nodes.get(id);
    if (!((EVENTS.has(n.type) || GATEWAYS.has(n.type)) && n.name)) continue;
    const w = GATEWAYS.has(n.type) ? 84 : 100;
    const h = 14 * Math.ceil(n.name.length / (GATEWAYS.has(n.type) ? 13 : 16));
    const below = { x: s.cx - w / 2, y: s.y + s.h + 4, w, h };
    const above = { x: s.cx - w / 2, y: s.y - h - 4, w, h };
    const topLeft = { x: s.x - w + 10, y: s.y - h - 2, w, h };
    const topRight = { x: s.x + s.w - 10, y: s.y - h - 2, w, h };
    const bottomLeft = { x: s.x - w + 10, y: s.y + s.h + 2, w, h };
    const bottomRight = { x: s.x + s.w - 10, y: s.y + s.h + 2, w, h };
    const right = { x: s.x + s.w + 2, y: s.y + s.h - 6, w, h };
    Object.assign(below, { pos: 'below' });
    Object.assign(above, { pos: 'above' });
    Object.assign(topLeft, { pos: 'topLeft' });
    Object.assign(topRight, { pos: 'topRight' });
    Object.assign(bottomLeft, { pos: 'bottomLeft' });
    Object.assign(bottomRight, { pos: 'bottomRight' });
    Object.assign(right, { pos: 'right' });
    const order = GATEWAYS.has(n.type)
      ? [topLeft, topRight, bottomLeft, bottomRight, above, below]
      : n.type === 'boundaryEvent'
        ? [right, bottomLeft, bottomRight]
        : [below, above, bottomRight, bottomLeft, topRight, topLeft];
    s.label = order.find((r) => free(r)) ?? order[0];
    placed.push(s.label);
  }

  return { pool, lanes: [...laneBox.values()], hasLanes: !!m.lanes?.length, shapes, edges, backFlows };
}

function box(x, y, w, h) {
  return { x: Math.round(x), y: Math.round(y), w, h, cx: Math.round(x + w / 2), cy: Math.round(y + h / 2) };
}
const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y) });

function labelFor(wp, text) {
  const [a, b] = wp;
  const w = Math.min(120, 7 * text.length + 10);
  if (a.x === b.x) return { x: a.x + 6, y: Math.round((a.y + b.y) / 2) - 7, w, h: 14 };
  return { x: Math.round(a.x + 6), y: a.y - 18, w, h: 14 };
}
