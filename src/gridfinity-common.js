'use strict';

const fs = require('fs');
const path = require('path');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

const GRID_UNIT = 42;
const BASEPLATE_HEIGHT = 5;
const CLEARANCE = 3;
const HEIGHT_UNIT = 7;
const BASE_HEIGHT = 3.8;
const MAX_PRINTABLE_PLATE = 5;

function calculateGrid(drawerMm) {
  const gridW = Math.floor(drawerMm.width / GRID_UNIT);
  const gridD = Math.floor(drawerMm.depth / GRID_UNIT);
  const remainderW = Math.round(drawerMm.width - gridW * GRID_UNIT);
  const remainderD = Math.round(drawerMm.depth - gridD * GRID_UNIT);
  const maxHeightMm = drawerMm.height - BASEPLATE_HEIGHT - CLEARANCE;
  const maxHeightUnits = Math.max(1, Math.floor((maxHeightMm - BASE_HEIGHT) / HEIGHT_UNIT));

  return { width: gridW, depth: gridD, unit: GRID_UNIT, remainderW, remainderD, maxHeightMm, maxHeightUnits, drawerMm };
}

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
    const maxAvail = Math.max(...baseplatePack.bins.filter(b => b.type === 'baseplate').map(b => Math.max(b.gridW, b.gridL)));
    maxPlateSize = Math.min(maxAvail, MAX_PRINTABLE_PLATE);
  }
  maxPlateSize = maxPlateSize || 5;

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

function parseDimString(s) {
  const parts = s.replace(/mm$/i, '').split(/x/i).map(Number);
  if (parts.length === 3) return { width: parts[0], depth: parts[1], height: parts[2] };
  return null;
}

module.exports = {
  PACKS_DIR, PROJECTS_DIR,
  GRID_UNIT, BASEPLATE_HEIGHT, CLEARANCE, HEIGHT_UNIT, BASE_HEIGHT, MAX_PRINTABLE_PLATE,
  calculateGrid, tileAxis, loadBaseplatePack, findBaseplate, computeBaseplates, parseDimString,
};
