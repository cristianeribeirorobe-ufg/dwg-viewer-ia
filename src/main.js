import './style.css';
import { ACI } from './colors.js';
import { UNITS } from './geometry.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const viewer = new Viewer($('canvas'));
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const state = {
  file: null,
  scene: null,
  info: null,
  unit: 0,
  polygons: [], // lista plana de { n, item, polygon }
};

// ---------- comunicação com o worker ----------
let msgId = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  data.ok ? p.resolve(data) : p.reject(new Error(data.error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'Falha no processamento.'));
  pending.clear();
};
function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}
call({ type: 'init' }).catch((e) => toast('Falha ao carregar o leitor DWG: ' + e.message));

// ---------- formatação ----------
const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const f2 = nf(2), f3 = nf(3), f0 = nf(0);
function fmtNum(v) {
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e9) ? v.toExponential(3).replace('.', ',') : f3.format(v);
}
function unitInfo() {
  return UNITS[state.unit] || UNITS[0];
}
function fmtArea(a) {
  const u = unitInfo();
  return u.toMeter ? `${f2.format(a * u.toMeter ** 2)} m²` : `${fmtNum(a)} un²`;
}
function fmtLen(l) {
  const u = unitInfo();
  return u.toMeter ? `${f2.format(l * u.toMeter)} m` : `${fmtNum(l)} un`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const deg = (r) => `${f2.format((r * 180) / Math.PI)}°`;

// ---------- carregamento de arquivo ----------
async function openFile(file) {
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    toast('Selecione um arquivo .dwg ou .dxf.');
    return;
  }
  showLoading(`Lendo ${file.name}…`);
  try {
    const buffer = await file.arrayBuffer();
    showLoading('Interpretando o desenho…');
    const { scene, info } = await call({ type: 'open', buffer, name: file.name }, [buffer]);
    state.file = file;
    state.scene = scene;
    state.info = info;
    state.unit = UNITS[info.insUnits] ? info.insUnits : 0;
    if (!scene.items.length) toast('O arquivo foi lido, mas não há entidades visíveis no espaço do modelo.');
    $('empty').hidden = true;
    $('fileName').textContent = file.name;
    $('filePill').classList.add('loaded');
    document.title = `${file.name} — Visualizador DWG`;
    viewer.setScene(scene);
    buildPolygonList();
    renderSummary();
    renderUnits();
    renderAreaLayerFilter();
    renderAreas();
    renderLayers();
    renderSelection(null);
  } catch (e) {
    console.error(e);
    toast(`Não foi possível abrir “${file.name}”: ${e.message}`);
  } finally {
    hideLoading();
  }
}

for (const id of ['fileInput', 'fileInput2']) {
  $(id).addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
}

// arrastar e soltar
const stage = $('stage');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  stage.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    stage.classList.remove('dragging');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dragging');
  openFile(e.dataTransfer?.files?.[0]);
});

// ---------- barra de ferramentas ----------
$('zoomIn').onclick = () => viewer.zoomAt(1.4);
$('zoomOut').onclick = () => viewer.zoomAt(1 / 1.4);
$('zoomFit').onclick = () => viewer.fit();
$('toggleText').onclick = (e) => {
  viewer.showText = !viewer.showText;
  e.currentTarget.classList.toggle('on', viewer.showText);
  e.currentTarget.setAttribute('aria-pressed', viewer.showText);
  viewer.redraw();
};
$('toggleFill').onclick = (e) => {
  viewer.showFill = !viewer.showFill;
  e.currentTarget.classList.toggle('on', viewer.showFill);
  e.currentTarget.setAttribute('aria-pressed', viewer.showFill);
  viewer.redraw();
};
$('toggleBg').onclick = () => viewer.setDarkBackground(!viewer.darkBg);

// tema da interface (claro/escuro), lembrado entre visitas
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0d12' : '#eef1f6');
  viewer.setDarkBackground(theme === 'dark');
  try { localStorage.setItem('dwg-theme', theme); } catch {}
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('dwg-theme'); } catch {}
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('toggleTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

// painel lateral recolhível
$('togglePanel').classList.add('on');
$('togglePanel').onclick = (e) => {
  const hidden = document.body.classList.toggle('panel-hidden');
  e.currentTarget.classList.toggle('on', !hidden);
};
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'f' || e.key === 'F') viewer.fit();
  else if (e.key === '+' || e.key === '=') viewer.zoomAt(1.4);
  else if (e.key === '-') viewer.zoomAt(1 / 1.4);
  else if (e.key === 'Escape') viewer.select(null);
});

viewer.onCursor = ([x, y]) => {
  if (state.scene) $('coords').textContent = `x: ${fmtNum(x)}  y: ${fmtNum(y)}`;
};
viewer.onViewChange = (v) => {
  if (!state.scene) return;
  const b = state.scene.bbox;
  const fitS = Math.min(viewer.w / (b[2] - b[0] || 1), Math.max(viewer.h - 64, 1) / (b[3] - b[1] || 1)) * 0.88;
  $('zoomLevel').textContent = `${f0.format((v.s / fitS) * 100)}%`;
};
viewer.onSelect = (sel) => {
  renderSelection(sel);
  for (const tr of $('areaRows').querySelectorAll('tr')) {
    const row = state.polygons[+tr.dataset.i];
    tr.classList.toggle('sel', !!sel && row.polygon === sel.polygon);
  }
};

// ---------- abas ----------
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn);
    for (const s of document.querySelectorAll('.tab-body')) s.hidden = s.dataset.tab !== btn.dataset.tab;
  };
}

// ---------- painel: seleção ----------
function renderSelection(sel) {
  const el = $('selection');
  if (!sel) {
    el.className = 'muted';
    el.innerHTML = 'Clique em uma entidade ou dentro de um ambiente fechado para ver suas informações.';
    return;
  }
  const { item, polygon } = sel;
  const e = item.entity;
  const rows = [
    ['Tipo', TYPE_NAMES[e.type] ? `${TYPE_NAMES[e.type]} (${e.type})` : e.type],
    ['Camada', item.layer],
    ['Cor', `<span class="sw-inline" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${item.color};margin-right:6px"></span>${colorLabel(e)}`],
    ['Handle', e.handle],
  ];
  const len = (pts, closed) => {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (closed && pts.length > 2) l += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
    return l;
  };
  switch (e.type) {
    case 'LINE':
      rows.push(['Comprimento', fmtLen(Math.hypot(e.endPoint.x - e.startPoint.x, e.endPoint.y - e.startPoint.y))]);
      rows.push(['Início', `${fmtNum(e.startPoint.x)}; ${fmtNum(e.startPoint.y)}`]);
      rows.push(['Fim', `${fmtNum(e.endPoint.x)}; ${fmtNum(e.endPoint.y)}`]);
      rows.push(['Ângulo', deg(Math.atan2(e.endPoint.y - e.startPoint.y, e.endPoint.x - e.startPoint.x))]);
      break;
    case 'CIRCLE':
      rows.push(['Centro', `${fmtNum(e.center.x)}; ${fmtNum(e.center.y)}`], ['Raio', fmtLen(e.radius)], ['Diâmetro', fmtLen(2 * e.radius)]);
      break;
    case 'ARC': {
      let sw = e.endAngle - e.startAngle;
      while (sw <= 0) sw += Math.PI * 2;
      rows.push(['Centro', `${fmtNum(e.center.x)}; ${fmtNum(e.center.y)}`], ['Raio', fmtLen(e.radius)],
        ['Ângulo inicial', deg(e.startAngle)], ['Ângulo final', deg(e.endAngle)], ['Comprimento do arco', fmtLen(e.radius * sw)]);
      break;
    }
    case 'LWPOLYLINE':
    case 'POLYLINE2D':
    case 'POLYLINE3D':
      rows.push(['Vértices', (e.vertices || []).length], ['Fechada', item.paths[0]?.closed ? 'Sim' : 'Não']);
      if (!polygon && item.paths[0]) rows.push(['Comprimento', fmtLen(len(item.paths[0].pts, false))]);
      break;
    case 'TEXT':
    case 'MTEXT':
      rows.push(['Texto', esc(item.texts[0]?.text ?? '')], ['Altura', fmtNum(e.textHeight)]);
      break;
    case 'INSERT':
      rows.push(['Bloco', esc(e.name)], ['Inserção', `${fmtNum(e.insertionPoint.x)}; ${fmtNum(e.insertionPoint.y)}`],
        ['Escala', `${fmtNum(e.xScale ?? 1)} × ${fmtNum(e.yScale ?? 1)}`], ['Rotação', deg(e.rotation || 0)]);
      for (const a of e.attribs || []) rows.push([`Atributo ${esc(a.tag)}`, esc(a.text?.text ?? '')]);
      break;
    case 'DIMENSION':
      if (e.measurement != null) rows.push(['Medida', fmtNum(e.measurement)]);
      if (e.text) rows.push(['Texto', esc(e.text)]);
      break;
    case 'HATCH':
      rows.push(['Padrão', esc(e.patternName || '—')], ['Preenchimento', e.solidFill === 1 ? 'Sólido' : 'Padrão'], ['Contornos', (e.boundaryPaths || []).length]);
      break;
  }
  const w = item.bbox[2] - item.bbox[0], h = item.bbox[3] - item.bbox[1];
  rows.push(['Dimensões (L × A)', `${fmtLen(w)} × ${fmtLen(h)}`]);

  let html = '';
  if (polygon) {
    html += `<div class="highlight"><span class="label">Área${polygon.loops?.length > 1 ? ' líquida' : ''}</span><span class="value">${fmtArea(polygon.area)}</span></div>`;
    rows.splice(2, 0, ['Perímetro', fmtLen(polygon.perimeter)]);
    if (polygon.source !== e.type) rows.splice(2, 0, ['Polígono', esc(polygon.source)]);
  }
  html += '<dl class="props">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${typeof v === 'string' && !v.includes('<') ? esc(v) : v}</dd>`).join('') + '</dl>';
  el.className = '';
  el.innerHTML = html;
}

const TYPE_NAMES = {
  LINE: 'Linha', CIRCLE: 'Círculo', ARC: 'Arco', ELLIPSE: 'Elipse', LWPOLYLINE: 'Polilinha',
  POLYLINE2D: 'Polilinha 2D', POLYLINE3D: 'Polilinha 3D', SPLINE: 'Spline', TEXT: 'Texto', MTEXT: 'Texto múltiplo',
  INSERT: 'Bloco', DIMENSION: 'Cota', HATCH: 'Hachura', SOLID: 'Sólido 2D', POINT: 'Ponto', LEADER: 'Chamada',
};

function colorLabel(e) {
  if (e.color != null) return `RGB ${(e.color >> 16) & 255}, ${(e.color >> 8) & 255}, ${e.color & 255}`;
  if (e.colorIndex === 256 || e.colorIndex == null) return 'PorCamada';
  if (e.colorIndex === 0) return 'PorBloco';
  return `ACI ${e.colorIndex}`;
}

// ---------- painel: resumo ----------
function renderSummary() {
  const { scene, info, file } = state;
  const polys = state.polygons.filter((p) => !p.inBlock);
  const totalArea = polys.reduce((s, p) => s + p.polygon.area, 0);
  const b = scene.bbox;
  const types = Object.entries(scene.typeCount).sort((a, b) => b[1] - a[1]);
  $('summary').className = '';
  $('summary').innerHTML = `
    <div class="highlight"><span class="label">Soma das áreas dos polígonos</span><span class="value">${fmtArea(totalArea)}</span></div>
    <div class="stats">
      <div class="stat"><div class="v">${f0.format(info.entityCount)}</div><div class="l">Entidades</div></div>
      <div class="stat"><div class="v">${f0.format(info.layers.length)}</div><div class="l">Camadas</div></div>
      <div class="stat"><div class="v">${f0.format(polys.length)}</div><div class="l">Polígonos fechados</div></div>
      <div class="stat"><div class="v">${f0.format(info.blockCount)}</div><div class="l">Blocos definidos</div></div>
    </div>
    <dl class="props">
      <dt>Arquivo</dt><dd>${esc(file.name)}</dd>
      <dt>Tamanho</dt><dd>${f2.format(file.size / 1024 / 1024)} MB</dd>
      <dt>Versão</dt><dd>${esc(info.version)}</dd>
      <dt>Unidade (INSUNITS)</dt><dd>${esc((UNITS[info.insUnits] || { name: `Código ${info.insUnits}` }).name)}</dd>
      <dt>Largura do desenho</dt><dd>${fmtLen(b[2] - b[0])}</dd>
      <dt>Altura do desenho</dt><dd>${fmtLen(b[3] - b[1])}</dd>
      <dt>Leitura</dt><dd>${f0.format(info.parseMs + info.buildMs)} ms</dd>
    </dl>
    <h3>Entidades por tipo</h3>
    <div class="type-list">${types.map(([t, n]) => `<span class="chip">${esc(t)} <b>${n}</b></span>`).join('')}</div>
    ${scene.warnings.length ? `<div class="warn">Não renderizado: ${scene.warnings.map(esc).join('; ')}</div>` : ''}`;
}

// ---------- painel: áreas ----------
function buildPolygonList() {
  const list = [];
  for (const item of state.scene.items) {
    for (const polygon of item.polygons) {
      const inBlock = item.type === 'INSERT' || item.type === 'DIMENSION';
      list.push({ item, polygon, inBlock, hatch: item.type === 'HATCH' });
    }
  }
  list.sort((a, b) => b.polygon.area - a.polygon.area);
  state.polygons = list;
}

function renderUnits() {
  const sel = $('unitSelect');
  sel.innerHTML = Object.entries(UNITS).map(([k, u]) => `<option value="${k}">${u.name}</option>`).join('');
  sel.value = String(state.unit);
}
$('unitSelect').onchange = (e) => {
  state.unit = +e.target.value;
  renderAreas();
  renderSummary();
  renderSelection(viewer.selection);
};

function renderAreaLayerFilter() {
  const layers = [...new Set(state.polygons.map((p) => p.polygon.layer || p.item.layer))].sort();
  $('areaLayer').innerHTML = '<option value="">Todas</option>' + layers.map((l) => `<option>${esc(l)}</option>`).join('');
}
for (const id of ['areaLayer', 'includeBlocks', 'includeHatch']) $(id).onchange = renderAreas;

function filteredPolygons() {
  const layer = $('areaLayer').value;
  const blocks = $('includeBlocks').checked, hatch = $('includeHatch').checked;
  return state.polygons
    .map((p, i) => ({ ...p, i }))
    .filter((p) => (blocks || !p.inBlock) && (hatch || !p.hatch) && (!layer || (p.polygon.layer || p.item.layer) === layer));
}

function renderAreas() {
  if (!state.scene) return;
  const rows = filteredPolygons();
  const total = rows.reduce((s, p) => s + p.polygon.area, 0);
  $('areaTotal').innerHTML = `
    <div class="stat"><div class="v">${fmtArea(total)}</div><div class="l">Área total (${rows.length} polígonos)</div></div>
    <div class="stat"><div class="v">${rows.length ? fmtArea(total / rows.length) : '—'}</div><div class="l">Área média</div></div>`;
  const MAX = 1500;
  $('areaRows').innerHTML = rows.slice(0, MAX).map((p, n) => `
    <tr data-i="${p.i}" class="${viewer.selection?.polygon === p.polygon ? 'sel' : ''}">
      <td>${n + 1}</td>
      <td title="${esc(p.polygon.source)}">${esc(p.polygon.source)}</td>
      <td title="${esc(p.polygon.layer || p.item.layer)}">${esc(p.polygon.layer || p.item.layer)}</td>
      <td class="num">${fmtArea(p.polygon.area)}</td>
      <td class="num">${fmtLen(p.polygon.perimeter)}</td>
    </tr>`).join('') +
    (rows.length > MAX ? `<tr><td colspan="5" class="muted">… mais ${rows.length - MAX} polígonos (veja o CSV)</td></tr>` : '') +
    (!rows.length ? '<tr><td colspan="5" class="muted">Nenhum polígono fechado com esses filtros.</td></tr>' : '');
  $('exportCsv').disabled = !rows.length;
}
$('areaRows').onclick = (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const p = state.polygons[+tr.dataset.i];
  viewer.select({ item: p.item, polygon: p.polygon }, true);
};
$('exportCsv').onclick = () => {
  const u = unitInfo();
  const aUnit = u.toMeter ? 'm2' : 'un2', lUnit = u.toMeter ? 'm' : 'un';
  const k = u.toMeter || 1;
  const lines = [`objeto;camada;handle;area_${aUnit};perimetro_${lUnit}`];
  for (const p of filteredPolygons()) {
    lines.push([p.polygon.source, p.polygon.layer || p.item.layer, p.item.entity.handle,
      (p.polygon.area * k * k).toFixed(4).replace('.', ','), (p.polygon.perimeter * k).toFixed(4).replace('.', ',')]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.file.name.replace(/\.\w+$/, '') + '_areas.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- painel: camadas ----------
function renderLayers() {
  const counts = new Map();
  for (const it of state.scene.items) counts.set(it.layer, (counts.get(it.layer) || 0) + 1);
  const layers = state.info.layers.length ? state.info.layers : [...counts.keys()].map((name) => ({ name, colorIndex: 7 }));
  for (const name of counts.keys()) if (!layers.some((l) => l.name === name)) layers.push({ name, colorIndex: 7 });
  layers.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  for (const l of layers) if (l.off || l.frozen) viewer.setLayerVisible(l.name, false);
  $('layers').className = '';
  $('layers').innerHTML = `
    <div class="layer-tools"><button class="btn sm" data-all="1">Mostrar todas</button><button class="btn sm" data-all="0">Ocultar todas</button></div>
    ${layers.map((l) => `
      <label class="layer-row">
        <input type="checkbox" data-layer="${esc(l.name)}" ${viewer.hiddenLayers.has(l.name) ? '' : 'checked'} />
        <span class="sw" style="background:${ACI[Math.abs(l.colorIndex) || 7]}"></span>
        <span class="name" title="${esc(l.name)}">${esc(l.name)}</span>
        <span class="count">${counts.get(l.name) || 0}</span>
      </label>`).join('')}`;
}
$('layers').addEventListener('change', (e) => {
  const name = e.target.dataset.layer;
  if (name != null) viewer.setLayerVisible(name, e.target.checked);
});
$('layers').addEventListener('click', (e) => {
  const all = e.target.dataset.all;
  if (all == null) return;
  for (const cb of $('layers').querySelectorAll('input[data-layer]')) {
    cb.checked = all === '1';
    if (all === '1') viewer.hiddenLayers.delete(cb.dataset.layer);
    else viewer.hiddenLayers.add(cb.dataset.layer);
  }
  viewer.setLayerVisible('\u0000', true); // força reconstrução
});

// ---------- utilidades de UI ----------
function showLoading(text) {
  $('loadingText').textContent = text;
  $('loading').hidden = false;
}
function hideLoading() {
  $('loading').hidden = true;
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
