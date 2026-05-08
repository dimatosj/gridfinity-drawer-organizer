#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseSTL, meshBounds } = require('./stl-utils.js');

const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
const STLS_DIR = path.join(__dirname, '..', 'STLs');
const PACKS_DIR = path.join(__dirname, '..', 'packs');

const PRINTER_SETTINGS_PATH = path.join(__dirname, 'bambu-p1s-settings.json');

// ── STL resolution ────────────────────────────────────────────────────────

function resolveSTLPath(packId, filename) {
  const packManifest = path.join(PACKS_DIR, `${packId}.json`);
  if (!fs.existsSync(packManifest)) return null;

  const dirs = fs.readdirSync(STLS_DIR).filter(d => {
    const stat = fs.statSync(path.join(STLS_DIR, d));
    return stat.isDirectory();
  });

  for (const dir of dirs) {
    const candidate = path.join(STLS_DIR, dir, filename);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// ── Mesh volume ───────────────────────────────────────────────────────────

function meshVolume(mesh) {
  let vol = 0;
  for (const [i0, i1, i2] of mesh.triangles) {
    const [x0, y0, z0] = mesh.vertices[i0];
    const [x1, y1, z1] = mesh.vertices[i1];
    const [x2, y2, z2] = mesh.vertices[i2];
    vol += x0 * (y1 * z2 - y2 * z1)
         + x1 * (y2 * z0 - y0 * z2)
         + x2 * (y0 * z1 - y1 * z0);
  }
  return Math.abs(vol / 6);
}

const PLA_DENSITY = 1.24e-3;
const FILAMENT_DIAMETER = 1.75;
const FILAMENT_AREA = Math.PI * (FILAMENT_DIAMETER / 2) ** 2;
const INFILL_FACTOR = 0.70;

function filamentEstimate(volumeMm3) {
  const effective = volumeMm3 * INFILL_FACTOR;
  const grams = effective * PLA_DENSITY;
  const meters = effective / FILAMENT_AREA / 1000;
  return { grams, meters };
}

// ── Shelf bin packing ─────────────────────────────────────────────────────

const PLATE_SIZE = 256;
const PART_GAP = 5;
const PLATE_STRIDE = PLATE_SIZE * 1.2;
const BED_EXCLUDE = { x: 18, y: 28 };
const MARGIN_LEFT = BED_EXCLUDE.x + 2;
const MARGIN_FRONT = BED_EXCLUDE.y + 2;
const MARGIN_RIGHT = 5;
const MARGIN_BACK = 5;
const USABLE_W = PLATE_SIZE - MARGIN_LEFT - MARGIN_RIGHT;
const USABLE_D = PLATE_SIZE - MARGIN_FRONT - MARGIN_BACK;

function packIntoPlates(instances) {
  const sorted = instances.map((inst, i) => ({ ...inst, origIdx: i }))
    .sort((a, b) => b.depth - a.depth || b.width - a.width);
  const plates = [];

  for (const inst of sorted) {
    const w = inst.width, d = inst.depth;
    let placed = false;

    for (const plate of plates) {
      for (const shelf of plate.shelves) {
        if (shelf.curX + w <= USABLE_W && d <= shelf.height) {
          plate.placed.push({ origIdx: inst.origIdx, x: MARGIN_LEFT + shelf.curX, y: MARGIN_FRONT + shelf.y });
          shelf.curX += w + PART_GAP;
          placed = true;
          break;
        }
      }
      if (placed) break;
      if (plate.nextShelfY + d <= USABLE_D) {
        plate.shelves.push({ curX: w + PART_GAP, y: plate.nextShelfY, height: d });
        plate.placed.push({ origIdx: inst.origIdx, x: MARGIN_LEFT, y: MARGIN_FRONT + plate.nextShelfY });
        plate.nextShelfY += d + PART_GAP;
        placed = true;
      }
      if (placed) break;
    }

    if (!placed) {
      const ox = w > USABLE_W ? (PLATE_SIZE - w) / 2 : MARGIN_LEFT;
      const oy = d > USABLE_D ? (PLATE_SIZE - d) / 2 : MARGIN_FRONT;
      plates.push({
        shelves: [{ curX: w + PART_GAP, y: 0, height: d }],
        placed: [{ origIdx: inst.origIdx, x: ox, y: oy }],
        nextShelfY: d + PART_GAP,
      });
    }
  }
  return plates;
}

// ── 3MF XML builders ──────────────────────────────────────────────────────

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeUUID(seed) {
  return seed.toString(16).padStart(8, '0') + '-61cb-4c03-9d28-80fed5dfa1dc';
}

function build3MFModel(meshObjects, buildItems) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<model unit="millimeter" xml:lang="en-US"';
  xml += ' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"';
  xml += ' xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"';
  xml += ' xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
  xml += ' requiredextensions="p">\n';
  xml += ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n';
  xml += ' <metadata name="Application">BambuStudio-02.03.00.70</metadata>\n';
  xml += ' <resources>\n';

  for (const obj of meshObjects) {
    xml += `  <object id="${obj.meshId}" type="model">\n`;
    xml += '   <mesh>\n    <vertices>\n';
    for (const [x, y, z] of obj.mesh.vertices) {
      xml += `     <vertex x="${x}" y="${y}" z="${z}" />\n`;
    }
    xml += '    </vertices>\n    <triangles>\n';
    for (const [v1, v2, v3] of obj.mesh.triangles) {
      xml += `     <triangle v1="${v1}" v2="${v2}" v3="${v3}" />\n`;
    }
    xml += '    </triangles>\n   </mesh>\n  </object>\n';

    xml += `  <object id="${obj.compId}" p:UUID="${makeUUID(obj.compId)}" type="model">\n`;
    xml += '   <components>\n';
    xml += `    <component objectid="${obj.meshId}" p:UUID="${makeUUID(obj.meshId * 0x10000)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`;
    xml += '   </components>\n  </object>\n';
  }

  xml += ' </resources>\n';
  xml += ` <build p:UUID="${makeUUID(0xBB01)}">\n`;
  for (const item of buildItems) {
    xml += `  <item objectid="${item.compId}" p:UUID="${makeUUID(item.globalId)}" transform="${item.transform}" printable="1"/>\n`;
  }
  xml += ' </build>\n</model>\n';
  return xml;
}

function buildModelSettings(meshObjects, buildItems, plates) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';

  for (const obj of meshObjects) {
    xml += `  <object id="${obj.compId}">\n`;
    xml += `    <metadata key="name" value="${escapeXml(obj.name)}"/>\n`;
    xml += `    <metadata key="extruder" value="1"/>\n`;
    xml += `    <part id="${obj.meshId}" subtype="normal_part">\n`;
    xml += `      <metadata key="name" value="${escapeXml(obj.name)}"/>\n`;
    xml += `      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n`;
    xml += `      <metadata key="source_file" value="${escapeXml(obj.file)}"/>\n`;
    xml += '    </part>\n  </object>\n';
  }

  for (let p = 0; p < plates.length; p++) {
    xml += '  <plate>\n';
    xml += `    <metadata key="plater_id" value="${p + 1}"/>\n`;
    xml += '    <metadata key="plater_name" value=""/>\n';
    xml += '    <metadata key="locked" value="false"/>\n';
    for (const placed of plates[p].placed) {
      const bi = buildItems[placed.origIdx];
      xml += '    <model_instance>\n';
      xml += `      <metadata key="object_id" value="${bi.compId}"/>\n`;
      xml += `      <metadata key="instance_id" value="${bi.instanceIdx}"/>\n`;
      xml += `      <metadata key="identify_id" value="${bi.globalId}"/>\n`;
      xml += '    </model_instance>\n';
    }
    xml += '  </plate>\n';
  }

  xml += '  <assemble>\n  </assemble>\n</config>\n';
  return xml;
}

// ── ZIP writer ────────────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZIP(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localHeaders.push(Buffer.concat([local, compressed]));

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

// ── Bambu printer settings extractor ─────────────────────────────────────

const FILAMENT_ZERO_KEYS = [
  'solid_infill_filament', 'sparse_infill_filament',
  'support_filament', 'wall_filament',
];

function extractPrinterSettings() {
  if (!fs.existsSync(PRINTER_SETTINGS_PATH)) return null;
  try {
    let config = fs.readFileSync(PRINTER_SETTINGS_PATH, 'utf8');
    for (const key of FILAMENT_ZERO_KEYS) {
      config = config.replace(
        new RegExp(`"${key}"\\s*:\\s*"0"`),
        `"${key}": "1"`
      );
    }
    return Buffer.from(config, 'utf8');
  } catch {
    return null;
  }
}

// ── Export orchestrator ───────────────────────────────────────────────────

function export3MF(projectName) {
  const layoutPath = path.join(PROJECTS_DIR, projectName, 'layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const printList = layout.printList;

  const meshObjects = [];
  const missing = [];
  let nextMeshId = 1;

  const skipped = [];

  for (const entry of printList) {
    const stlPath = resolveSTLPath(entry.pack, entry.file);
    if (!stlPath) {
      missing.push(`${entry.pack}/${entry.file}`);
      continue;
    }
    const mesh = parseSTL(fs.readFileSync(stlPath));
    const bounds = meshBounds(mesh);

    const aspect = Math.max(bounds.width, bounds.depth) / Math.min(bounds.width, bounds.depth);
    const isSquareBBox = aspect < 1.15;
    const looksRotated = isSquareBBox && bounds.width > 100 && (bounds.width / 42) % 1 > 0.3;
    if (looksRotated) {
      skipped.push(entry.file);
      continue;
    }

    const volume = meshVolume(mesh);
    const meshId = nextMeshId;
    const compId = nextMeshId + 1;
    nextMeshId += 2;

    const label = entry.items.length > 0 ? entry.items[0] : entry.file;
    meshObjects.push({ meshId, compId, mesh, bounds, name: label, file: entry.file, qty: entry.qty, volume });
  }

  if (missing.length > 0) {
    process.stderr.write('Missing STL files:\n');
    missing.forEach(f => process.stderr.write('  ' + f + '\n'));
  }
  if (skipped.length > 0) {
    process.stderr.write('Skipped (rotated mesh — add manually in Bambu Studio):\n');
    skipped.forEach(f => process.stderr.write('  ' + f + '\n'));
  }

  const unresolvedBaseplates = [];
  if (layout.baseplates) {
    const bp = layout.baseplates;
    for (const p of bp.plates) {
      if (p.file && p.pack) {
        const stlPath = resolveSTLPath(p.pack, p.file);
        if (stlPath) {
          const mesh = parseSTL(fs.readFileSync(stlPath));
          const bounds = meshBounds(mesh);
          const volume = meshVolume(mesh);
          const meshId = nextMeshId;
          const compId = nextMeshId + 1;
          nextMeshId += 2;
          meshObjects.push({ meshId, compId, mesh, bounds, name: `Baseplate ${p.w}x${p.d}`, file: p.file, qty: p.qty, volume });
        } else {
          unresolvedBaseplates.push(p);
        }
      } else {
        unresolvedBaseplates.push(p);
      }
    }
  }

  const instances = [];
  const instanceCountByComp = new Map();

  for (const obj of meshObjects) {
    for (let i = 0; i < obj.qty; i++) {
      const instanceIdx = instanceCountByComp.get(obj.compId) || 0;
      instanceCountByComp.set(obj.compId, instanceIdx + 1);
      instances.push({
        compId: obj.compId,
        bounds: obj.bounds,
        width: obj.bounds.width,
        depth: obj.bounds.depth,
        instanceIdx,
        globalId: 1000 + instances.length,
        file: obj.file,
        name: obj.name,
      });
    }
  }

  const plates = packIntoPlates(instances);
  const plateCols = Math.ceil(Math.sqrt(plates.length));

  const buildItems = new Array(instances.length);
  for (let p = 0; p < plates.length; p++) {
    const plateCol = p % plateCols;
    const plateRow = Math.floor(p / plateCols);
    const plateOriginX = plateCol * PLATE_STRIDE;
    const plateOriginY = -plateRow * PLATE_STRIDE;

    for (const placed of plates[p].placed) {
      const inst = instances[placed.origIdx];
      const tx = plateOriginX + placed.x - inst.bounds.minX;
      const ty = plateOriginY + placed.y - inst.bounds.minY;
      const tz = -inst.bounds.minZ;
      buildItems[placed.origIdx] = {
        compId: inst.compId,
        instanceIdx: inst.instanceIdx,
        globalId: inst.globalId,
        transform: `1 0 0 0 1 0 0 0 1 ${tx} ${ty} ${tz}`,
      };
    }
  }

  const modelXml = build3MFModel(meshObjects, buildItems);
  const settingsXml = buildModelSettings(meshObjects, buildItems, plates);

  const zipFiles = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf8') },
    { name: '3D/3dmodel.model', data: Buffer.from(modelXml, 'utf8') },
    { name: 'Metadata/model_settings.config', data: Buffer.from(settingsXml, 'utf8') },
  ];

  const printerSettings = extractPrinterSettings();
  if (printerSettings) {
    zipFiles.push({ name: 'Metadata/project_settings.config', data: printerSettings });
    process.stderr.write('Included P1S print settings\n');
  }

  const projectDir = path.join(PROJECTS_DIR, projectName);
  const zipBuffer = createZIP(zipFiles);
  const outPath = path.join(projectDir, projectName + '.3mf');
  fs.writeFileSync(outPath, zipBuffer);

  let totalVolume = 0;
  const filamentByFile = [];
  for (const obj of meshObjects) {
    const vol = obj.volume * obj.qty;
    totalVolume += vol;
    const est = filamentEstimate(vol);
    filamentByFile.push({ file: obj.file, qty: obj.qty, grams: est.grams, meters: est.meters });
  }
  const totalEst = filamentEstimate(totalVolume);
  fs.writeFileSync(
    path.join(projectDir, 'filament.json'),
    JSON.stringify({ totalGrams: totalEst.grams, totalMeters: totalEst.meters, parts: filamentByFile }, null, 2) + '\n'
  );

  const plateAssignments = plates.map((plate, p) => ({
    plate: p + 1,
    parts: plate.placed.map(placed => {
      const inst = instances[placed.origIdx];
      return { file: inst.file, name: inst.name };
    }),
  }));
  fs.writeFileSync(
    path.join(projectDir, 'plates.json'),
    JSON.stringify(plateAssignments, null, 2) + '\n'
  );

  const totalParts = instances.length;
  process.stderr.write(`Exported ${totalParts} parts (${meshObjects.length} unique) across ${plates.length} plate(s)\n`);
  process.stderr.write(`Filament: ${totalEst.grams.toFixed(1)}g / ${totalEst.meters.toFixed(2)}m PLA\n`);
  process.stderr.write(`Saved: ${outPath}\n`);

  if (unresolvedBaseplates.length > 0) {
    process.stderr.write(`\nBaseplates needed (STLs not found — print separately):\n`);
    for (const p of unresolvedBaseplates) {
      process.stderr.write(`  ${p.qty}× ${p.w}×${p.d} baseplate\n`);
    }
  }

  return outPath;
}

module.exports = { export3MF, resolveSTLPath };

if (require.main === module) {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('Usage: gridfinity-export-3mf.js <project-name>\n');
    process.exit(1);
  }
  export3MF(name);
}
