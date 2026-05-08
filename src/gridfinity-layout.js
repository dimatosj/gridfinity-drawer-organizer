#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

const GRID_UNIT = 42;
const BASEPLATE_HEIGHT = 5;
const CLEARANCE = 3;
const HEIGHT_UNIT = 7;
const BASE_HEIGHT = 3.8;

// ── Grid calculation ─────────────────────────────────────────────────────

function calculateGrid(drawerMm) {
  const gridW = Math.floor(drawerMm.width / GRID_UNIT);
  const gridD = Math.floor(drawerMm.depth / GRID_UNIT);
  const remainderW = Math.round(drawerMm.width - gridW * GRID_UNIT);
  const remainderD = Math.round(drawerMm.depth - gridD * GRID_UNIT);
  const maxHeightMm = drawerMm.height - BASEPLATE_HEIGHT - CLEARANCE;
  const maxHeightUnits = Math.max(1, Math.floor((maxHeightMm - BASE_HEIGHT) / HEIGHT_UNIT));

  return { width: gridW, depth: gridD, unit: GRID_UNIT, remainderW, remainderD, maxHeightMm, maxHeightUnits, drawerMm };
}

// ── Baseplate tiling ─────────────────────────────────────────────────────

function tileAxis(total, maxTile) {
  const tiles = [];
  let rem = total;
  while (rem > 0) { tiles.push(Math.min(rem, maxTile)); rem -= maxTile; }
  return tiles;
}

function loadBaseplatePack() {
  const files = fs.readdirSync(PACKS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
    if (pack.bins && pack.bins.some(b => b.type === 'baseplate')) return pack;
  }
  return null;
}

function findBaseplate(w, d, pack) {
  if (!pack) return null;
  return pack.bins.find(b => b.type === 'baseplate' && ((b.gridW === w && b.gridL === d) || (b.gridW === d && b.gridL === w))) || null;
}

function computeBaseplates(grid, maxPlateSize) {
  const baseplatePack = loadBaseplatePack();
  if (baseplatePack && !maxPlateSize) {
    maxPlateSize = Math.max(...baseplatePack.bins.filter(b => b.type === 'baseplate').map(b => Math.max(b.gridW, b.gridL)));
  }
  maxPlateSize = maxPlateSize || 7;
  const wTiles = tileAxis(grid.width, maxPlateSize);
  const dTiles = tileAxis(grid.depth, maxPlateSize);

  const plateMap = new Map();
  for (const w of wTiles) {
    for (const d of dTiles) {
      const key = `${Math.max(w, d)}x${Math.min(w, d)}`;
      if (plateMap.has(key)) plateMap.get(key).qty++;
      else plateMap.set(key, { w: Math.max(w, d), d: Math.min(w, d), qty: 1 });
    }
  }
  const plates = [...plateMap.values()].sort((a, b) => b.w * b.d - a.w * a.d);
  for (const plate of plates) {
    const bp = findBaseplate(plate.w, plate.d, baseplatePack);
    if (bp) { plate.file = bp.file; plate.pack = baseplatePack.pack; }
  }
  return {
    maxPlateSize, pack: baseplatePack ? baseplatePack.pack : null,
    plates, totalPlates: plates.reduce((s, p) => s + p.qty, 0),
    tiling: { wTiles, dTiles },
  };
}

// ── Catalog summary ──────────────────────────────────────────────────────

function loadCatalogSummary(maxHeightUnits) {
  const files = fs.readdirSync(PACKS_DIR).filter(f => f.endsWith('.json'));
  const packs = [];
  const allHeights = new Set();

  for (const f of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
    const bins = (pack.bins || []).filter(b => b.type !== 'baseplate');
    if (bins.length === 0) continue;

    const types = {};
    const heights = new Set();
    let fitsCount = 0;
    for (const b of bins) {
      types[b.type] = (types[b.type] || 0) + 1;
      heights.add(b.heightUnits);
      allHeights.add(b.heightUnits);
      if (b.heightUnits <= maxHeightUnits) fitsCount++;
    }
    packs.push({
      id: pack.pack, name: pack.name, total: bins.length, fits: fitsCount,
      types, heights: [...heights].sort((a, b) => a - b),
    });
  }

  return { packs, allHeights: [...allHeights].sort((a, b) => a - b) };
}

// ── Height analysis ──────────────────────────────────────────────────────

function heightAnalysis(maxHeightUnits) {
  const rows = [];
  for (let u = 1; u <= 10; u++) {
    const totalMm = BASE_HEIGHT + u * HEIGHT_UNIT;
    const fits = u <= maxHeightUnits;
    rows.push({ units: u, totalMm, fits });
  }
  return rows;
}

// ── HTML preview ─────────────────────────────────────────────────────────

function renderLayoutHTML(grid, baseplates, catalogSummary, heights) {
  const gw = grid.width, gd = grid.depth;
  const SCALE = 1.4;
  const cellPx = grid.unit * SCALE;

  const gridCells = [];
  for (let y = 0; y < gd; y++) {
    for (let x = 0; x < gw; x++) {
      const flippedRow = gd - y;
      gridCells.push(`<div class="empty-cell" style="grid-column:${x+1};grid-row:${flippedRow};"></div>`);
    }
  }

  const bp = baseplates;
  const bpTilingViz = [];
  const bpColors = ['#4ecdc4', '#a29bfe', '#fd79a8', '#ffeaa7', '#74b9ff', '#55efc4'];
  let colorIdx = 0;
  let xOff = 0;
  for (const tw of bp.tiling.wTiles) {
    let yOff = 0;
    for (const td of bp.tiling.dTiles) {
      const color = bpColors[colorIdx++ % bpColors.length];
      const flippedRow = gd - yOff - td + 1;
      bpTilingViz.push(`<div class="bp-tile" style="grid-column:${xOff+1}/span ${tw};grid-row:${flippedRow}/span ${td};border-color:${color};" title="${tw}×${td} baseplate"><span class="bp-label">${tw}×${td}</span></div>`);
      yOff += td;
    }
    xOff += tw;
  }

  const heightChips = heights.map(h => {
    const cls = h.fits ? 'height-chip fits' : 'height-chip no-fit';
    return `<span class="${cls}" title="${h.totalMm.toFixed(1)}mm total">${h.units}U<span class="chip-mm">${h.totalMm.toFixed(1)}mm</span></span>`;
  }).join('\n');

  const bpRows = bp.plates.map(p =>
    `<tr><td class="mono">${p.w}×${p.d}</td><td class="center">${p.qty}</td><td class="mono">${p.file || '<span style="color:#e17055">not available</span>'}</td></tr>`
  ).join('\n');

  const drawer = grid.drawerMm;
  const gridWidthPx = gw * cellPx + (gw - 1) * 2;
  const gridDepthPx = gd * cellPx + (gd - 1) * 2;
  const remWPx = grid.remainderW * SCALE;
  const remDPx = grid.remainderD * SCALE;
  const drawerWPx = gridWidthPx + remWPx;
  const drawerDPx = gridDepthPx + remDPx;

  function makeDrawerViz(label, gridLeft, gridTop) {
    const gapRight = drawerWPx - gridWidthPx - gridLeft;
    const gapBottom = drawerDPx - gridDepthPx - gridTop;
    const leftLabel = gridLeft > 8 ? `<span class="gap-label" style="left:${gridLeft/2}px;top:${drawerDPx/2}px;">${Math.round(gridLeft/SCALE)}mm</span>` : '';
    const rightLabel = gapRight > 8 ? `<span class="gap-label" style="right:${gapRight/2}px;top:${drawerDPx/2}px;">${Math.round(gapRight/SCALE)}mm</span>` : '';
    const topLabel = gridTop > 8 ? `<span class="gap-label" style="top:${gridTop/2}px;left:${drawerWPx/2}px;">${Math.round(gridTop/SCALE)}mm</span>` : '';
    const bottomLabel = gapBottom > 8 ? `<span class="gap-label" style="bottom:${gapBottom/2}px;left:${drawerWPx/2}px;">${Math.round(gapBottom/SCALE)}mm</span>` : '';
    return `<div class="placement-option">
      <div class="placement-label">${label}</div>
      <div class="drawer-outline" style="width:${drawerWPx}px;height:${drawerDPx}px;">
        ${leftLabel}${rightLabel}${topLabel}${bottomLabel}
        <div class="grid-container" style="position:absolute;left:${gridLeft}px;top:${gridTop}px;grid-template-columns:repeat(${gw},${cellPx}px);grid-template-rows:repeat(${gd},${cellPx}px);">
          ${gridCells.join('\n          ')}
          ${bpTilingViz.join('\n          ')}
        </div>
      </div>
    </div>`;
  }

  const placements = [
    makeDrawerViz('Back-left (gap at front + right)', 0, 0),
    makeDrawerViz('Centered (gap split evenly)', remWPx / 2, remDPx / 2),
    makeDrawerViz('Back-right (gap at front + left)', remWPx, 0),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gridfinity Grid Analysis</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1a1a2e; color: #eee;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; line-height: 1.5; padding: 24px;
    }
    h1 { font-size: 1.8rem; color: #4ecdc4; margin-bottom: 4px; }
    h2 { font-size: 1.2rem; color: #a29bfe; margin: 32px 0 12px; border-bottom: 1px solid #333; padding-bottom: 6px; }
    .subtitle { color: #aaa; margin-bottom: 24px; }

    .placements { display: flex; gap: 32px; flex-wrap: wrap; margin: 16px 0 24px; }
    .placement-option { display: flex; flex-direction: column; align-items: center; }
    .placement-label { font-size: 0.82em; color: #aaa; margin-bottom: 8px; font-weight: 500; }
    .drawer-outline {
      border: 2px solid #e17055; border-radius: 4px; position: relative;
      background: repeating-linear-gradient(45deg, rgba(225,112,85,0.04), rgba(225,112,85,0.04) 4px, transparent 4px, transparent 8px);
    }
    .gap-label {
      position: absolute; transform: translate(-50%,-50%);
      font-size: 0.7em; color: #e17055; font-weight: 600; white-space: nowrap;
    }

    .grid-container { display: grid; gap: 2px; }
    .empty-cell {
      background: #2d3436; border: 1px dashed #444; border-radius: 3px;
      aspect-ratio: 1; min-width: 0;
    }
    .bp-tile {
      border: 2px solid; border-radius: 6px; display: flex;
      align-items: center; justify-content: center;
      background: rgba(255,255,255,0.03); pointer-events: none;
      position: relative; z-index: 2;
    }
    .bp-label { font-size: 0.75em; font-weight: 600; opacity: 0.7; }

    .grid-label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; color: #666; }
    .back-label { margin-bottom: 6px; }
    .front-label { margin-top: 6px; }

    .height-strip { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
    .height-chip {
      display: inline-flex; flex-direction: column; align-items: center;
      padding: 6px 10px; border-radius: 6px; font-size: 0.85em; font-weight: 600;
      min-width: 52px; text-align: center;
    }
    .height-chip.fits { background: rgba(85,239,196,0.15); color: #55efc4; border: 1px solid rgba(85,239,196,0.3); }
    .height-chip.no-fit { background: rgba(99,110,114,0.15); color: #636e72; border: 1px solid rgba(99,110,114,0.2); }
    .chip-mm { font-size: 0.75em; font-weight: 400; opacity: 0.7; margin-top: 1px; }

    .file-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.88em; }
    .file-table th { background: #16213e; color: #a29bfe; text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a2a4e; }
    .file-table td { padding: 7px 10px; border-bottom: 1px solid #222240; }
    .file-table tr:hover td { background: #1e1e3a; }
    .file-table .center { text-align: center; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em; }

    .summary-box { background: #16213e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 14px 18px; margin: 16px 0; line-height: 1.8; }
    .stat { display: inline-block; margin-right: 24px; }
    .stat-value { font-size: 1.4em; font-weight: 700; color: #4ecdc4; }
    .stat-label { font-size: 0.82em; color: #888; }
  </style>
</head>
<body>

<h1>Gridfinity Grid Analysis</h1>
<p class="subtitle">Drawer: ${drawer.width}×${drawer.depth}×${drawer.height}mm</p>

<div class="summary-box">
  <span class="stat"><span class="stat-value">${gw}×${gd}</span><br><span class="stat-label">grid cells</span></span>
  <span class="stat"><span class="stat-value">${gw * gd}</span><br><span class="stat-label">total cells</span></span>
  <span class="stat"><span class="stat-value">${grid.maxHeightUnits}U</span><br><span class="stat-label">max bin height (${grid.maxHeightMm.toFixed(0)}mm)</span></span>
  <span class="stat"><span class="stat-value">${bp.totalPlates}</span><br><span class="stat-label">baseplates</span></span>
</div>

<h2>Bin Heights</h2>
<div class="height-strip">
  ${heightChips}
</div>
<p style="color:#888;font-size:0.82em;margin-top:4px;">
  Clearance budget: ${drawer.height}mm drawer &minus; ${BASEPLATE_HEIGHT}mm baseplate &minus; ${CLEARANCE}mm clearance = ${grid.maxHeightMm.toFixed(0)}mm available for bins
</p>

<h2>Grid Placement in Drawer</h2>
<p style="color:#aaa;font-size:0.88em;margin-bottom:4px;">
  ${gw}×${gd} grid = ${gw * GRID_UNIT}×${gd * GRID_UNIT}mm inside a ${drawer.width}×${drawer.depth}mm drawer
  &mdash; <span style="color:#e17055">${grid.remainderW}mm</span> gap (width) + <span style="color:#e17055">${grid.remainderD}mm</span> gap (depth)
</p>
<div class="grid-label back-label">Back</div>
<div class="placements">
  ${placements.join('\n  ')}
</div>
<div class="grid-label front-label">Front (you)</div>

<h2>Baseplate Tiling</h2>
<div class="summary-box">
  <strong>Max plate size:</strong> ${bp.maxPlateSize}×${bp.maxPlateSize}
  ${bp.pack ? ` &mdash; <strong>${bp.pack}</strong> pack` : ''}<br>
  <strong>Tiling:</strong> ${bp.plates.map(p => `${p.qty}× ${p.w}×${p.d}`).join(', ')}
</div>
<table class="file-table">
  <thead><tr><th>Size</th><th>Qty</th><th>File</th></tr></thead>
  <tbody>${bpRows}</tbody>
</table>

</body>
</html>`;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseDimString(s) {
  const parts = s.replace(/mm$/i, '').split(/x/i).map(Number);
  if (parts.length === 3) return { width: parts[0], depth: parts[1], height: parts[2] };
  return null;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let drawerStr = null;
  let projectName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--drawer' || args[i] === '-d') drawerStr = args[++i];
    else if (args[i] === '--project' || args[i] === '-p') projectName = args[++i];
    else if (!drawerStr && !args[i].startsWith('--')) drawerStr = args[i];
  }

  if (!drawerStr) {
    console.error('Usage: gridfinity-layout.js <WxDxH> [--project name]');
    console.error('  Dimensions in mm. Example: 500x400x80');
    process.exit(1);
  }

  const drawerMm = parseDimString(drawerStr);
  if (!drawerMm) {
    console.error('Invalid dimensions. Use WxDxH format (mm), e.g. 500x400x80');
    process.exit(1);
  }

  const grid = calculateGrid(drawerMm);
  const baseplates = computeBaseplates(grid);
  const catalogSummary = loadCatalogSummary(grid.maxHeightUnits);
  const heights = heightAnalysis(grid.maxHeightUnits);

  console.error(`Drawer: ${drawerMm.width}×${drawerMm.depth}×${drawerMm.height}mm`);
  console.error(`Grid: ${grid.width}×${grid.depth} (${grid.width * grid.depth} cells, ${GRID_UNIT}mm unit)`);
  console.error(`Max bin height: ${grid.maxHeightUnits}U (${grid.maxHeightMm.toFixed(0)}mm)`);
  console.error(`Remainder: ${grid.remainderW}mm × ${grid.remainderD}mm`);
  console.error(`Baseplates: ${baseplates.plates.map(p => `${p.qty}× ${p.w}×${p.d}`).join(', ')} (${baseplates.totalPlates} total)`);
  console.error('');
  console.error('Available packs:');
  for (const p of catalogSummary.packs) {
    const fitStr = p.fits === p.total ? `all ${p.total} fit` : `${p.fits}/${p.total} fit`;
    console.error(`  ${p.id}: ${p.total} bins (${fitStr})`);
  }

  if (projectName) {
    const dir = path.join(PROJECTS_DIR, projectName);
    fs.mkdirSync(dir, { recursive: true });

    const output = {
      drawer: drawerMm,
      grid: {
        width: grid.width, depth: grid.depth, unit: GRID_UNIT,
        remainderW: grid.remainderW, remainderD: grid.remainderD,
        maxHeightMm: grid.maxHeightMm, maxHeightUnits: grid.maxHeightUnits,
      },
      baseplates,
      catalog: catalogSummary,
    };
    fs.writeFileSync(path.join(dir, 'grid.json'), JSON.stringify(output, null, 2) + '\n');
    console.error(`\nSaved: projects/${projectName}/grid.json`);

    const html = renderLayoutHTML(grid, baseplates, catalogSummary, heights);
    const htmlPath = path.join(dir, 'grid-preview.html');
    fs.writeFileSync(htmlPath, html);
    console.error(`Preview: projects/${projectName}/grid-preview.html`);

    if (process.platform === 'darwin') execSync(`open "${htmlPath}"`);
    else if (process.platform === 'win32') execSync(`start "" "${htmlPath}"`);
    else execSync(`xdg-open "${htmlPath}"`);
  }
}

module.exports = { calculateGrid, computeBaseplates, loadCatalogSummary, heightAnalysis };
