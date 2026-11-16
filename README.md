# Visualizador DWG

Sistema web (HTML + JavaScript) para visualizar arquivos **DWG** (AutoCAD) — e também DXF — direto no navegador, com painel lateral de informações e cálculo de **área dos polígonos fechados**.

O arquivo é lido **localmente no navegador** (LibreDWG compilado para WebAssembly, via [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)). Nada é enviado a servidores.

## Funcionalidades

- **Abrir arquivo** pelo botão ou **arrastando e soltando** o `.dwg`/`.dxf` na tela.
- **Renderização 2D** em Canvas: linhas, polilinhas (com arcos/bulge), círculos, arcos, elipses, splines (NURBS), hachuras, sólidos, textos, MTEXT, blocos (INSERT, inclusive aninhados e em matriz), cotas e atributos. Cores por ACI, TrueColor, PorCamada e PorBloco.
- **Zoom e pan**: roda do mouse (zoom no cursor), arrastar para mover, botões +/−/ajustar, gesto de pinça no celular. Atalhos: `F` ajusta à tela, `+`/`−` zoom, `Esc` limpa a seleção.
- **Painel lateral direito**
  - **Objeto selecionado**: clique numa entidade (ou *dentro* de um ambiente fechado) para ver tipo, camada, cor, handle, comprimento, raio, **área** e **perímetro**.
  - **Resumo**: versão do DWG, unidade (INSUNITS), dimensões do desenho, contagem por tipo de entidade e soma das áreas.
  - **Áreas**: lista de todos os polígonos fechados ordenados por área (polilinhas fechadas, círculos, elipses, splines fechadas e hachuras — com desconto de furos/ilhas), filtro por camada, troca de unidade (mm, cm, m…) e **exportação CSV**. Clicar numa linha destaca e enquadra o polígono.
  - **Camadas**: liga/desliga camadas.

### Como a área é calculada

- Polilinhas: fórmula de Gauss (shoelace) **exata**, somando a área dos segmentos circulares dos trechos em arco (bulge).
- Círculos e elipses: fórmulas analíticas (πr², πab).
- Hachuras: área líquida dos contornos com regra par/ímpar (ilhas são subtraídas).
- A área é convertida para m² conforme a unidade do desenho (`INSUNITS`). Se o arquivo não declarar unidade, escolha-a na aba **Áreas**.

## Executar localmente

Requer Node.js 20+.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # gera dist/
npm run preview  # serve o build
```

## Deploy na Vercel

O projeto já vem configurado (`vercel.json`, framework Vite, saída em `dist/`).

**Pelo painel:** envie o repositório para o GitHub → em [vercel.com/new](https://vercel.com/new) importe o repositório → *Deploy* (as configurações são detectadas automaticamente).

**Pela CLI:**

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # produção
```

## Estrutura

```
index.html          # layout: área de desenho + painel lateral
src/main.js         # interface, painel, arrastar-e-soltar, CSV
src/viewer.js       # renderizador Canvas, zoom/pan, seleção
src/geometry.js     # DWG → geometria 2D, tesselação, áreas e perímetros
src/worker.js       # Web Worker que lê o DWG com LibreDWG (WASM)
src/colors.js       # paleta AutoCAD (ACI)
vercel.json         # configuração de deploy
```

## Limitações conhecidas

- Exibe o **espaço do modelo** (model space); layouts/paper space não são renderizados.
- Sólidos 3D (ACIS), imagens raster, tolerâncias geométricas e tipos de linha tracejados não são desenhados (as linhas aparecem contínuas).
- Fontes SHX são substituídas por uma fonte sem serifa.
- Licença da biblioteca LibreDWG: GPL-3.0.
