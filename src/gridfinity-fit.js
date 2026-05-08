#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  PACKS_DIR, PROJECTS_DIR,
  GRID_UNIT, HEIGHT_UNIT, BASE_HEIGHT,
  calculateGrid, computeBaseplates, parseDimString,
} = require('./gridfinity-common.js');

function loadCatalog(packIds) {
  const packs = [];
  const allBins = [];
  const purposeBuilt = [];
  const openTubs = [];
  const compartmented = [];

  const ids = packIds || fs.readdirSync(PACKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));

  for (const id of ids) {
    const p = path.join(PACKS_DIR, `${id}.json`);
    if (!fs.existsSync(p)) {
      console.error(`Pack not found: ${id}`);
      continue;
    }
    const pack = JSON.parse(fs.readFileSync(p, 'utf8'));
    packs.push(pack);
    for (const bin of pack.bins) {
      const entry = { ...bin, pack: pack.pack };
      allBins.push(entry);
      if (bin.type === 'purpose-built') purposeBuilt.push(entry);
      else if (bin.type === 'compartmented') compartmented.push(entry);
      else if (bin.type === 'open-tub') openTubs.push(entry);
    }
  }

  return { packs, allBins, purposeBuilt, openTubs, compartmented };
}

function matchItem(itemName, catalog) {
  const queryWords = itemName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  let bestMatch = null;
  let bestScore = 0;

  for (const bin of catalog.purposeBuilt) {
    if (!bin.forItem) continue;
    const target = bin.forItem.toLowerCase();
    const targetWords = target.split(/[\s,/()]+/).filter(w => w.length > 1);

    if (target === itemName.toLowerCase()) return bin;

    let matched = 0;
    for (const qw of queryWords) {
      if (targetWords.some(tw => tw === qw)) matched += 1.0;
      else if (targetWords.some(tw => tw.startsWith(qw) || qw.startsWith(tw))) matched += 0.3;
    }
    const score = queryWords.length > 0 ? matched / queryWords.length : 0;
    if (score > bestScore || (score === bestScore && bestMatch && target.length < bestMatch.forItem.length)) {
      bestScore = score;
      bestMatch = bin;
    }
  }

  return bestScore >= 0.5 ? bestMatch : null;
}

function findOpenTub(footprint, maxHeightUnits, catalog) {
  const [fw, fh] = footprint;
  const candidates = catalog.openTubs
    .filter(b => b.heightUnits <= maxHeightUnits)
    .filter(b =>
      (b.gridW >= fw && b.gridL >= fh) ||
      (b.gridW >= fh && b.gridL >= fw)
    )
    .sort((a, b) => {
      const aArea = a.gridW * a.gridL;
      const bArea = b.gridW * b.gridL;
      if (aArea !== bArea) return aArea - bArea;
      return a.heightUnits - b.heightUnits;
    });

  return candidates[0] || null;
}

function findBinById(binId, catalog) {
  return catalog.allBins.find(b => b.id === binId) || null;
}

function resolveItems(items, catalog, maxHeightUnits) {
  const resolved = [];

  for (const item of items) {
    let bin = null;
    let label = item.label || item.name;
    let footprint, heightUnits;

    if (item.bin) {
      bin = findBinById(item.bin, catalog);
      if (!bin) return { error: true, message: `Bin not found: ${item.bin}` };
    } else if (item.name) {
      bin = matchItem(item.name, catalog);
    }

    if (bin) {
      if (bin.heightUnits > maxHeightUnits) {
        return {
          error: true,
          message: `"${label}" uses ${bin.id} (${bin.heightUnits}U = ${BASE_HEIGHT + bin.heightUnits * HEIGHT_UNIT}mm) but drawer only fits ${maxHeightUnits}U`,
        };
      }
      footprint = [bin.gridW, bin.gridL];
      heightUnits = bin.heightUnits;
      if (!item.label && bin.forItem) label = bin.forItem;
    } else if (item.footprint) {
      const tub = findOpenTub(item.footprint, maxHeightUnits, catalog);
      if (tub) {
        bin = tub;
        footprint = [tub.gridW, tub.gridL];
        heightUnits = tub.heightUnits;
      } else {
        footprint = item.footprint;
        heightUnits = Math.min(3, maxHeightUnits);
        bin = null;
      }
    } else {
      footprint = [1, 1];
      heightUnits = Math.min(3, maxHeightUnits);
    }

    for (let i = 0; i < (item.qty || 1); i++) {
      resolved.push({
        _idx: resolved.length,
        footprint: [...footprint],
        label,
        bin,
        heightUnits,
        pinnedAt: item.at || null,
        source: bin ? `${bin.pack}/${bin.id}` : null,
        file: bin ? bin.file : null,
        pack: bin ? bin.pack : null,
        type: bin ? bin.type : 'open-tub',
      });
    }
  }

  return { error: false, resolved };
}

const WEIGHTS = {
  edgeAffinity: 0.30,
  compactness: 0.40,
  accessibility: 0.30,
};

function scorePosition(box, x, y, grid, occupied) {
  const { width: gw, depth: gd } = grid;
  const [bw, bh] = box.footprint;

  if (x + bw > gw || y + bh > gd) return -1;
  for (let dy = 0; dy < bh; dy++)
    for (let dx = 0; dx < bw; dx++)
      if (occupied[y + dy][x + dx] !== null) return -1;

  const yNorm = y / Math.max(gd - 1, 1);
  const xCenter = x + bw / 2;
  const gCenter = gw / 2;

  const isElongated = Math.max(bw, bh) >= 3 * Math.min(bw, bh);
  const onLeftEdge = x === 0;
  const onRightEdge = x + bw === gw;
  const edgeScore = isElongated ? ((onLeftEdge || onRightEdge) ? 1.0 : 0.2) : 0.5;

  let wallContact = 0;
  let perimeterLen = 0;
  for (let dy = 0; dy < bh; dy++) {
    perimeterLen += 2;
    if (x === 0 || occupied[y + dy][x - 1] !== null) wallContact++;
    if (x + bw === gw || occupied[y + dy][x + bw] !== null) wallContact++;
  }
  for (let dx = 0; dx < bw; dx++) {
    perimeterLen += 2;
    if (y === 0 || occupied[y - 1][x + dx] !== null) wallContact++;
    if (y + bh === gd || occupied[y + bh][x + dx] !== null) wallContact++;
  }
  const compactScore = perimeterLen > 0 ? wallContact / perimeterLen : 0;

  const accessScore = (1 - yNorm) * (1 - Math.abs(xCenter - gCenter) / Math.max(gCenter, 1));

  if (box.isFiller) return compactScore;

  return (
    WEIGHTS.edgeAffinity * edgeScore +
    WEIGHTS.compactness * compactScore +
    WEIGHTS.accessibility * accessScore
  );
}

function canPlace(x, y, w, h, gw, gd, occupied) {
  if (x + w > gw || y + h > gd) return false;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      if (occupied[y + dy][x + dx] !== null) return false;
  return true;
}

function commitPlacement(box, x, y, w, h, occupied, placed) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      occupied[y + dy][x + dx] = { label: box.label };
  placed.push({ ...box, x, y, w, h });
}

function placeBins(resolved, grid, reserved) {
  const { width: gw, depth: gd } = grid;
  const occupied = Array.from({ length: gd }, () => Array(gw).fill(null));

  if (reserved) {
    for (const zone of reserved) {
      for (let dy = 0; dy < zone.h; dy++)
        for (let dx = 0; dx < zone.w; dx++)
          if (zone.y + dy < gd && zone.x + dx < gw)
            occupied[zone.y + dy][zone.x + dx] = { label: '_reserved' };
    }
  }

  const sorted = [...resolved].sort((a, b) => {
    const aArea = a.footprint[0] * a.footprint[1];
    const bArea = b.footprint[0] * b.footprint[1];
    return bArea - aArea;
  });

  const placed = [];

  for (const box of sorted) {
    if (!box.pinnedAt) continue;
    const [px, py] = box.pinnedAt;
    const [bw, bh] = box.footprint;
    if (canPlace(px, py, bw, bh, gw, gd, occupied)) {
      commitPlacement(box, px, py, bw, bh, occupied, placed);
    } else if (bw !== bh && canPlace(px, py, bh, bw, gw, gd, occupied)) {
      box.footprint = [bh, bw];
      commitPlacement(box, px, py, bh, bw, occupied, placed);
    }
  }

  for (const box of sorted) {
    if (box.pinnedAt) continue;
    const [bw, bh] = box.footprint;
    let bestScore = -Infinity;
    let bestX = 0, bestY = 0, bestFoot = box.footprint;

    for (let y = 0; y <= gd - bh; y++) {
      for (let x = 0; x <= gw - bw; x++) {
        const score = scorePosition(box, x, y, grid, occupied);
        if (score > bestScore) {
          bestScore = score; bestX = x; bestY = y; bestFoot = [bw, bh];
        }
      }
    }

    if (bw !== bh) {
      for (let y = 0; y <= gd - bw; y++) {
        for (let x = 0; x <= gw - bh; x++) {
          const rotated = { ...box, footprint: [bh, bw] };
          const score = scorePosition(rotated, x, y, grid, occupied);
          if (score > bestScore) {
            bestScore = score; bestX = x; bestY = y; bestFoot = [bh, bw];
          }
        }
      }
    }

    if (bestScore < 0) continue;
    box.footprint = bestFoot;
    commitPlacement(box, bestX, bestY, bestFoot[0], bestFoot[1], occupied, placed);
  }

  return { placed, occupied };
}

function mergeEmptyCells(placed, grid) {
  const { width: gw, depth: gd } = grid;
  const covered = Array.from({ length: gd }, () => Array(gw).fill(false));

  for (const box of placed) {
    for (let dy = 0; dy < box.h; dy++)
      for (let dx = 0; dx < box.w; dx++)
        covered[box.y + dy][box.x + dx] = true;
  }

  const rects = [];
  for (let y = 0; y < gd; y++) {
    for (let x = 0; x < gw; x++) {
      if (covered[y][x]) continue;
      let w = 0;
      while (x + w < gw && !covered[y][x + w]) w++;
      let h = 1;
      while (y + h < gd) {
        let ok = true;
        for (let dx = 0; dx < w; dx++)
          if (covered[y + h][x + dx]) { ok = false; break; }
        if (!ok) break;
        h++;
      }
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++)
          covered[y + dy][x + dx] = true;
      rects.push({ x, y, w, h });
    }
  }
  return rects;
}

function fillWithOpenTubs(emptyRects, catalog, maxHeightUnits) {
  const fillers = [];
  for (const rect of emptyRects) {
    const tub = findOpenTub([rect.w, rect.h], maxHeightUnits, catalog);
    fillers.push({
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      label: tub ? `Open tub ${rect.w}x${rect.h}` : `Empty ${rect.w}x${rect.h}`,
      footprint: [rect.w, rect.h],
      bin: tub,
      heightUnits: tub ? tub.heightUnits : 0,
      source: tub ? `${tub.pack}/${tub.id}` : null,
      file: tub ? tub.file : null,
      pack: tub ? tub.pack : null,
      type: tub ? 'filler' : 'empty',
      isFiller: true,
      pinnedAt: null,
    });
  }
  return fillers;
}

function buildPrintList(allPlaced) {
  const fileMap = new Map();
  for (const box of allPlaced) {
    if (!box.file || box.type === 'empty') continue;
    const key = `${box.pack}/${box.file}`;
    if (!fileMap.has(key)) {
      fileMap.set(key, { pack: box.pack, file: box.file, qty: 0, items: [] });
    }
    const entry = fileMap.get(key);
    entry.qty++;
    if (!box.isFiller) entry.items.push(box.label);
  }
  return [...fileMap.values()];
}

function fitLayout(input) {
  const catalog = loadCatalog(input.packs || null);
  const grid = calculateGrid(input.drawer);

  console.error(`Grid: ${grid.width}×${grid.depth} (${grid.width * grid.depth} cells)`);
  console.error(`Max bin height: ${grid.maxHeightUnits}U (${grid.maxHeightMm.toFixed(0)}mm)`);
  console.error(`Remainder: ${grid.remainderW}mm × ${grid.remainderD}mm`);
  console.error(`Catalog: ${catalog.allBins.length} bins from ${catalog.packs.length} pack(s)\n`);

  const result = resolveItems(input.items, catalog, grid.maxHeightUnits);
  if (result.error) return result;

  const { placed, occupied } = placeBins(result.resolved, grid, input.reserved || []);
  const placedIdxs = new Set(placed.map(p => p._idx));
  const dropped = result.resolved.filter(r => !placedIdxs.has(r._idx));

  const reservedBoxes = (input.reserved || []).map(z => ({
    x: z.x, y: z.y, w: z.w, h: z.h,
    label: z.label || `Reserved ${z.w}×${z.h}`,
    type: 'reserved', isFiller: true,
  }));

  const emptyRects = mergeEmptyCells([...placed, ...reservedBoxes], grid);
  const fillers = fillWithOpenTubs(emptyRects, catalog, grid.maxHeightUnits);

  const allPlaced = [...placed, ...reservedBoxes, ...fillers];
  const printList = buildPrintList(allPlaced);
  const baseplates = computeBaseplates(grid, input.maxPlateSize || null);

  for (const p of placed) {
    if (p.isFiller) continue;
    const matchType = p.bin ? (p.type === 'purpose-built' ? 'exact' : 'tub') : 'unmatched';
    console.error(`  [${p.x},${p.y}] ${p.w}×${p.h}  ${p.label}  (${matchType}${p.source ? ' → ' + p.source : ''})`);
  }
  if (dropped.length > 0) {
    console.error(`\n  Dropped ${dropped.length} item(s):`);
    for (const d of dropped) console.error(`    ${d.label} (${d.footprint.join('x')})`);
  }

  console.error(`\n  Baseplates (max ${baseplates.maxPlateSize}×${baseplates.maxPlateSize}):`);
  for (const p of baseplates.plates) {
    console.error(`    ${p.qty}× ${p.w}×${p.d}`);
  }
  console.error(`    ${baseplates.totalPlates} baseplate(s) total`);

  return {
    error: false,
    grid: {
      width: grid.width,
      depth: grid.depth,
      unit: GRID_UNIT,
      remainderW: grid.remainderW,
      remainderD: grid.remainderD,
      maxHeightUnits: grid.maxHeightUnits,
    },
    drawer: grid.drawerMm,
    boxes: allPlaced,
    dropped,
    printList,
    baseplates,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectName = null;
  let drawerStr = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') projectName = args[++i];
    else if (args[i] === '--drawer' || args[i] === '-d') drawerStr = args[++i];
  }

  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(data);
    } catch (e) {
      console.error('Invalid JSON input:', e.message);
      process.exit(1);
    }
    if (drawerStr) input.drawer = parseDimString(drawerStr);
    if (!input.drawer) {
      console.error('Provide drawer dimensions: --drawer WxDxH (mm)');
      process.exit(1);
    }
    const d = input.drawer;
    if (!Number.isFinite(d.width) || !Number.isFinite(d.depth) || !Number.isFinite(d.height)
        || d.width <= 0 || d.depth <= 0 || d.height <= 0) {
      console.error('Drawer dimensions must be positive numbers (got %dx%dx%d)', d.width, d.depth, d.height);
      process.exit(1);
    }

    const output = fitLayout(input);
    if (output.error) {
      console.error('Error:', output.message);
      process.exit(1);
    }

    if (projectName) {
      const dir = path.join(PROJECTS_DIR, projectName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(output, null, 2) + '\n');
      console.error(`\nSaved: projects/${projectName}/layout.json`);
    }

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  });
}

module.exports = { loadCatalog, matchItem, findOpenTub, resolveItems, fitLayout };
