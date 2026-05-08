#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

const TYPE_COLORS = {
  'purpose-built': '#4ecdc4',
  'open-tub':      '#a29bfe',
  'compartmented': '#fd79a8',
  'filler':        '#3d3d3d',
  'empty':         '#2d3436',
  'reserved':      '#636e72',
};

const CATEGORY_COLORS = {
  'kitchen-utensils': '#55efc4',
  'batteries':        '#ffeaa7',
  'tools':            '#ff6b6b',
  'cables':           '#74b9ff',
};

function binColor(box) {
  if (box.isFiller && box.type === 'empty') return '#2d3436';
  if (box.isFiller) return '#5f9ea0';
  if (box.type === 'reserved') return '#636e72';
  if (box.bin && box.bin.category && CATEGORY_COLORS[box.bin.category]) {
    return CATEGORY_COLORS[box.bin.category];
  }
  return TYPE_COLORS[box.type] || '#636e72';
}

function textColor(bgHex) {
  const r = parseInt(bgHex.slice(1, 3), 16);
  const g = parseInt(bgHex.slice(3, 5), 16);
  const b = parseInt(bgHex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5
    ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)';
}

function renderHTML(layout, projectName) {
  const { grid, boxes, dropped, printList } = layout;
  const gw = grid.width, gd = grid.depth;
  const SCALE = 1.4;
  const cellPx = grid.unit * SCALE;

  const legendTypes = [...new Set(boxes.filter(b => !b.isFiller).map(b => b.type))];
  const legendItems = legendTypes.map(t => {
    const color = TYPE_COLORS[t] || '#636e72';
    const label = t.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    return `<div class="legend-item"><span class="swatch" style="background:${color};"></span>${label}</div>`;
  }).join('');
  const hasFillers = boxes.some(b => b.isFiller && b.type !== 'empty');
  const fillerLegend = hasFillers
    ? `<div class="legend-item"><span class="swatch" style="background:#5f9ea0;"></span>Filler</div>` : '';

  const boxCells = boxes.map(b => {
    const bg = binColor(b);
    const tc = textColor(bg);
    const flippedRow = gd - b.y - b.h + 1;
    const isEmpty = b.isFiller && b.type === 'empty';
    const emptyStyle = isEmpty ? 'border:1px dashed #555;' : '';
    const packLabel = b.pack ? `<span class="box-pack">${b.pack}</span>` : '';
    const style = `grid-column:${b.x+1}/span ${b.w};grid-row:${flippedRow}/span ${b.h};background:${bg};${emptyStyle}color:${tc};`;
    return `<div class="box-cell" style="${style}" title="${b.label}${b.source ? ' ('+b.source+')' : ''}">
      <span class="box-label">${b.label}</span>
      <span class="box-size">${b.w}x${b.h}</span>
      ${packLabel}
    </div>`;
  }).join('\n    ');

  const printRows = printList.map(p => {
    const items = p.items.length > 0 ? p.items.join(', ') : 'Filler';
    return `<tr><td class="mono">${p.pack}</td><td class="mono">${p.file}</td><td class="center">${p.qty}</td><td>${items}</td></tr>`;
  }).join('\n          ');

  const droppedHtml = dropped.length > 0
    ? `<h2>Dropped Items</h2><ul class="dropped">${dropped.map(d =>
        `<li>${d.label} (${d.footprint.join('x')}) — no space on grid</li>`).join('')}</ul>`
    : '';

  const totalParts = printList.reduce((s, p) => s + p.qty, 0);
  const drawerLabel = layout.drawer
    ? `${layout.drawer.width}×${layout.drawer.depth}×${layout.drawer.height}mm`
    : '';


  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gridfinity Layout — ${projectName || 'Preview'}</title>
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

    .legend { display: flex; flex-wrap: wrap; gap: 10px 20px; margin: 12px 0; }
    .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.88em; }
    .swatch { display: inline-block; width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }

    .grid-container { display: grid; gap: 3px; margin: 16px 0 24px; }
    .box-cell {
      border-radius: 5px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center;
      padding: 6px; cursor: default; overflow: hidden;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .box-cell:hover { transform: scale(1.02); box-shadow: 0 0 12px rgba(255,255,255,0.15); z-index: 10; position: relative; }
    .box-label { font-size: 0.8em; font-weight: 600; line-height: 1.3; }
    .box-size { font-size: 0.65em; opacity: 0.7; margin-top: 2px; }
    .box-pack { font-size: 0.55em; opacity: 0.5; margin-top: 1px; }

    .grid-label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; color: #666; }
    .back-label { margin-bottom: 6px; }
    .front-label { margin-top: 6px; }

    .file-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.88em; }
    .file-table th { background: #16213e; color: #a29bfe; text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a2a4e; }
    .file-table td { padding: 7px 10px; border-bottom: 1px solid #222240; }
    .file-table tr:hover td { background: #1e1e3a; }
    .file-table .center { text-align: center; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em; }

    .summary-box { background: #16213e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 14px 18px; margin: 16px 0; line-height: 1.8; }
    .dropped { margin: 8px 0 16px 20px; color: #e17055; font-size: 0.88em; }
    .dropped li { margin-bottom: 4px; }
  </style>
</head>
<body>

<h1>Gridfinity Layout</h1>
<p class="subtitle">${gw}x${gd} grid (${grid.unit}mm) &middot; max ${grid.maxHeightUnits}U${drawerLabel ? ' &middot; ' + drawerLabel : ''}</p>

<div class="legend">${legendItems}${fillerLegend}</div>

<h2>Layout</h2>
<div class="grid-label back-label">Back</div>
<div class="grid-container" style="grid-template-columns:repeat(${gw},${cellPx}px);grid-template-rows:repeat(${gd},${cellPx}px);">
    ${boxCells}
</div>
<div class="grid-label front-label">Front (you)</div>

${droppedHtml}

<h2>Print List</h2>
<table class="file-table">
  <thead><tr><th>Pack</th><th>File</th><th>Qty</th><th>Contents</th></tr></thead>
  <tbody>
          ${printRows}
  </tbody>
</table>
<div class="summary-box">
  <strong>Total:</strong> ${totalParts} parts from ${printList.length} unique STL files
</div>


</body>
</html>`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') projectName = args[++i];
  }

  if (!projectName) {
    console.error('Usage: gridfinity-render.js --project <name>');
    process.exit(1);
  }

  const layoutPath = path.join(PROJECTS_DIR, projectName, 'layout.json');
  if (!fs.existsSync(layoutPath)) {
    console.error(`Layout not found: ${layoutPath}`);
    process.exit(1);
  }

  const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const html = renderHTML(layout, projectName);

  const outPath = path.join(PROJECTS_DIR, projectName, 'preview.html');
  fs.writeFileSync(outPath, html);
  console.error(`Preview saved: projects/${projectName}/preview.html`);

  if (process.platform === 'darwin') execSync(`open "${outPath}"`);
  else if (process.platform === 'win32') execSync(`start "" "${outPath}"`);
  else execSync(`xdg-open "${outPath}"`);
}

module.exports = { renderHTML };
