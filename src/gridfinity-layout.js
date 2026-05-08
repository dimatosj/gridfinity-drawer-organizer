#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  PACKS_DIR, PROJECTS_DIR,
  GRID_UNIT, BASEPLATE_HEIGHT, CLEARANCE, HEIGHT_UNIT, BASE_HEIGHT,
  calculateGrid, computeBaseplates, parseDimString,
} = require('./gridfinity-common.js');

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

function heightAnalysis(maxHeightUnits) {
  const rows = [];
  for (let u = 1; u <= 10; u++) {
    const totalMm = BASE_HEIGHT + u * HEIGHT_UNIT;
    const fits = u <= maxHeightUnits;
    rows.push({ units: u, totalMm, fits });
  }
  return rows;
}

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

    .grid-container { display: grid; gap: 2px; overflow-x: auto; }
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

<h2>Grid &amp; Baseplates</h2>
<p style="color:#aaa;font-size:0.88em;margin-bottom:4px;">
  ${gw}×${gd} grid = ${gw * GRID_UNIT}×${gd * GRID_UNIT}mm inside a ${drawer.width}×${drawer.depth}mm drawer
  &mdash; <span style="color:#e17055">${grid.remainderW}mm</span> unused (width) + <span style="color:#e17055">${grid.remainderD}mm</span> unused (depth)
</p>
<div class="grid-label back-label">Back</div>
<div class="grid-container" style="grid-template-columns:repeat(${gw},${cellPx}px);grid-template-rows:repeat(${gd},${cellPx}px);margin:8px 0 4px;">
  ${gridCells.join('\n  ')}
  ${bpTilingViz.join('\n  ')}
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

if (require.main === module) {
  const args = process.argv.slice(2);
  let drawerStr = null;
  let projectName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      console.error('Usage: gridfinity-layout.js <WxDxH> [--project name]');
      console.error('\nComputes grid dimensions, bin height analysis, and baseplate tiling.');
      console.error('Dimensions in mm. Example: gridfinity-layout.js 500x400x80 --project kitchen');
      process.exit(0);
    }
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
  if (!Number.isFinite(drawerMm.width) || !Number.isFinite(drawerMm.depth) || !Number.isFinite(drawerMm.height)
      || drawerMm.width <= 0 || drawerMm.depth <= 0 || drawerMm.height <= 0) {
    console.error('Drawer dimensions must be positive numbers (got %dx%dx%d)', drawerMm.width, drawerMm.depth, drawerMm.height);
    process.exit(1);
  }

  const grid = calculateGrid(drawerMm);
  if (grid.width === 0 || grid.depth === 0) {
    console.error(`Drawer too small for any Gridfinity bins (need at least ${GRID_UNIT}mm in each axis, got ${drawerMm.width}x${drawerMm.depth}mm)`);
    process.exit(1);
  }
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

    try {
      if (process.platform === 'darwin') execSync(`open "${htmlPath}"`);
      else if (process.platform === 'win32') execSync(`start "" "${htmlPath}"`);
      else execSync(`xdg-open "${htmlPath}"`);
    } catch {}
  }
}

module.exports = { loadCatalogSummary, heightAnalysis };
