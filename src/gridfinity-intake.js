#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { measureSTL, detectCompartments } = require('./stl-utils.js');

const DEFAULTS = {
  gridUnit: 42,
  baseHeight: 3.8,
  heightUnit: 7,
  output: path.join(__dirname, '..', 'packs'),
};

const PATTERNS = [
  { name: 'dbtw',    re: /DBTW\s+(\d+)x(\d+)x(\d+)/i,      groups: ['w','l','h'] },
  { name: 'WxLxHU', re: /(\d+)x(\d+)x(\d+)U/i,             groups: ['w','l','h'] },
  { name: 'WxLxH',  re: /(\d+)x(\d+)x(\d+)/,               groups: ['w','l','h'] },
  { name: 'WxL',    re: /(\d+)x(\d+)/,                      groups: ['w','l'] },
];

function parseFilename(filename) {
  for (const pat of PATTERNS) {
    const m = filename.match(pat.re);
    if (!m) continue;
    const result = { pattern: pat.name };
    if (pat.groups.includes('w')) result.gridW = parseInt(m[1], 10);
    if (pat.groups.includes('l')) result.gridL = parseInt(m[2], 10);
    if (pat.groups.includes('h')) result.heightUnits = parseInt(m[3], 10);
    return result;
  }
  return null;
}

function deriveGridDims(measured, gridUnit, baseHeight, heightUnit) {
  const dims = [measured.width, measured.depth].sort((a, b) => a - b);
  const gridW = Math.round(dims[0] / gridUnit);
  const gridL = Math.round(dims[1] / gridUnit);
  const heightUnits = Math.max(1, Math.round((measured.height - baseHeight) / heightUnit));
  return { gridW, gridL, heightUnits };
}

function checkMismatch(parsed, derived, filename) {
  const warnings = [];
  if (parsed.gridW && parsed.gridL) {
    const pSet = [parsed.gridW, parsed.gridL].sort((a,b) => a-b).join('x');
    const dSet = [derived.gridW, derived.gridL].sort((a,b) => a-b).join('x');
    if (pSet !== dSet)
      warnings.push(`${filename}: filename says ${parsed.gridW}x${parsed.gridL}, measured ${derived.gridW}x${derived.gridL}`);
  } else if (parsed.gridW && parsed.gridW !== derived.gridW && parsed.gridW !== derived.gridL) {
    warnings.push(`${filename}: filename says W=${parsed.gridW}, measured ${derived.gridW}x${derived.gridL}`);
  } else if (parsed.gridL && parsed.gridL !== derived.gridL && parsed.gridL !== derived.gridW) {
    warnings.push(`${filename}: filename says L=${parsed.gridL}, measured ${derived.gridW}x${derived.gridL}`);
  }
  if (parsed.heightUnits && parsed.heightUnits !== derived.heightUnits)
    warnings.push(`${filename}: filename says H=${parsed.heightUnits}U, measured H=${derived.heightUnits}U`);
  return warnings;
}

const NOISE_WORDS = /\b(gridfinity|generic|modular|blank|obj|stl|v\d+|w_logo)\b/gi;
const DIM_PATTERNS = [
  /DBTW\s*\d+x\d+x\d+/i,
  /\d+x\d+x\d+U?/gi,
  /\d+x\d+/g,
];

function classifyFromFilename(filename) {
  let name = filename.replace(/\.stl$/i, '');
  name = name.replace(/^obj_\d+_/i, '');
  for (const re of DIM_PATTERNS) name = name.replace(re, '');
  name = name.replace(NOISE_WORDS, '');
  name = name.replace(/[_\-+]+/g, ' ').replace(/\s*\(.*?\)\s*/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 2 && !/^\d+$/.test(name) && !/^\d*\s*compartment$/i.test(name)) {
    return name;
  }
  return null;
}

function loadPackMeta(dir) {
  const metaPath = path.join(dir, 'pack-meta.json');
  if (!fs.existsSync(metaPath)) return {};
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function makeBinId(packId, gridW, gridL, heightUnits) {
  return `${packId}-${gridW}x${gridL}x${heightUnits}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    dir: null,
    name: null,
    sourceUrl: null,
    packId: null,
    gridUnit: DEFAULTS.gridUnit,
    baseHeight: DEFAULTS.baseHeight,
    heightUnit: DEFAULTS.heightUnit,
    output: DEFAULTS.output,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--name':        opts.name = args[++i]; break;
      case '--source-url':  opts.sourceUrl = args[++i]; break;
      case '--pack-id':     opts.packId = args[++i]; break;
      case '--grid-unit':   opts.gridUnit = parseFloat(args[++i]); break;
      case '--base-height': opts.baseHeight = parseFloat(args[++i]); break;
      case '--height-unit': opts.heightUnit = parseFloat(args[++i]); break;
      case '--output':      opts.output = args[++i]; break;
      default:
        if (!opts.dir && !args[i].startsWith('--')) opts.dir = args[i];
        else { console.error(`Unknown option: ${args[i]}`); process.exit(1); }
    }
    i++;
  }

  if (!opts.dir) {
    console.error('Usage: gridfinity-intake <stl-directory> [options]');
    console.error('  --name "Display Name"');
    console.error('  --source-url "https://..."');
    console.error('  --pack-id "slug"');
    console.error('  --grid-unit 42');
    console.error('  --base-height 3.8');
    console.error('  --height-unit 7');
    console.error('  --output packs/');
    process.exit(1);
  }

  if (!opts.packId) {
    opts.packId = path.basename(opts.dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  if (!opts.name) opts.name = path.basename(opts.dir);

  return opts;
}

function intake(opts) {
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter(f => /\.stl$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`No STL files found in ${dir}`);
    process.exit(1);
  }

  const meta = loadPackMeta(dir);

  if (meta.name && !opts.name) opts.name = meta.name;
  if (meta.sourceUrl && !opts.sourceUrl) opts.sourceUrl = meta.sourceUrl;
  if (meta.license) opts.license = meta.license;

  console.log(`Scanning ${files.length} STL files in ${path.basename(dir)}...\n`);

  const bins = [];
  const warnings = [];
  const seenIds = new Map();
  const fileMeta = meta.bins || {};

  for (const file of files) {
    const filePath = path.join(dir, file);
    const measured = measureSTL(filePath);
    const derived = deriveGridDims(measured, opts.gridUnit, opts.baseHeight, opts.heightUnit);
    const parsed = parseFilename(file);

    let gridW, gridL, heightUnits;
    if (parsed) {
      gridW = parsed.gridW || derived.gridW;
      gridL = parsed.gridL || derived.gridL;
      heightUnits = parsed.heightUnits || derived.heightUnits;
      warnings.push(...checkMismatch(parsed, derived, file));
    } else {
      gridW = derived.gridW;
      gridL = derived.gridL;
      heightUnits = derived.heightUnits;
    }

    let id = makeBinId(opts.packId, gridW, gridL, heightUnits);
    if (seenIds.has(id)) {
      const count = seenIds.get(id) + 1;
      seenIds.set(id, count);
      id = `${id}-${count}`;
    } else {
      seenIds.set(id, 1);
    }

    const fm = fileMeta[file] || {};
    const defaultType = meta.defaultType || null;
    const isBaseplate = (fm.type === 'baseplate') || (defaultType === 'baseplate');

    let comps = [];
    let isCompartmented = false;
    if (!isBaseplate) {
      comps = detectCompartments(filePath, opts.baseHeight);
      isCompartmented = comps.length > 1;
    }

    const heuristicName = isBaseplate ? null : classifyFromFilename(file);

    let type;
    if (fm.type) type = fm.type;
    else if (defaultType) type = defaultType;
    else if (isCompartmented) type = 'compartmented';
    else if (heuristicName) type = 'purpose-built';
    else type = 'open-tub';

    if (isBaseplate) {
      heightUnits = 0;
      id = `${opts.packId}-${gridW}x${gridL}`;
    }

    const bin = {
      id,
      file,
      type,
      gridW,
      gridL,
      heightUnits,
      measured: {
        width: Math.round(measured.width * 10) / 10,
        depth: Math.round(measured.depth * 10) / 10,
        height: Math.round(measured.height * 10) / 10,
      },
    };

    if (fm.forItem) bin.forItem = fm.forItem;
    else if (heuristicName && type === 'purpose-built') bin.forItem = heuristicName;
    if (fm.category) bin.category = fm.category;
    if (fm.notes) bin.notes = fm.notes;

    if (isCompartmented) {
      bin.compartments = comps.map(c => ({
        x: c.x,
        y: c.y,
        width: c.width,
        depth: c.depth,
      }));
    }

    bins.push(bin);
  }

  bins.sort((a, b) => {
    if (a.gridW !== b.gridW) return a.gridW - b.gridW;
    if (a.gridL !== b.gridL) return a.gridL - b.gridL;
    return a.heightUnits - b.heightUnits;
  });

  const manifest = {
    pack: opts.packId,
    name: opts.name,
    version: '1.0',
    source: 'makerworld',
    sourceUrl: opts.sourceUrl || null,
    license: opts.license || 'CC-BY-NC-SA',
    gridUnit: opts.gridUnit,
    baseHeight: opts.baseHeight,
    heightUnit: opts.heightUnit,
    bins,
  };

  fs.mkdirSync(opts.output, { recursive: true });
  const outPath = path.join(opts.output, `${opts.packId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');

  printSummary(manifest, warnings, outPath);
  return manifest;
}

function printSummary(manifest, warnings, outPath) {
  const widths = { id: 4, grid: 4, height: 3, type: 4, measured: 8, file: 4 };
  for (const b of manifest.bins) {
    widths.id = Math.max(widths.id, b.id.length);
    const grid = `${b.gridW}x${b.gridL}`;
    widths.grid = Math.max(widths.grid, grid.length);
    const h = `${b.heightUnits}U`;
    widths.height = Math.max(widths.height, h.length);
    const typeStr = b.type === 'baseplate' ? 'base'
                  : b.type === 'compartmented' ? `${b.compartments.length}-comp`
                  : b.type === 'purpose-built' ? 'built' : 'tub';
    widths.type = Math.max(widths.type, typeStr.length);
    const label = b.forItem || '';
    widths.label = Math.max(widths.label || 0, label.length);
  }

  const cols = [
    ['ID', widths.id],
    ['Grid', widths.grid],
    ['H', widths.height],
    ['Type', widths.type],
    ['For', widths.label || 3],
  ];
  const header = cols.map(([n, w]) => n.padEnd(w)).join('  ');

  console.log(header);
  console.log('-'.repeat(header.length + 4));

  for (const b of manifest.bins) {
    const grid = `${b.gridW}x${b.gridL}`;
    const h = b.type === 'baseplate' ? '--' : `${b.heightUnits}U`;
    const typeStr = b.type === 'baseplate' ? 'base'
                  : b.type === 'compartmented' ? `${b.compartments.length}-comp`
                  : b.type === 'purpose-built' ? 'built' : 'tub';
    const label = b.forItem || '';
    console.log([
      b.id.padEnd(widths.id),
      grid.padEnd(widths.grid),
      h.padEnd(widths.height),
      typeStr.padEnd(widths.type),
      label,
    ].join('  '));
  }

  console.log(`\n${manifest.bins.length} bins → ${outPath}`);

  if (warnings.length > 0) {
    console.log(`\n⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ${w}`);
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  intake(opts);
}

module.exports = { intake, parseFilename, deriveGridDims };
