// Converte o DwgDatabase (LibreDWG) em uma "cena" 2D: caminhos em coordenadas
// do mundo (WCS), textos, caixas envolventes e polígonos fechados com área.

import { resolveColor } from './colors.js';

const TAU = Math.PI * 2;
const MAX_DEPTH = 16;

// ---------- matrizes afins 2D [a, b, c, d, e, f] ----------
// x' = a·x + c·y + e ;  y' = b·x + d·y + f
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const det = (m) => m[0] * m[3] - m[1] * m[2];

/** Matriz OCS→WCS simplificada (extrusão (0,0,-1) espelha X). */
function ocs(entity) {
  const z = entity.extrusionDirection?.z;
  return z != null && z < 0 ? [-1, 0, 0, 1, 0, 0] : IDENTITY;
}

// ---------- tesselação ----------
function arcPoints(cx, cy, r, a0, a1, ccw = true) {
  let sweep = ccw ? a1 - a0 : a0 - a1;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(8, Math.ceil((sweep / TAU) * 96));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (ccw ? 1 : -1) * (sweep * i) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, ccw = true) {
  const nx = -my * ratio, ny = mx * ratio; // eixo menor
  let sweep = ccw ? t1 - t0 : t0 - t1;
  while (sweep <= 0) sweep += TAU;
  if (sweep > TAU) sweep = TAU;
  const n = Math.max(12, Math.ceil((sweep / TAU) * 128));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (ccw ? 1 : -1) * (sweep * i) / n;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([cx + mx * c + nx * s, cy + my * c + ny * s]);
  }
  return pts;
}

/** Pontos de um segmento com bulge (exclui o ponto inicial). */
function bulgeSegment(p1, p2, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-9) return [p2];
  const theta = 4 * Math.atan(bulge);
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [p2];
  const r = chord / (2 * Math.abs(Math.sin(theta / 2)));
  // centro = ponto médio + normal à esquerda · (c/2)/tan(θ/2)  (θ com sinal)
  const d = chord / 2 / Math.tan(theta / 2);
  const cx = (p1[0] + p2[0]) / 2 - (dy / chord) * d;
  const cy = (p1[1] + p2[1]) / 2 + (dx / chord) * d;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = Math.max(4, Math.ceil((Math.abs(theta) / TAU) * 96));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts[pts.length - 1] = p2;
  return pts;
}

/** Área assinada exata de um polígono com bulges (fórmula do segmento circular). */
function bulgePolygonArea(verts) {
  let a = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  a /= 2;
  for (let i = 0; i < n; i++) {
    const b = verts[i].bulge;
    if (!b) continue;
    const p = verts[i], q = verts[(i + 1) % n];
    const chord = Math.hypot(q.x - p.x, q.y - p.y);
    const theta = 4 * Math.atan(b);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    a += (r * r / 2) * (theta - Math.sin(theta));
  }
  return a;
}

function bulgePolyline(verts, closed) {
  if (!verts.length) return [];
  const pts = [[verts[0].x, verts[0].y]];
  const n = verts.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    pts.push(...bulgeSegment([p.x, p.y], [q.x, q.y], p.bulge));
  }
  return pts;
}

/** NURBS por de Boor. */
function splinePoints(degree, knots, ctrl, weights) {
  const n = ctrl.length;
  if (!knots || knots.length < n + degree + 1 || degree < 1) return ctrl.map((p) => [p.x, p.y]);
  const w = weights && weights.length === n ? weights : null;
  const lo = knots[degree], hi = knots[n];
  const segs = Math.max(32, n * 12);
  const pts = [];
  for (let s = 0; s <= segs; s++) {
    const t = lo + ((hi - lo) * s) / segs;
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const p = ctrl[k - degree + j];
      const wt = w ? w[k - degree + j] : 1;
      d.push([p.x * wt, p.y * wt, wt]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
      }
    }
    const r = d[degree];
    pts.push([r[0] / r[2], r[1] / r[2]]);
  }
  return pts;
}

// ---------- métricas ----------
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pathLength(pts, closed) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) {
    const a = pts[0], b = pts[pts.length - 1];
    l += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return l;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function emptyBox() {
  return [Infinity, Infinity, -Infinity, -Infinity];
}
function growBox(b, x, y) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}
function mergeBox(b, o) {
  if (o[0] < b[0]) b[0] = o[0];
  if (o[1] < b[1]) b[1] = o[1];
  if (o[2] > b[2]) b[2] = o[2];
  if (o[3] > b[3]) b[3] = o[3];
}

// ---------- limpeza de MTEXT ----------
export function cleanMText(s) {
  if (!s) return '';
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQTWp][^;]*;/g, '')
    .replace(/\\S([^;]*)[\^#/]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKkN]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '');
}

// ---------- construção da cena ----------
/**
 * @returns {{ items: object[], bbox: number[], layers: Map, stats: object }}
 * Cada item corresponde a uma entidade do espaço do modelo e contém:
 *   paths: [{ pts, closed, fill, color }], texts: [...], bbox, polygons: [...]
 */
export function buildScene(db) {
  const layerMap = new Map();
  for (const l of db.tables?.LAYER?.entries ?? []) layerMap.set(l.name, l);
  const blocks = new Map();
  for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) blocks.set(b.name, b);

  const items = [];
  const typeCount = {};
  const warnings = new Set();

  db.entities.forEach((ent, index) => {
    typeCount[ent.type] = (typeCount[ent.type] || 0) + 1;
    if (ent.isInPaperSpace) return;
    const item = {
      id: items.length,
      index,
      entity: ent,
      type: ent.type,
      layer: ent.layer || '0',
      color: resolveColor(ent, layerMap),
      paths: [],
      texts: [],
      polygons: [],
      bbox: emptyBox(),
    };
    try {
      emit(ent, IDENTITY, item, item.color, item.layer, 0, null);
    } catch (e) {
      warnings.add(`${ent.type}: ${e.message}`);
    }
    for (const p of item.paths) for (const [x, y] of p.pts) growBox(item.bbox, x, y);
    for (const t of item.texts) {
      growBox(item.bbox, t.x, t.y);
      growBox(item.bbox, t.x + t.height, t.y + t.height);
    }
    if (item.paths.length || item.texts.length) items.push(item);
  });

  // remove ids desalinhados após filtragem
  items.forEach((it, i) => (it.id = i));

  const bbox = robustBox(items);
  return { items, bbox, layerMap, typeCount, warnings: [...warnings] };

  // ----- emissores -----
  function addPath(item, pts, closed, color, opts = {}) {
    if (pts.length < 2) return null;
    const p = { pts, closed, color, fill: opts.fill || null, layer: opts.layer };
    item.paths.push(p);
    return p;
  }

  function addPolygon(item, pts, area, perimeter, source, layer) {
    if (!(Math.abs(area) > 0)) return;
    item.polygons.push({ pts, area: Math.abs(area), perimeter, source, layer });
  }

  function tx(m, pts) {
    return pts.map(([x, y]) => apply(m, x, y));
  }

  function emit(e, M, item, color, layer, depth, blockName) {
    if (e.isVisible === false) return;
    const eLayer = e.layer && e.layer !== '0' ? e.layer : layer;
    const c = depth === 0 ? color : resolveColor(e, layerMap, color);
    const m = mul(M, ocs(e));
    const s = Math.sqrt(Math.abs(det(m)));
    const src = blockName ? `${e.type} (bloco “${blockName}”)` : e.type;

    switch (e.type) {
      case 'LINE':
        addPath(item, tx(M, [[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]]), false, c);
        break;

      case 'CIRCLE': {
        const pts = tx(m, arcPoints(e.center.x, e.center.y, e.radius, 0, TAU).slice(0, -1));
        addPath(item, pts, true, c);
        addPolygon(item, pts, Math.PI * e.radius * e.radius * Math.abs(det(m)), TAU * e.radius * s, src, eLayer);
        break;
      }

      case 'ARC':
        addPath(item, tx(m, arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle)), false, c);
        break;

      case 'ELLIPSE': {
        const full = Math.abs(Math.abs(e.endAngle - e.startAngle) - TAU) < 1e-6 ||
          (e.startAngle === 0 && e.endAngle === 0);
        const pts = ellipsePoints(e.center.x, e.center.y, e.majorAxisEndPoint.x, e.majorAxisEndPoint.y,
          e.axisRatio, e.startAngle, full ? e.startAngle + TAU : e.endAngle);
        const w = tx(M, full ? pts.slice(0, -1) : pts); // ELLIPSE já está em WCS
        addPath(item, w, full, c);
        if (full) {
          const a = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
          addPolygon(item, w, Math.PI * a * a * e.axisRatio * Math.abs(det(M)), pathLength(w, true), src, eLayer);
        }
        break;
      }

      case 'LWPOLYLINE': {
        const verts = e.vertices || [];
        const closed = (e.flag & 1) === 1 || (e.flag & 512) === 512;
        const pts = tx(m, bulgePolyline(verts, closed));
        if (closed && pts.length > 1) pts.pop();
        addPath(item, pts, closed, c);
        if (closed && verts.length >= 3) {
          addPolygon(item, pts, bulgePolygonArea(verts) * det(m), pathLength(pts, true), src, eLayer);
        }
        break;
      }

      case 'POLYLINE2D': {
        const verts = (e.vertices || []).filter((v) => !(v.flag & 16)); // ignora pontos de controle
        const closed = (e.flag & 1) === 1;
        const pts = tx(m, bulgePolyline(verts, closed));
        if (closed && pts.length > 1) pts.pop();
        addPath(item, pts, closed, c);
        if (closed && verts.length >= 3) {
          addPolygon(item, pts, bulgePolygonArea(verts) * det(m), pathLength(pts, true), src, eLayer);
        }
        break;
      }

      case 'POLYLINE3D': {
        const closed = (e.flag & 1) === 1;
        const pts = tx(M, (e.vertices || []).map((v) => [v.x, v.y]));
        addPath(item, pts, closed, c);
        if (closed && pts.length >= 3) addPolygon(item, pts, signedArea(pts), pathLength(pts, true), src, eLayer);
        break;
      }

      case 'SPLINE': {
        const ctrl = e.controlPoints?.length ? e.controlPoints : null;
        let pts = ctrl
          ? splinePoints(e.degree, e.knots, ctrl, e.weights)
          : (e.fitPoints || []).map((p) => [p.x, p.y]);
        pts = tx(M, pts);
        const closed = (e.flag & 1) === 1;
        addPath(item, pts, closed, c);
        if (closed && pts.length >= 3) addPolygon(item, pts, signedArea(pts), pathLength(pts, true), src, eLayer);
        break;
      }

      case 'SOLID':
      case 'TRACE': {
        const c4 = e.corner4 || e.corner3;
        const pts = tx(m, [[e.corner1.x, e.corner1.y], [e.corner2.x, e.corner2.y], [c4.x, c4.y], [e.corner3.x, e.corner3.y]]);
        addPath(item, pts, true, c, { fill: c });
        break;
      }

      case '3DFACE': {
        const cs = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean);
        addPath(item, tx(M, cs.map((p) => [p.x, p.y])), true, c);
        break;
      }

      case 'POINT': {
        const [x, y] = apply(M, e.position.x, e.position.y);
        item.paths.push({ pts: [[x, y], [x, y]], closed: false, color: c, point: true });
        break;
      }

      case 'HATCH':
        emitHatch(e, m, item, c, src, eLayer);
        break;

      case 'TEXT':
        emitText(e, m, item, c);
        break;

      case 'ATTRIB':
      case 'ATTDEF':
        if (e.text && typeof e.text === 'object') emitText({ ...e.text, extrusionDirection: e.extrusionDirection }, m, item, c);
        break;

      case 'MTEXT': {
        const [x, y] = apply(M, e.insertionPoint.x, e.insertionPoint.y);
        const dir = e.direction;
        const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : e.rotation || 0;
        const ap = e.attachmentPoint || 1;
        item.texts.push({
          x, y,
          height: e.textHeight * s,
          rotation: rot + Math.atan2(M[1], M[0]),
          text: cleanMText(e.text),
          color: c,
          align: ['left', 'center', 'right'][(ap - 1) % 3],
          baseline: ['top', 'middle', 'bottom'][Math.floor((ap - 1) / 3)],
          multiline: true,
          lineSpacing: e.lineSpacing || 1,
        });
        break;
      }

      case 'INSERT':
        emitInsert(e, M, item, c, eLayer, depth);
        break;

      case 'DIMENSION': {
        const b = e.name && blocks.get(e.name);
        if (b && depth < MAX_DEPTH) {
          for (const sub of b.entities || []) emit(sub, M, item, c, eLayer, depth + 1, null);
        } else if (e.subDefinitionPoint1 && e.subDefinitionPoint2) {
          addPath(item, tx(M, [[e.subDefinitionPoint1.x, e.subDefinitionPoint1.y], [e.subDefinitionPoint2.x, e.subDefinitionPoint2.y]]), false, c);
        }
        break;
      }

      case 'LEADER':
      case 'MLINE':
        if (Array.isArray(e.vertices)) {
          addPath(item, tx(M, e.vertices.map((v) => [v.x ?? v.vertex?.x, v.y ?? v.vertex?.y]).filter((p) => p[0] != null)), false, c);
        }
        break;

      case 'WIPEOUT':
      case 'IMAGE':
      case 'VIEWPORT':
      case 'XLINE':
      case 'RAY':
        break;

      default:
        if (Array.isArray(e.vertices) && e.vertices.length > 1 && e.vertices[0].x != null) {
          addPath(item, tx(M, e.vertices.map((v) => [v.x, v.y])), false, c);
        } else {
          warnings.add(`Entidade não suportada: ${e.type}`);
        }
    }
  }

  function emitText(t, m, item, c) {
    if (!t.text || !t.startPoint) return;
    const h = t.halign || 0, v = t.valign || 0;
    const useEnd = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && t.endPoint;
    const p = useEnd ? t.endPoint : t.startPoint;
    const [x, y] = apply(m, p.x, p.y);
    item.texts.push({
      x, y,
      height: (t.textHeight || 1) * Math.sqrt(Math.abs(det(m))),
      rotation: (t.rotation || 0) + Math.atan2(m[1], m[0]),
      text: cleanMText(t.text),
      color: c,
      align: h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left',
      baseline: h === 4 ? 'middle' : ['alphabetic', 'bottom', 'middle', 'top'][v] || 'alphabetic',
      widthFactor: t.xScale || 1,
    });
  }

  function emitInsert(e, M, item, c, layer, depth) {
    const b = blocks.get(e.name);
    if (!b || depth >= MAX_DEPTH) return;
    const base = b.basePoint || { x: 0, y: 0 };
    const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
    const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
    const F = mul(M, ocs(e));
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        let B = mul(F, translate(e.insertionPoint.x, e.insertionPoint.y));
        B = mul(B, rotate(e.rotation || 0));
        B = mul(B, translate(k * (e.columnSpacing || 0), r * (e.rowSpacing || 0)));
        B = mul(B, scale(sx, sy));
        B = mul(B, translate(-base.x, -base.y));
        for (const sub of b.entities || []) emit(sub, B, item, c, layer, depth + 1, e.name);
      }
    }
    for (const a of e.attribs || []) emit(a, M, item, c, layer, depth + 1, null);
  }

  function emitHatch(e, m, item, c, src, layer) {
    const loops = [];
    for (const path of e.boundaryPaths || []) {
      let pts = [];
      if (Array.isArray(path.vertices)) {
        pts = bulgePolyline(path.vertices, true);
        pts.pop();
      } else if (Array.isArray(path.edges)) {
        for (const ed of path.edges) {
          let seg = [];
          switch (ed.type) {
            case 1: seg = [[ed.start.x, ed.start.y], [ed.end.x, ed.end.y]]; break;
            case 2: seg = arcPoints(ed.center.x, ed.center.y, ed.radius,
              ed.isCCW === false ? -ed.startAngle : ed.startAngle,
              ed.isCCW === false ? -ed.endAngle : ed.endAngle, ed.isCCW !== false); break;
            case 3: {
              const ccw = ed.isCCW !== false;
              const ratio = ed.lengthOfMinorAxis;
              seg = ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ratio,
                ccw ? ed.startAngle : -ed.startAngle, ccw ? ed.endAngle : -ed.endAngle, ccw);
              break;
            }
            case 4: seg = ed.controlPoints?.length
              ? splinePoints(ed.degree, ed.knots, ed.controlPoints, ed.controlPoints.map((p) => p.weight ?? 1))
              : (ed.fitDatum || []).map((p) => [p.x, p.y]);
              break;
          }
          if (pts.length && seg.length) {
            const l = pts[pts.length - 1];
            if (Math.hypot(l[0] - seg[0][0], l[1] - seg[0][1]) < 1e-9) seg = seg.slice(1);
          }
          pts.push(...seg);
        }
      }
      if (pts.length >= 3) loops.push(tx(m, pts));
    }
    if (!loops.length) return;

    // Área líquida: soma/subtrai de acordo com a profundidade de aninhamento (paridade par/ímpar)
    const areas = loops.map((l) => Math.abs(signedArea(l)));
    let net = 0;
    loops.forEach((l, i) => {
      let depth = 0;
      loops.forEach((o, j) => {
        if (i !== j && areas[j] > areas[i] && pointInPolygon(l[0][0], l[0][1], o)) depth++;
      });
      net += depth % 2 === 0 ? areas[i] : -areas[i];
    });

    const fill = e.solidFill === 1 ? c : null;
    for (const l of loops) {
      const p = addPath(item, l, true, c);
      p.hatch = true;
    }
    item.hatchFill = { loops, color: c, solid: e.solidFill === 1 || !!fill, pattern: e.patternName };
    const outer = loops[areas.indexOf(Math.max(...areas))];
    item.polygons.push({
      pts: outer,
      loops,
      area: Math.abs(net),
      perimeter: loops.reduce((s, l) => s + pathLength(l, true), 0),
      source: `${src}${e.patternName ? ` (${e.patternName})` : ''}`,
      layer,
    });
  }
}

/** Caixa envolvente que ignora entidades muito distantes (outliers). */
function robustBox(items) {
  const all = emptyBox();
  if (!items.length) return [0, 0, 1, 1];
  const cx = [], cy = [];
  for (const it of items) {
    mergeBox(all, it.bbox);
    cx.push((it.bbox[0] + it.bbox[2]) / 2);
    cy.push((it.bbox[1] + it.bbox[3]) / 2);
  }
  if (items.length < 20) return all;
  const q = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(p * (s.length - 1))];
  };
  const x1 = q(cx, 0.02), x2 = q(cx, 0.98), y1 = q(cy, 0.02), y2 = q(cy, 0.98);
  const span = Math.max(x2 - x1, y2 - y1, 1e-9);
  const box = emptyBox();
  // mantém só entidades cuja caixa inteira cabe na região "típica" ampliada
  for (const b of items.map((it) => it.bbox)) {
    if (b[0] > x1 - span && b[2] < x2 + span && b[1] > y1 - span && b[3] < y2 + span) mergeBox(box, b);
  }
  return isFinite(box[0]) ? box : all;
}

/** Distância de um ponto a um segmento. */
export function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

export const UNITS = {
  0: { name: 'Sem unidade', short: 'un', toMeter: null },
  1: { name: 'Polegadas', short: 'in', toMeter: 0.0254 },
  2: { name: 'Pés', short: 'ft', toMeter: 0.3048 },
  4: { name: 'Milímetros', short: 'mm', toMeter: 0.001 },
  5: { name: 'Centímetros', short: 'cm', toMeter: 0.01 },
  6: { name: 'Metros', short: 'm', toMeter: 1 },
  7: { name: 'Quilômetros', short: 'km', toMeter: 1000 },
  14: { name: 'Decímetros', short: 'dm', toMeter: 0.1 },
};
