// Renderizador Canvas 2D com zoom/pan, seleção por clique e destaque.

import { adaptToBackground } from './colors.js';
import { distToSegment, pointInPolygon } from './geometry.js';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.view = { s: 1, ox: 0, oy: 0 }; // tela = (ox + (x-cx)·s, oy − (y-cy)·s)
    this.origin = [0, 0];
    this.hiddenLayers = new Set();
    this.darkBg = true;
    this.showText = true;
    this.showFill = true;
    this.selection = null; // { item, polygon }
    this.onSelect = () => {};
    this.onCursor = () => {};
    this.onViewChange = () => {};
    this._batches = null;
    this._raf = 0;
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
  }

  // ---------- cena ----------
  setScene(scene) {
    this.scene = scene;
    const b = scene.bbox;
    this.origin = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    this.selection = null;
    this.hiddenLayers.clear();
    this._rebuild();
    this.fit();
  }

  setLayerVisible(name, visible) {
    if (visible) this.hiddenLayers.delete(name);
    else this.hiddenLayers.add(name);
    this._rebuild();
    this.redraw();
  }

  setDarkBackground(dark) {
    this.darkBg = dark;
    this._rebuild();
    this.redraw();
  }

  _visible(item) {
    return !this.hiddenLayers.has(item.layer);
  }

  /** Agrupa os caminhos por cor em objetos Path2D (coordenadas do mundo). */
  _rebuild() {
    const strokes = new Map(), fills = new Map(), points = [];
    if (!this.scene) return;
    const [cx, cy] = this.origin;
    const get = (map, k) => {
      let p = map.get(k);
      if (!p) map.set(k, (p = new Path2D()));
      return p;
    };
    for (const it of this.scene.items) {
      if (!this._visible(it)) continue;
      for (const p of it.paths) {
        if (p.layer && this.hiddenLayers.has(p.layer)) continue;
        const color = adaptToBackground(p.color, this.darkBg);
        if (p.point) {
          points.push([p.pts[0][0] - cx, p.pts[0][1] - cy, color]);
          continue;
        }
        const path = get(strokes, color);
        appendPath(path, p.pts, p.closed, cx, cy);
        if (p.fill) appendPath(get(fills, color), p.pts, true, cx, cy);
      }
      if (it.hatchFill) {
        const color = adaptToBackground(it.hatchFill.color, this.darkBg);
        const key = color + (it.hatchFill.solid ? '|s' : '|p');
        const path = get(fills, key);
        for (const l of it.hatchFill.loops) appendPath(path, l, true, cx, cy);
      }
    }
    this._batches = { strokes, fills, points };
  }

  // ---------- vista ----------
  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const prevW = this.w, prevH = this.h;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    if (prevW) {
      this.view.ox += (this.w - prevW) / 2;
      this.view.oy += (this.h - prevH) / 2;
    }
    this.redraw();
  }

  fit(box = this.scene?.bbox, margin = 0.06) {
    if (!box) return;
    const bw = Math.max(box[2] - box[0], 1e-9), bh = Math.max(box[3] - box[1], 1e-9);
    const padB = 64; // espaço reservado para a barra de ferramentas flutuante
    const h = Math.max(this.h - padB, 1);
    const s = Math.min(this.w / bw, h / bh) * (1 - 2 * margin);
    const mx = (box[0] + box[2]) / 2 - this.origin[0], my = (box[1] + box[3]) / 2 - this.origin[1];
    this.view = { s, ox: this.w / 2 - mx * s, oy: h / 2 + 8 + my * s };
    this.redraw();
  }

  zoomAt(factor, sx = this.w / 2, sy = this.h / 2) {
    const v = this.view;
    const ns = Math.min(Math.max(v.s * factor, 1e-12), 1e12);
    const f = ns / v.s;
    v.ox = sx - (sx - v.ox) * f;
    v.oy = sy - (sy - v.oy) * f;
    v.s = ns;
    this.redraw();
  }

  toWorld(sx, sy) {
    const v = this.view;
    return [(sx - v.ox) / v.s + this.origin[0], -(sy - v.oy) / v.s + this.origin[1]];
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
      this.onViewChange(this.view);
    });
  }

  // ---------- desenho ----------
  _draw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.darkBg ? '#0b1017' : '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this._drawGrid(ctx, dpr);
    if (!this.scene || !this._batches) return;

    const { s, ox, oy } = this.view;
    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * ox, dpr * oy);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (this.showFill) {
      for (const [key, path] of this._batches.fills) {
        const [color, kind] = key.split('|');
        ctx.globalAlpha = kind === 'p' ? 0.12 : kind === 's' ? 0.55 : 0.85;
        ctx.fillStyle = color;
        ctx.fill(path, 'evenodd');
      }
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 1 / s;
    for (const [color, path] of this._batches.strokes) {
      ctx.strokeStyle = color;
      ctx.stroke(path);
    }

    // seleção
    const sel = this.selection;
    if (sel) {
      const [cx, cy] = this.origin;
      const accent = this.darkBg ? '#a78bfa' : '#4f46e5';
      if (sel.polygon) {
        const p = new Path2D();
        for (const l of sel.polygon.loops || [sel.polygon.pts]) appendPath(p, l, true, cx, cy);
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.25;
        ctx.fill(p, 'evenodd');
        ctx.globalAlpha = 1;
      }
      const p = new Path2D();
      for (const path of sel.item.paths) appendPath(p, path.pts, path.closed, cx, cy);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3 / s;
      ctx.stroke(p);
    }

    // pontos e textos em coordenadas de tela
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const [x, y, color] of this._batches.points) {
      const px = ox + x * s, py = oy - y * s;
      if (px < -4 || py < -4 || px > this.w + 4 || py > this.h + 4) continue;
      ctx.fillStyle = color;
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    if (this.showText) this._drawTexts(ctx);
  }

  /** Grade de pontos em potências de 10 das unidades do desenho (acompanha o zoom). */
  _drawGrid(ctx, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dot = this.darkBg ? 'rgba(148,163,184,' : 'rgba(71,85,105,';
    if (!this.scene) {
      ctx.fillStyle = dot + '0.14)';
      for (let x = 12; x < this.w; x += 24) for (let y = 12; y < this.h; y += 24) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      return;
    }
    const { s, ox, oy } = this.view;
    let step = Math.pow(10, Math.ceil(Math.log10(18 / s))); // espaçamento em unidades do desenho
    if (step * s > 90) step /= 5;
    else if (step * s > 45) step /= 2;
    const px = step * s;
    if (!(px > 6) || this.w / px > 400) return;
    const [cx, cy] = this.origin;
    const [wx0, wy1] = this.toWorld(0, 0);
    const startX = Math.floor(wx0 / step) * step, startY = Math.ceil(wy1 / step) * step;
    const major = step * 5;
    for (let wx = startX; ; wx += step) {
      const sx = ox + (wx - cx) * s;
      if (sx > this.w + 1) break;
      const mx = Math.abs(wx / major - Math.round(wx / major)) < 1e-6;
      for (let wy = startY; ; wy -= step) {
        const sy = oy - (wy - cy) * s;
        if (sy > this.h + 1) break;
        const big = mx && Math.abs(wy / major - Math.round(wy / major)) < 1e-6;
        ctx.fillStyle = dot + (big ? '0.32)' : '0.13)');
        const r = big ? 1.1 : 0.75;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
    }
  }

  _drawTexts(ctx) {
    const { s, ox, oy } = this.view;
    const [cx, cy] = this.origin;
    for (const it of this.scene.items) {
      if (!it.texts.length || !this._visible(it)) continue;
      for (const t of it.texts) {
        const hp = t.height * s;
        if (hp < 2.5) continue;
        const px = ox + (t.x - cx) * s, py = oy - (t.y - cy) * s;
        const reach = hp * (t.text.length + 2) * (t.multiline ? 1 : 0.8);
        if (px < -reach || px > this.w + reach || py < -reach || py > this.h + reach) continue;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-t.rotation);
        if (t.widthFactor && t.widthFactor !== 1) ctx.scale(t.widthFactor, 1);
        ctx.fillStyle = adaptToBackground(t.color, this.darkBg);
        ctx.font = `${hp.toFixed(2)}px "Inter", "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = t.align;
        const lines = t.text.split('\n');
        if (lines.length === 1) {
          ctx.textBaseline = t.baseline;
          ctx.fillText(lines[0], 0, 0);
        } else {
          const lh = hp * 1.667 * (t.lineSpacing || 1);
          const total = lh * (lines.length - 1);
          const y0 = t.baseline === 'top' ? 0 : t.baseline === 'middle' ? -total / 2 : -total;
          ctx.textBaseline = t.baseline;
          lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * lh));
        }
        ctx.restore();
      }
    }
  }

  // ---------- seleção ----------
  select(sel, zoom = false) {
    this.selection = sel;
    if (sel && zoom) {
      const b = sel.polygon ? boxOf(sel.polygon.pts) : sel.item.bbox;
      const cur = [this.toWorld(0, this.h), this.toWorld(this.w, 0)];
      const vw = cur[1][0] - cur[0][0];
      const bw = Math.max(b[2] - b[0], b[3] - b[1]);
      if (bw > vw * 0.9 || bw < vw * 0.02 || b[0] < cur[0][0] || b[2] > cur[1][0] || b[1] < cur[0][1] || b[3] > cur[1][1]) {
        this.fit(b, 0.25);
      }
    }
    this.redraw();
    this.onSelect(sel);
  }

  hitTest(sx, sy) {
    if (!this.scene) return null;
    const [wx, wy] = this.toWorld(sx, sy);
    const tol = 5 / this.view.s;
    let best = null, bestD = tol;
    for (const it of this.scene.items) {
      if (!this._visible(it)) continue;
      const b = it.bbox;
      if (wx < b[0] - tol || wx > b[2] + tol || wy < b[1] - tol || wy > b[3] + tol) continue;
      for (const p of it.paths) {
        const pts = p.pts;
        const n = pts.length;
        for (let i = 1; i < n + (p.closed ? 1 : 0); i++) {
          const d = distToSegment(wx, wy, pts[i - 1], pts[i % n]);
          if (d < bestD) {
            bestD = d;
            best = it;
          }
        }
      }
      for (const t of it.texts) {
        if (Math.hypot(t.x - wx, t.y - wy) < Math.max(tol, t.height)) {
          best = it;
          bestD = 0;
        }
      }
    }
    if (best) return { item: best, polygon: pickPolygon(best, wx, wy) };

    // nenhum contorno próximo → menor polígono fechado que contém o ponto
    let found = null, foundA = Infinity;
    for (const it of this.scene.items) {
      if (!this._visible(it)) continue;
      const b = it.bbox;
      if (wx < b[0] || wx > b[2] || wy < b[1] || wy > b[3]) continue;
      for (const pg of it.polygons) {
        if (pg.area < foundA && pointInPolygon(wx, wy, pg.pts)) {
          found = { item: it, polygon: pg };
          foundA = pg.area;
        }
      }
    }
    return found;
  }

  // ---------- eventos ----------
  _bindEvents() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = null;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const k = e.ctrlKey ? 0.01 : 0.0015;
      this.zoomAt(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.onCursor(this.toWorld(e.clientX - r.left, e.clientY - r.top));
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
        this.view.ox += (e.clientX - prev[0]) / 2;
        this.view.oy += (e.clientY - prev[1]) / 2;
        this.zoomAt(d / pinch.d, mx, my);
        pinch.d = d;
        return;
      }
      if (drag) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.ox += e.clientX - prev[0];
          this.view.oy += e.clientY - prev[1];
          c.style.cursor = 'grabbing';
          this.redraw();
        }
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && drag.button === 0 && e.type === 'pointerup') {
        const r = c.getBoundingClientRect();
        this.select(this.hitTest(e.clientX - r.left, e.clientY - r.top));
      }
      drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      if (e.button === 1) this.fit();
    });
    c.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
  }
}

function appendPath(path, pts, closed, cx, cy) {
  if (!pts.length) return;
  path.moveTo(pts[0][0] - cx, pts[0][1] - cy);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0] - cx, pts[i][1] - cy);
  if (closed) path.closePath();
}

function boxOf(pts) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  }
  return b;
}

function pickPolygon(item, wx, wy) {
  if (!item.polygons.length) return null;
  const inside = item.polygons.filter((p) => pointInPolygon(wx, wy, p.pts)).sort((a, b) => a.area - b.area);
  return inside[0] || (item.polygons.length === 1 ? item.polygons[0] : null);
}

export { boxOf };
