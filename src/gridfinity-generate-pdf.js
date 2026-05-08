#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

function pdfString(s) {
  return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
}

function buildPDF(pages) {
  const objects = [];
  let nextId = 1;

  function addObj(content) {
    const id = nextId++;
    objects.push({ id, content });
    return id;
  }

  const catalogId = addObj(null);
  const pagesId = addObj(null);

  const fontId = addObj(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  );
  const fontBoldId = addObj(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  );

  const pageIds = [];
  for (const page of pages) {
    const streamContent = page.stream;
    const streamBytes = Buffer.from(streamContent, 'latin1');
    const streamId = addObj(
      `<< /Length ${streamBytes.length} >>\nstream\n${streamContent}\nendstream`
    );

    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792]` +
      ` /Contents ${streamId} 0 R` +
      ` /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> >>`+
      ` >>`
    );
    pageIds.push(pageId);
  }

  objects[0].content =
    `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[1].content =
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${obj.id} 0 obj\n${obj.content}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += off.toString().padStart(10, '0') + ' 00000 n \n';
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function drawCheckbox(x, y) {
  return `q 0.4 w ${x} ${y} 10 10 re S Q\n`;
}

function drawText(x, y, size, font, text) {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET\n`;
}

function drawLine(x1, y1, x2, y2) {
  return `q 0.3 w 0.7 0.7 0.7 RG ${x1} ${y1} m ${x2} ${y2} l S Q\n`;
}

function generateChecklist(projectName) {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  const layout = JSON.parse(fs.readFileSync(path.join(projectDir, 'layout.json'), 'utf8'));
  const plateData = fs.existsSync(path.join(projectDir, 'plates.json'))
    ? JSON.parse(fs.readFileSync(path.join(projectDir, 'plates.json'), 'utf8'))
    : null;

  const itemNotes = new Map();
  for (const entry of layout.printList) {
    if (entry.items.length > 0) {
      itemNotes.set(entry.file, entry.items.join(', '));
    }
  }

  const pages = [];
  const margin = 50;
  const pageH = 792;
  const pageW = 612;
  const lineHeight = 18;
  let stream = '';
  let y = pageH - margin;

  const grid = layout.grid;
  const drawer = layout.drawer;

  stream += drawText(margin, y, 16, 'F2', `Gridfinity Print Checklist: ${projectName}`);
  y -= 22;
  stream += drawText(margin, y, 10, 'F1',
    `${grid.width}x${grid.depth} grid (${grid.unit}mm)`
    + (drawer ? ` | ${drawer.width}x${drawer.depth}x${drawer.height}mm drawer` : '')
  );
  y -= 10;
  stream += drawLine(margin, y, pageW - margin, y);
  y -= 20;

  let totalPrints = 0;

  if (plateData) {
    for (const plate of plateData) {
      if (y < margin + 50) {
        pages.push({ stream });
        stream = '';
        y = pageH - margin;
      }

      if (y < pageH - margin - 10) y -= 8;
      stream += drawText(margin, y, 12, 'F2', `Plate ${plate.plate}`);
      y -= 6;
      stream += drawLine(margin, y, pageW - margin, y);
      y -= lineHeight;

      const partCounts = new Map();
      for (const part of plate.parts) {
        partCounts.set(part.file, (partCounts.get(part.file) || 0) + 1);
      }

      for (const [file, qty] of partCounts) {
        if (y < margin + 30) {
          pages.push({ stream });
          stream = '';
          y = pageH - margin;
        }

        stream += drawCheckbox(margin, y - 2);
        const qtyStr = qty > 1 ? `${qty}x  ` : '1x  ';
        stream += drawText(margin + 16, y, 9, 'F2', qtyStr);
        stream += drawText(margin + 36, y, 9, 'F1', file);
        const note = itemNotes.get(file);
        if (note) {
          stream += drawText(margin + 36, y - 11, 8, 'F1', note);
          y -= 10;
        }
        y -= lineHeight;
        totalPrints += qty;
      }
    }
  } else {
    for (const entry of layout.printList) {
      if (y < margin + 30) {
        pages.push({ stream });
        stream = '';
        y = pageH - margin;
      }

      stream += drawCheckbox(margin, y - 2);
      const qtyStr = entry.qty > 1 ? `${entry.qty}x  ` : '1x  ';
      stream += drawText(margin + 16, y, 9, 'F2', qtyStr);
      stream += drawText(margin + 36, y, 9, 'F1', `${entry.pack}/${entry.file}`);
      if (entry.items.length > 0) {
        stream += drawText(margin + 36, y - 11, 8, 'F1', entry.items.join(', '));
        y -= 10;
      }
      y -= lineHeight;
      totalPrints += entry.qty;
    }
  }

  if (layout.baseplates) {
    y -= 8;
    stream += drawText(margin, y, 12, 'F2', 'Baseplates');
    y -= 6;
    stream += drawLine(margin, y, pageW - margin, y);
    y -= lineHeight;

    for (const plate of layout.baseplates.plates) {
      if (y < margin + 30) {
        pages.push({ stream });
        stream = '';
        y = pageH - margin;
      }

      stream += drawCheckbox(margin, y - 2);
      const qtyStr = plate.qty > 1 ? `${plate.qty}x  ` : '1x  ';
      stream += drawText(margin + 16, y, 9, 'F2', qtyStr);
      stream += drawText(margin + 36, y, 9, 'F1', plate.file || `${plate.w}x${plate.d} baseplate`);
      y -= lineHeight;
      totalPrints += plate.qty;
    }
  }

  const filamentPath = path.join(projectDir, 'filament.json');
  const filamentData = fs.existsSync(filamentPath)
    ? JSON.parse(fs.readFileSync(filamentPath, 'utf8'))
    : null;

  y -= 10;
  stream += drawLine(margin, y, pageW - margin, y);
  y -= 18;
  stream += drawText(margin, y, 10, 'F2',
    `Total: ${totalPrints} prints across ${plateData ? plateData.length : '?'} plates`
  );

  if (filamentData) {
    y -= 16;
    stream += drawText(margin, y, 10, 'F2',
      `Filament: ~${filamentData.totalGrams.toFixed(1)}g / ${filamentData.totalMeters.toFixed(2)}m PLA`
    );
  }

  pages.push({ stream });

  return buildPDF(pages);
}

if (require.main === module) {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('Usage: node gridfinity-generate-pdf.js <project-name>\n');
    process.exit(1);
  }

  const pdf = generateChecklist(name);
  const outPath = path.join(PROJECTS_DIR, name, name + '-checklist.pdf');
  fs.writeFileSync(outPath, pdf);
  process.stdout.write(outPath + '\n');
  process.stderr.write(`Checklist saved: ${path.basename(outPath)}\n`);

  try {
    if (process.platform === 'darwin') require('child_process').execSync(`open "${outPath}"`);
    else if (process.platform === 'win32') require('child_process').execSync(`start "" "${outPath}"`);
    else require('child_process').execSync(`xdg-open "${outPath}"`);
  } catch {}
}

module.exports = { generateChecklist };
