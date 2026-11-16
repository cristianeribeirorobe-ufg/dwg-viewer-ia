// Web Worker: lê o DWG/DXF com LibreDWG (WebAssembly) e monta a cena
// sem travar a interface.
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';
import { buildScene } from './geometry.js';

let libPromise = null;
// DXF mínimo usado para "aquecer" o módulo. Sem isso, a primeira leitura de
// strings Unicode de um DWG R2007+ aborta o WebAssembly (bug do libredwg-web 0.9).
const WARMUP_DXF = '0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n10\n0\n20\n0\n40\n1\n1\nx\n0\nENDSEC\n0\nEOF\n';

// O Vite resolve e versiona o libredwg-web.wasm automaticamente (new URL(..., import.meta.url)).
const getLib = () =>
  (libPromise ??= LibreDwg.create().then((lib) => {
    try {
      const ptr = lib.dwg_read_data(WARMUP_DXF, Dwg_File_Type.DXF);
      if (ptr) {
        lib.convert(ptr);
        lib.dwg_free(ptr);
      }
    } catch (e) {
      console.warn('Aquecimento do LibreDWG falhou:', e);
    }
    return lib;
  }));

self.onmessage = async ({ data }) => {
  const { id, type, buffer, name } = data;
  try {
    if (type === 'init') {
      await getLib();
      self.postMessage({ id, ok: true });
      return;
    }
    const lib = await getLib();
    const isDxf = /\.dxf$/i.test(name);
    const t0 = performance.now();
    const ptr = lib.dwg_read_data(buffer, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
    if (!ptr) throw new Error('Não foi possível decodificar o arquivo.');
    const version = isDxf ? null : lib.dwg_get_version_type(ptr);
    const db = lib.convert(ptr);
    lib.dwg_free(ptr);
    const parseMs = performance.now() - t0;
    const scene = buildScene(db);
    const h = db.header || {};
    self.postMessage({
      id,
      ok: true,
      scene,
      info: {
        version: version?.description || (isDxf ? 'DXF' : 'Desconhecida'),
        insUnits: h.INSUNITS ?? 0,
        extMin: h.EXTMIN,
        extMax: h.EXTMAX,
        layers: (db.tables?.LAYER?.entries ?? []).map((l) => ({
          name: l.name, colorIndex: l.colorIndex, off: l.off || l.colorIndex < 0, frozen: l.frozen,
        })),
        blockCount: (db.tables?.BLOCK_RECORD?.entries ?? []).filter((b) => !b.name.startsWith('*')).length,
        entityCount: db.entities.length,
        parseMs,
        buildMs: performance.now() - t0 - parseMs,
      },
    });
  } catch (err) {
    // Após um abort o módulo WASM fica inutilizável: recria na próxima leitura.
    libPromise = null;
    const msg = /Aborted|out of WASM memory/i.test(err?.message || '')
      ? 'O leitor DWG não conseguiu interpretar este arquivo (versão ou conteúdo não suportado).'
      : err?.message || String(err);
    self.postMessage({ id, ok: false, error: msg });
  }
};
