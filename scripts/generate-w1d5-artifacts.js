#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_FILE = 'evidence/samples/synthetic/measurement-synthetic-005-full-featured.json';
const SOURCE_PATH = path.join(ROOT, SOURCE_FILE);
const SCENE_FILE = 'contracts/3d/empty-room-scene.json';
const ANNOTATION_FILE = 'contracts/annotation/measurement-synthetic-005-annotation.json';
const REPORT_FILE = 'reports/w1d5-empty-room-report.md';
const DESKTOP_SVG_FILE = 'reports/screenshots/w1d5-empty-room-desktop.svg';
const MOBILE_SVG_FILE = 'reports/screenshots/w1d5-empty-room-mobile.svg';
const DESKTOP_PNG_FILE = 'reports/screenshots/w1d5-empty-room-desktop.png';
const MOBILE_PNG_FILE = 'reports/screenshots/w1d5-empty-room-mobile.png';
const ROLLUP_FILE = 'evidence/registry/week1-rollup.json';
const EVIDENCE_REGISTRY_FILE = 'evidence/registry/evidence-registry.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(relativePath, value) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(relativePath, value) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function segmentLength(start, end) {
  return Math.round(Math.hypot(end.x - start.x, end.y - start.y));
}

function polygonArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(Math.round(sum / 2));
}

function makeTrace(id, sourcePath, evidenceId, status, extra = {}) {
  return {
    id,
    source: sourcePath,
    evidenceId,
    status,
    ...extra,
  };
}

function wallNormal(wall) {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function buildScene(measurement) {
  const heights = measurement.heights;
  const netHeight = heights.netHeight ?? heights.roomHeight;
  const doorOpeningHeight = heights.doorOpeningHeight ?? null;
  const areaMm2 = polygonArea(measurement.boundary);

  const primitives = [
    {
      ...makeTrace('scene-floor-001', `${SOURCE_FILE}#/boundary`, 'EV-009', 'unverified'),
      type: 'floor',
      polygon: measurement.boundary,
      z: heights.groundElevation,
      areaMm2,
      material: 'mat-floor-provisional',
    },
    {
      ...makeTrace('scene-ceiling-net-001', `${SOURCE_FILE}#/heights/netHeight`, 'EV-009', heights.netHeight == null ? 'provisional' : 'unverified'),
      type: 'ceilingPlane',
      polygon: measurement.boundary,
      z: heights.groundElevation + netHeight,
      sourceFallback: heights.netHeight == null ? 'heights.roomHeight' : null,
      material: 'mat-ceiling-provisional',
    },
    ...measurement.walls.map((wall, index) => ({
      ...makeTrace(`scene-wall-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/walls/${index}`, 'EV-009', 'unverified'),
      type: 'wall',
      wallIndex: index,
      start: { x: wall.startPoint.x, y: wall.startPoint.y, z: heights.groundElevation },
      end: { x: wall.endPoint.x, y: wall.endPoint.y, z: heights.groundElevation },
      height: heights.wallHeight,
      thickness: wall.thickness,
      wallType: wall.type || 'partition',
      normal: wallNormal(wall),
      material: 'mat-wall-provisional',
    })),
    ...(measurement.openings || []).map((opening, index) => ({
      ...makeTrace(`scene-opening-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/openings/${index}`, 'EV-009', 'unverified'),
      type: 'opening',
      openingId: opening.openingId,
      openingType: opening.type,
      wallIndex: opening.wallIndex,
      center: { x: opening.position.x, y: opening.position.y, z: heights.groundElevation },
      width: opening.width,
      height: opening.height,
      sillHeight: opening.sillHeight || 0,
      doorOpeningHeight: opening.type === 'door' ? (doorOpeningHeight || opening.height) : null,
      sourceFallback: opening.type === 'door' && doorOpeningHeight == null ? 'opening.height' : null,
      material: 'mat-opening-provisional',
    })),
    ...(measurement.drainagePoints || []).map((drain, index) => ({
      ...makeTrace(`scene-drain-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/drainagePoints/${index}`, 'EV-009', 'provisional'),
      type: 'floorMarker',
      markerType: drain.type,
      center: { x: drain.position.x, y: drain.position.y, z: heights.groundElevation },
      diameter: drain.diameter || null,
      material: 'mat-marker-provisional',
    })),
    ...(measurement.pipeEnclosures || []).map((enclosure, index) => ({
      ...makeTrace(`scene-pipe-enclosure-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/pipeEnclosures/${index}`, 'EV-009', 'provisional'),
      type: 'pipeEnclosure',
      polygon: enclosure.boundary,
      height: heights.wallHeight,
      isAccessible: enclosure.isAccessible,
      containsDrain: enclosure.containsDrain,
      material: 'mat-wall-provisional',
    })),
  ];

  return {
    sceneVersion: '1.0.0',
    roomId: measurement.roomId,
    generatedFrom: SOURCE_FILE,
    units: 'mm',
    coordinateSystem: {
      x: 'horizontal right',
      y: 'depth inward',
      z: 'height upward',
      source: 'contracts/COORDINATE-SYSTEM.md',
      evidenceId: 'EV-009',
      status: 'unverified',
    },
    dimensions: {
      ...makeTrace('scene-dimensions-001', `${SOURCE_FILE}#/heights`, 'EV-009', 'unverified'),
      roomHeight: heights.roomHeight,
      wallHeight: heights.wallHeight,
      groundElevation: heights.groundElevation,
      netHeight,
      netHeightStatus: heights.netHeight == null ? 'provisional' : 'unverified',
      doorOpeningHeight,
      doorOpeningHeightStatus: doorOpeningHeight == null ? 'provisional' : 'unverified',
      areaMm2,
    },
    materials: [
      makeTrace('mat-floor-provisional', 'W1D5 generated neutral material', 'EV-009', 'provisional', { color: '#d8d1c5' }),
      makeTrace('mat-wall-provisional', 'W1D5 generated neutral material', 'EV-009', 'provisional', { color: '#c8d2d7' }),
      makeTrace('mat-ceiling-provisional', 'W1D5 generated neutral material', 'EV-009', 'provisional', { color: '#eef0ed' }),
      makeTrace('mat-opening-provisional', 'W1D5 generated neutral material', 'EV-009', 'provisional', { color: '#5f7790' }),
      makeTrace('mat-marker-provisional', 'W1D5 generated neutral material', 'EV-009', 'provisional', { color: '#b05b46' }),
    ],
    primitives,
    thresholds: {
      evidenceId: 'EV-009',
      status: 'unverified',
      refs: ['THR-3D-001', 'THR-3D-002', 'THR-3D-003', 'THR-3D-004', 'THR-3D-005', 'THR-3D-006', 'THR-3D-007'],
    },
  };
}

function buildAnnotation(measurement, scene) {
  const annotations = [
    {
      ...makeTrace('ann-room-area-001', `${SOURCE_FILE}#/boundary`, 'EV-010', 'unverified'),
      type: 'dimension',
      label: 'room area',
      value: scene.dimensions.areaMm2,
      unit: 'mm^2',
      targetPrimitiveId: 'scene-floor-001',
    },
    {
      ...makeTrace('ann-room-height-001', `${SOURCE_FILE}#/heights/roomHeight`, 'EV-010', 'unverified'),
      type: 'height',
      label: 'roomHeight',
      value: measurement.heights.roomHeight,
      unit: 'mm',
      targetPrimitiveId: 'scene-dimensions-001',
    },
    {
      ...makeTrace('ann-wall-height-001', `${SOURCE_FILE}#/heights/wallHeight`, 'EV-010', 'unverified'),
      type: 'height',
      label: 'wallHeight',
      value: measurement.heights.wallHeight,
      unit: 'mm',
      targetPrimitiveId: 'scene-dimensions-001',
    },
    ...measurement.walls.map((wall, index) => ({
      ...makeTrace(`ann-wall-length-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/walls/${index}`, 'EV-010', 'unverified'),
      type: 'dimension',
      label: `wall ${index + 1} length`,
      value: segmentLength(wall.startPoint, wall.endPoint),
      unit: 'mm',
      targetPrimitiveId: `scene-wall-${String(index + 1).padStart(3, '0')}`,
    })),
    ...(measurement.openings || []).map((opening, index) => ({
      ...makeTrace(`ann-opening-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/openings/${index}`, 'EV-010', 'unverified'),
      type: 'openingLabel',
      label: `${opening.type} ${opening.width}x${opening.height}`,
      value: { width: opening.width, height: opening.height },
      unit: 'mm',
      targetPrimitiveId: `scene-opening-${String(index + 1).padStart(3, '0')}`,
    })),
    ...(measurement.drainagePoints || []).map((drain, index) => ({
      ...makeTrace(`ann-drain-${String(index + 1).padStart(3, '0')}`, `${SOURCE_FILE}#/drainagePoints/${index}`, 'EV-010', 'provisional'),
      type: 'entityLabel',
      label: drain.type,
      targetPrimitiveId: `scene-drain-${String(index + 1).padStart(3, '0')}`,
    })),
  ];

  return {
    annotationVersion: '1.0.0',
    roomId: measurement.roomId,
    generatedFrom: SOURCE_FILE,
    sceneRef: SCENE_FILE,
    units: 'mm',
    evidenceId: 'EV-010',
    status: 'unverified',
    vocabularyStatus: 'pending_business_confirmation',
    confidencePolicy: {
      thresholdRefs: ['THR-ANN-003', 'THR-ANN-006'],
      status: 'unverified',
      note: 'No confirmed confidence or customer-facing vocabulary threshold is available in W1.',
    },
    annotations,
  };
}

function svgFor(scene, width, height, label) {
  const points = scene.primitives.find(item => item.type === 'floor').polygon;
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const margin = width < 700 ? 42 : 84;
  const scale = Math.min((width - margin * 2) / (maxX - minX), (height - margin * 2) / (maxY - minY));
  const project = point => ({
    x: margin + (point.x - minX) * scale,
    y: height - margin - (point.y - minY) * scale,
  });
  const polygon = points.map(point => {
    const projected = project(point);
    return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
  }).join(' ');
  const openingRects = scene.primitives.filter(item => item.type === 'opening').map(item => {
    const center = project(item.center);
    const rectWidth = Math.max(22, item.width * scale);
    const rectHeight = item.openingType === 'window' ? 12 : 18;
    return `<rect x="${(center.x - rectWidth / 2).toFixed(1)}" y="${(center.y - rectHeight / 2).toFixed(1)}" width="${rectWidth.toFixed(1)}" height="${rectHeight}" fill="#5f7790"><title>${item.id} ${item.status}</title></rect>`;
  }).join('\n    ');
  const drainMarkers = scene.primitives.filter(item => item.type === 'floorMarker').map(item => {
    const center = project(item.center);
    return `<circle cx="${center.x.toFixed(1)}" cy="${center.y.toFixed(1)}" r="8" fill="#b05b46"><title>${item.id} ${item.status}</title></circle>`;
  }).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
  <rect width="100%" height="100%" fill="#f7f5ef"/>
  <text x="${margin}" y="${margin - 26}" fill="#273238" font-family="Arial, sans-serif" font-size="${width < 700 ? 18 : 26}" font-weight="700">${label}</text>
  <text x="${margin}" y="${margin - 4}" fill="#5f676b" font-family="Arial, sans-serif" font-size="${width < 700 ? 11 : 14}">EV-009/EV-010 · status: unverified/provisional · source: ${SOURCE_FILE}</text>
  <polygon points="${polygon}" fill="#d8d1c5" stroke="#273238" stroke-width="3"/>
  ${openingRects}
  ${drainMarkers}
  <text x="${margin}" y="${height - 24}" fill="#5f676b" font-family="Arial, sans-serif" font-size="${width < 700 ? 11 : 14}">roomHeight ${scene.dimensions.roomHeight}mm · wallHeight ${scene.dimensions.wallHeight}mm · groundElevation ${scene.dimensions.groundElevation}mm</text>
</svg>
`;
}

function buildReport(scene, annotation) {
  return `# W1D5 Empty-Room 3D and Annotation Report

Status: unverified. Business thresholds and customer-facing vocabulary remain pending_business_confirmation.

## Inputs

- Measurement: \`${SOURCE_FILE}\`
- Evidence: \`EV-009\`, \`EV-010\`, \`EV-011\`

## Outputs

- Scene JSON: \`${SCENE_FILE}\`
- Annotation JSON: \`${ANNOTATION_FILE}\`
- Three.js viewer: \`viewer/w1d5-empty-room-viewer.html\`
- Desktop screenshot artifact: \`${DESKTOP_SVG_FILE}\`
- Mobile screenshot artifact: \`${MOBILE_SVG_FILE}\`
- Desktop browser screenshot: \`${DESKTOP_PNG_FILE}\`
- Mobile browser screenshot: \`${MOBILE_PNG_FILE}\`

## Height Fields

| field | value | status |
|---|---:|---|
| roomHeight | ${scene.dimensions.roomHeight} mm | unverified |
| wallHeight | ${scene.dimensions.wallHeight} mm | unverified |
| groundElevation | ${scene.dimensions.groundElevation} mm | unverified |
| netHeight | ${scene.dimensions.netHeight} mm | ${scene.dimensions.netHeightStatus} |
| doorOpeningHeight | ${scene.dimensions.doorOpeningHeight ?? 'opening.height fallback'} | ${scene.dimensions.doorOpeningHeightStatus} |

## Traceability

- Scene primitives: ${scene.primitives.length}; every primitive carries \`id\`, \`source\`, \`evidenceId\`, and \`status\`.
- Annotation rows: ${annotation.annotations.length}; every annotation carries \`id\`, \`source\`, \`evidenceId\`, and \`status\`.
- Only the allowed height fields are emitted: \`roomHeight\`, \`wallHeight\`, \`groundElevation\`, \`netHeight\`, and \`doorOpeningHeight\`.

## Interaction Contract

The viewer uses Three.js OrbitControls for rotate, pan, and zoom. It consumes the generated scene JSON and does not modify base geometry between schemes.
`;
}

function buildRollup() {
  const registry = readJson(path.join(ROOT, EVIDENCE_REGISTRY_FILE));
  return {
    schemaVersion: '1.0.0',
    generatedFrom: EVIDENCE_REGISTRY_FILE,
    evidenceId: 'EV-011',
    status: 'unverified',
    rows: registry.rows.map(row => ({
      evidenceId: row.evidenceId,
      lockedItem: row.lockedItem,
      day: row.day,
      owner: row.owner,
      status: row.status,
      expectedArtifact: row.expectedArtifact,
      openConfirmation: /pending_business_confirmation|pending_review|pending_implementation|unverified/.test(`${row.status} ${row.notes || ''}`),
      notes: row.notes || '',
    })),
  };
}

function main() {
  const measurement = readJson(SOURCE_PATH);
  const scene = buildScene(measurement);
  const annotation = buildAnnotation(measurement, scene);

  writeJson(SCENE_FILE, scene);
  writeJson(ANNOTATION_FILE, annotation);
  writeText(DESKTOP_SVG_FILE, svgFor(scene, 1440, 900, 'W1D5 desktop 3D review artifact'));
  writeText(MOBILE_SVG_FILE, svgFor(scene, 390, 844, 'W1D5 mobile 3D review artifact'));
  writeText(REPORT_FILE, buildReport(scene, annotation));
  writeJson(ROLLUP_FILE, buildRollup());
  console.log(`Generated ${SCENE_FILE}, ${ANNOTATION_FILE}, report, and screenshot artifacts.`);
}

main();
