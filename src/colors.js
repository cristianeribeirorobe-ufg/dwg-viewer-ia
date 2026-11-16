// Paleta AutoCAD Color Index (ACI) e resolução de cores das entidades.

const BASE = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
  6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0',
  250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff',
};

function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const c = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + c(f(5)) + c(f(3)) + c(f(1));
}

// Índices 10–249: 24 matizes × 5 níveis de brilho × 2 saturações
const VALUES = [1, 0.65, 0.5, 0.3, 0.15];
export const ACI = new Array(256).fill('#ffffff');
for (let i = 10; i <= 249; i++) {
  const hue = Math.floor((i - 10) / 10) * 15;
  const step = (i - 10) % 10;
  ACI[i] = hsvToHex(hue, step % 2 === 0 ? 1 : 0.5, VALUES[Math.floor(step / 2)]);
}
for (const [k, v] of Object.entries(BASE)) ACI[+k] = v;

export function rgbToHex(rgb) {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

/** Cor (texto hex) de uma entidade considerando BYLAYER/BYBLOCK. */
export function resolveColor(entity, layerMap, inheritedColor) {
  if (entity.color != null) return rgbToHex(entity.color);
  const idx = entity.colorIndex;
  if (idx === 0) return inheritedColor || '#ffffff'; // BYBLOCK
  if (idx != null && idx > 0 && idx < 256) return ACI[idx];
  // BYLAYER (256) ou ausente
  const layer = layerMap.get(entity.layer);
  if (layer) {
    const li = Math.abs(layer.colorIndex ?? 7);
    if (li > 0 && li < 256) return ACI[li];
  }
  return '#ffffff';
}

/** Ajusta cores muito escuras/claras ao tema do fundo. */
export function adaptToBackground(hex, darkBg) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (darkBg && lum < 40) return '#9aa4b2';
  if (!darkBg && lum > 215) return '#1d2430';
  if (!darkBg && lum > 130) {
    // escurece cores claras (ciano, amarelo, verde) para contrastar com fundo claro
    const k = 130 / lum;
    const h = (v) => Math.round(v * k).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  return hex;
}
