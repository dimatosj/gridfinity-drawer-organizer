'use strict';

const fs = require('fs');

function parseSTL(buffer) {
  const triCount = buffer.readUInt32LE(80);
  const vertices = [];
  const vertexMap = new Map();
  const triangles = [];

  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    offset += 12;
    const vIndices = [];
    for (let v = 0; v < 3; v++) {
      const x = buffer.readFloatLE(offset); offset += 4;
      const y = buffer.readFloatLE(offset); offset += 4;
      const z = buffer.readFloatLE(offset); offset += 4;
      const key = x.toFixed(6) + ',' + y.toFixed(6) + ',' + z.toFixed(6);
      if (!vertexMap.has(key)) {
        vertexMap.set(key, vertices.length);
        vertices.push([x, y, z]);
      }
      vIndices.push(vertexMap.get(key));
    }
    triangles.push(vIndices);
    offset += 2;
  }

  return { vertices, triangles };
}

function meshBounds(mesh) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of mesh.vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ,
           width: maxX - minX, depth: maxY - minY, height: maxZ - minZ };
}

function measureSTL(filePath) {
  const buf = fs.readFileSync(filePath);
  const mesh = parseSTL(buf);
  return meshBounds(mesh);
}

function pointInTriangleZ(a, b, c, px, py) {
  const v0x = c[0] - a[0], v0y = c[1] - a[1];
  const v1x = b[0] - a[0], v1y = b[1] - a[1];
  const v2x = px - a[0], v2y = py - a[1];

  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d02 = v0x * v2x + v0y * v2y;
  const d11 = v1x * v1x + v1y * v1y;
  const d12 = v1x * v2x + v1y * v2y;

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) return null;

  const inv = 1 / denom;
  const u = (d11 * d02 - d01 * d12) * inv;
  const v = (d00 * d12 - d01 * d02) * inv;

  if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) return null;
  return a[2] + u * (c[2] - a[2]) + v * (b[2] - a[2]);
}

function buildHeightField(mesh, bounds, resolution) {
  const nx = Math.ceil(bounds.width / resolution) + 1;
  const ny = Math.ceil(bounds.depth / resolution) + 1;
  const hf = Array.from({ length: ny }, () => new Float32Array(nx).fill(-Infinity));

  for (const [i0, i1, i2] of mesh.triangles) {
    const a = mesh.vertices[i0];
    const b = mesh.vertices[i1];
    const c = mesh.vertices[i2];

    const minTx = Math.min(a[0], b[0], c[0]);
    const maxTx = Math.max(a[0], b[0], c[0]);
    const minTy = Math.min(a[1], b[1], c[1]);
    const maxTy = Math.max(a[1], b[1], c[1]);

    const gxMin = Math.max(0, Math.floor((minTx - bounds.minX) / resolution));
    const gxMax = Math.min(nx - 1, Math.ceil((maxTx - bounds.minX) / resolution));
    const gyMin = Math.max(0, Math.floor((minTy - bounds.minY) / resolution));
    const gyMax = Math.min(ny - 1, Math.ceil((maxTy - bounds.minY) / resolution));

    for (let gy = gyMin; gy <= gyMax; gy++) {
      for (let gx = gxMin; gx <= gxMax; gx++) {
        const px = bounds.minX + gx * resolution;
        const py = bounds.minY + gy * resolution;
        const z = pointInTriangleZ(a, b, c, px, py);
        if (z !== null && z > hf[gy][gx]) {
          hf[gy][gx] = z;
        }
      }
    }
  }

  return { field: hf, nx, ny };
}

function detectCompartments(filePath, baseHeight) {
  const buf = fs.readFileSync(filePath);
  const mesh = parseSTL(buf);
  const bounds = meshBounds(mesh);
  const resolution = 1;
  const { field: hf, nx, ny } = buildHeightField(mesh, bounds, resolution);

  const floorZ = bounds.minZ + baseHeight;
  const rimZ = bounds.maxZ;
  const threshold = (floorZ + rimZ) / 2;

  const visited = Array.from({ length: ny }, () => new Uint8Array(nx));
  const compartments = [];

  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      if (visited[gy][gx]) continue;
      const z = hf[gy][gx];
      if (z === -Infinity || z >= threshold) {
        visited[gy][gx] = 1;
        continue;
      }

      const queue = [[gx, gy]];
      visited[gy][gx] = 1;
      let minGx = gx, maxGx = gx, minGy = gy, maxGy = gy;
      let area = 0;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift();
        area++;
        if (cx < minGx) minGx = cx;
        if (cx > maxGx) maxGx = cx;
        if (cy < minGy) minGy = cy;
        if (cy > maxGy) maxGy = cy;

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx2 = cx + dx, ny2 = cy + dy;
          if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny) continue;
          if (visited[ny2][nx2]) continue;
          visited[ny2][nx2] = 1;
          const z2 = hf[ny2][nx2];
          if (z2 === -Infinity || z2 >= threshold) continue;
          queue.push([nx2, ny2]);
        }
      }

      const x = (minGx * resolution);
      const y = (minGy * resolution);
      const w = (maxGx - minGx + 1) * resolution;
      const d = (maxGy - minGy + 1) * resolution;

      compartments.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        width: Math.round(w * 10) / 10,
        depth: Math.round(d * 10) / 10,
        areaMm2: area * resolution * resolution,
      });
    }
  }

  return compartments.filter(c => c.areaMm2 >= 100).sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}

module.exports = { parseSTL, meshBounds, measureSTL, detectCompartments };
