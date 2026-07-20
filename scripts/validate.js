#!/usr/bin/env node

/**
 * Schema Contract Validator
 *
 * Validates:
 * 1. All schema files are valid JSON and valid JSON Schema (draft-07)
 * 2. All valid example files pass schema validation
 * 3. All invalid example files correctly fail schema validation
 *
 * Exit codes:
 *   0 — All validations passed
 *   1 — One or more schema or positive validations failed
 *   2 — Usage error (missing files, invalid arguments)
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas');
const EVIDENCE_SCHEMA_DIR = path.join(__dirname, '..', 'evidence', 'schema');
const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const VALID_DIR = path.join(EXAMPLES_DIR, 'valid');
const INVALID_DIR = path.join(EXAMPLES_DIR, 'invalid');
const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence');
const EVIDENCE_REGISTRY_DIR = path.join(EVIDENCE_DIR, 'registry');
const SYNTHETIC_DIR = path.join(EVIDENCE_DIR, 'samples', 'synthetic');
const GOLDEN_DIR = path.join(EVIDENCE_DIR, 'samples', 'golden');
const SYNTHETIC_PRODUCT_DIR = path.join(EVIDENCE_DIR, 'samples', 'products');
const SYNTHETIC_PLACEMENT_DIR = path.join(EVIDENCE_DIR, 'samples', 'placements');
const EVIDENCE_INVALID_DIR = path.join(EVIDENCE_DIR, 'invalid');
const THRESHOLD_REGISTRY_PATH = path.join(EVIDENCE_REGISTRY_DIR, 'threshold-registry.json');
const DEFAULT_COORDINATE_TOLERANCE_MM = 1;
const DEFAULT_GOLDEN_PERIMETER_TOLERANCE_MM = 0.01;
const DEFAULT_GOLDEN_AREA_TOLERANCE_MM2 = 0.01;
const DEFAULT_NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM = 20;

let COORDINATE_TOLERANCE_MM = DEFAULT_COORDINATE_TOLERANCE_MM;
let GOLDEN_PERIMETER_TOLERANCE_MM = DEFAULT_GOLDEN_PERIMETER_TOLERANCE_MM;
let GOLDEN_AREA_TOLERANCE_MM2 = DEFAULT_GOLDEN_AREA_TOLERANCE_MM2;
let NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM = DEFAULT_NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM;

// Schema to example mapping (prefix match)
const SCHEMA_EXAMPLE_MAP = {
  'measurement.schema.json': 'measurement',
  'product.schema.json': 'product',
  'rule.schema.json': 'rule',
  'fixture-placement.schema.json': 'fixture-placement',
};

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

function log(level, msg) {
  const prefix = level === 'PASS' ? '\x1b[32mPASS\x1b[0m'
    : level === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
    : level === 'INFO' ? '\x1b[36mINFO\x1b[0m'
    : level;
  console.log(`  [${prefix}] ${msg}`);
}

function loadJSON(filepath) {
  try {
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { _error: `Cannot parse JSON: ${e.message}` };
  }
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadThresholdConfig() {
  const registry = loadJSON(THRESHOLD_REGISTRY_PATH);
  if (registry._error || !Array.isArray(registry.rows)) return;

  const byId = new Map(registry.rows.map(row => [row.thresholdId, row]));
  const numericThreshold = (thresholdId, expectedUnit) => {
    const row = byId.get(thresholdId);
    if (!row || typeof row.value !== 'number' || row.unit !== expectedUnit) return null;
    if (!['confirmed', 'provisional_implementation'].includes(row.status)) return null;
    return row.value;
  };

  COORDINATE_TOLERANCE_MM = numericThreshold('THR-GEOM-001', 'mm') ?? DEFAULT_COORDINATE_TOLERANCE_MM;
  GOLDEN_PERIMETER_TOLERANCE_MM = numericThreshold('THR-IMPL-001', 'mm') ?? DEFAULT_GOLDEN_PERIMETER_TOLERANCE_MM;
  NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM = numericThreshold('THR-IMPL-002', 'mm') ?? DEFAULT_NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM;
  GOLDEN_AREA_TOLERANCE_MM2 = numericThreshold('THR-IMPL-003', 'mm^2') ?? DEFAULT_GOLDEN_AREA_TOLERANCE_MM2;
}

loadThresholdConfig();

function getExampleFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(dir, f));
}

function formatErrors(errors) {
  return (errors || []).map(e => `${e.instancePath || '/'}: ${e.message}`).join('; ');
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonPerimeter(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function countOpenings(measurement, type) {
  return (measurement.openings || []).filter(o => o.type === type).length;
}

function samePoint(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projected = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
  return Math.hypot(point.x - projected.x, point.y - projected.y);
}

function segmentLength(start, end) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function pointOnSegment(point, start, end, toleranceMm = COORDINATE_TOLERANCE_MM) {
  if (distancePointToSegment(point, start, end) > toleranceMm) return false;
  const minX = Math.min(start.x, end.x) - toleranceMm;
  const maxX = Math.max(start.x, end.x) + toleranceMm;
  const minY = Math.min(start.y, end.y) - toleranceMm;
  const maxY = Math.max(start.y, end.y) + toleranceMm;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

function pointInPolygon(point, polygon) {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (pointOnSegment(point, a, b)) return true;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function rotatePoint(point, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function toAbsoluteFootprintPoint(placement, relativePoint) {
  const rotated = rotatePoint(relativePoint, placement.orientation?.rotationZ || 0);
  return {
    x: placement.position.x + rotated.x,
    y: placement.position.y + rotated.y,
  };
}

function rectangularFootprintVertices(placement) {
  const halfWidth = placement.footprint.width / 2;
  const halfDepth = placement.footprint.depth / 2;
  return [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map(point => toAbsoluteFootprintPoint(placement, point));
}

function circularFootprintVertices(placement) {
  const radius = placement.footprint.width / 2;
  const segmentCount = 16;
  return Array.from({ length: segmentCount }, (_, index) => {
    const radians = (index / segmentCount) * Math.PI * 2;
    return {
      x: placement.position.x + radius * Math.cos(radians),
      y: placement.position.y + radius * Math.sin(radians),
    };
  });
}

function footprintVertices(placement) {
  if (placement.footprint.type === 'circular') {
    return circularFootprintVertices(placement);
  }
  if (placement.footprint.type === 'polygonal') {
    return placement.footprint.vertices.map(vertex => toAbsoluteFootprintPoint(placement, vertex));
  }
  return rectangularFootprintVertices(placement);
}

function isNearRectangle(measurement) {
  if (measurement.boundary.length !== 4) return false;
  const xs = measurement.boundary.map(p => p.x);
  const ys = measurement.boundary.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const idealCorners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  const offsets = measurement.boundary.map((point, index) => Math.hypot(point.x - idealCorners[index].x, point.y - idealCorners[index].y));
  return offsets.some(offset => offset > 0) && offsets.every(offset => offset <= NEAR_RECTANGLE_MAX_VERTEX_OFFSET_MM);
}

function validateEvidencePolicy(registry, thresholdRegistry) {
  const thresholdById = new Map(thresholdRegistry.rows.map(row => [row.thresholdId, row]));
  const errors = [];

  for (const row of registry.rows) {
    for (const thresholdRef of row.thresholdRefs || []) {
      const threshold = thresholdById.get(thresholdRef);
      if (!threshold) {
        errors.push(`${row.evidenceId}: thresholdRefs entry ${thresholdRef} not found`);
        continue;
      }

      if (threshold.status === 'pending_business_confirmation' && row.status === 'confirmed') {
        errors.push(`${row.evidenceId}: pending_business_confirmation threshold ${thresholdRef} can only produce unverified evidence`);
      }
    }

    const text = `${row.lockedItem} ${row.acceptanceMethod} ${row.expectedArtifact} ${row.notes || ''}`;
    if (row.status === 'confirmed' && /pending_business_confirmation/.test(text)) {
      errors.push(`${row.evidenceId}: W1D1/W1D2 row with pending_business_confirmation content must not be confirmed`);
    }
  }

  return errors;
}

function validateGoldenConsistency(measurement, golden) {
  const errors = [];
  const geometry = golden.expectedGeometry;
  const topology = golden.expectedTopology;
  const area = polygonArea(measurement.boundary);
  const perimeter = polygonPerimeter(measurement.boundary);
  const openingWallIndexes = (measurement.openings || []).map(o => o.wallIndex);

  if (area <= 0 && geometry.winding === 'counterclockwise') {
    errors.push('boundary winding is not counterclockwise');
  }
  if (measurement.boundary.length !== geometry.boundaryVertexCount) {
    errors.push(`boundaryVertexCount expected ${geometry.boundaryVertexCount}, got ${measurement.boundary.length}`);
  }
  if (measurement.walls.length !== geometry.wallCount) {
    errors.push(`wallCount expected ${geometry.wallCount}, got ${measurement.walls.length}`);
  }
  if (Math.abs(Math.abs(area) - geometry.areaMm2) > GOLDEN_AREA_TOLERANCE_MM2) {
    errors.push(`areaMm2 expected ${geometry.areaMm2}, got ${Math.abs(area)}`);
  }
  if (Math.abs(perimeter - geometry.perimeterMm) > GOLDEN_PERIMETER_TOLERANCE_MM) {
    errors.push(`perimeterMm expected ${geometry.perimeterMm}, got ${perimeter}`);
  }
  if ((measurement.openings || []).length !== topology.openingCount) {
    errors.push(`openingCount expected ${topology.openingCount}, got ${(measurement.openings || []).length}`);
  }
  if (countOpenings(measurement, 'door') !== topology.doorCount) {
    errors.push(`doorCount expected ${topology.doorCount}, got ${countOpenings(measurement, 'door')}`);
  }
  if (countOpenings(measurement, 'window') !== topology.windowCount) {
    errors.push(`windowCount expected ${topology.windowCount}, got ${countOpenings(measurement, 'window')}`);
  }
  if ((measurement.drainagePoints || []).length !== topology.drainagePointCount) {
    errors.push(`drainagePointCount expected ${topology.drainagePointCount}, got ${(measurement.drainagePoints || []).length}`);
  }
  if ((measurement.pipeEnclosures || []).length !== topology.pipeEnclosureCount) {
    errors.push(`pipeEnclosureCount expected ${topology.pipeEnclosureCount}, got ${(measurement.pipeEnclosures || []).length}`);
  }
  if ((measurement.waterSupplyPoints || []).length !== topology.waterSupplyPointCount) {
    errors.push(`waterSupplyPointCount expected ${topology.waterSupplyPointCount}, got ${(measurement.waterSupplyPoints || []).length}`);
  }
  if (JSON.stringify(openingWallIndexes) !== JSON.stringify(topology.openingWallIndexes)) {
    errors.push(`openingWallIndexes expected ${JSON.stringify(topology.openingWallIndexes)}, got ${JSON.stringify(openingWallIndexes)}`);
  }

  return errors;
}

function validateMeasurementSemantics(measurement, fixtureId) {
  const errors = [];

  if (measurement.heights.wallHeight < measurement.heights.roomHeight) {
    errors.push(`wallHeight ${measurement.heights.wallHeight} is lower than roomHeight ${measurement.heights.roomHeight}`);
  }

  if (measurement.walls.length !== measurement.boundary.length) {
    errors.push(`walls length ${measurement.walls.length} does not match boundary edge count ${measurement.boundary.length}`);
  } else {
    measurement.walls.forEach((wall, index) => {
      const start = measurement.boundary[index];
      const end = measurement.boundary[(index + 1) % measurement.boundary.length];
      if (!samePoint(wall.startPoint, start) || !samePoint(wall.endPoint, end)) {
        errors.push(`wall ${index} does not match boundary edge ${index}`);
      }
    });
  }

  (measurement.openings || []).forEach(opening => {
    const wall = measurement.walls[opening.wallIndex];
    if (!wall) {
      errors.push(`opening ${opening.openingId} references missing wallIndex ${opening.wallIndex}`);
      return;
    }
    if (!pointOnSegment(opening.position, wall.startPoint, wall.endPoint)) {
      errors.push(`opening ${opening.openingId} position is not on wall ${opening.wallIndex}`);
    }
    if (opening.width > segmentLength(wall.startPoint, wall.endPoint) + COORDINATE_TOLERANCE_MM) {
      errors.push(`opening ${opening.openingId} width exceeds wall ${opening.wallIndex} length`);
    }
  });

  (measurement.drainagePoints || []).forEach(drain => {
    if (!pointInPolygon(drain.position, measurement.boundary)) {
      errors.push(`drain ${drain.drainId} is outside room boundary`);
    }
  });

  (measurement.pipeEnclosures || []).forEach(enclosure => {
    enclosure.boundary.forEach((point, index) => {
      if (!pointInPolygon(point, measurement.boundary)) {
        errors.push(`pipe enclosure ${enclosure.enclosureId} vertex ${index} is outside room boundary`);
      }
    });
  });

  if (fixtureId === 'FIXTURE-002' && !isNearRectangle(measurement)) {
    errors.push('FIXTURE-002 must be a 4-vertex near-rectangle with <=20mm coordinate offsets, not a chamfered polygon');
  }

  return errors;
}

function validateFixturePlacementSemantics(measurement, product, placement) {
  const errors = [];

  if (placement.roomId !== measurement.roomId) {
    errors.push(`placement roomId ${placement.roomId} does not match measurement roomId ${measurement.roomId}`);
  }
  if (placement.productId !== product.productId) {
    errors.push(`placement productId ${placement.productId} does not match product ${product.productId}`);
  }
  if (product.installRequirements?.mountType === 'floor' && placement.position.z !== 0) {
    errors.push(`floor-mounted placement ${placement.placementId} must have z=0`);
  }

  const drainById = new Map((measurement.drainagePoints || []).map(drain => [drain.drainId, drain]));
  const targetDrain = placement.targetDrainagePoint ? drainById.get(placement.targetDrainagePoint) : null;
  if (product.installRequirements?.requiresDrain && !targetDrain) {
    errors.push(`placement ${placement.placementId} targetDrainagePoint is missing from measurement drainagePoints`);
  }
  if (product.type === 'toilet' && targetDrain && targetDrain.type !== 'toilet_drain') {
    errors.push(`toilet placement ${placement.placementId} must target toilet_drain, got ${targetDrain.type}`);
  }

  const vertices = footprintVertices(placement);
  vertices.forEach((point, index) => {
    if (!pointInPolygon(point, measurement.boundary)) {
      errors.push(`placement ${placement.placementId} footprint vertex ${index} is outside room boundary`);
    }
  });
  if (targetDrain && !pointInPolygon(targetDrain.position, vertices)) {
    errors.push(`placement ${placement.placementId} footprint does not contain target drain ${targetDrain.drainId}`);
  }

  return errors;
}

function validateGoldenFixtureExpectations(golden, measurement, schemas) {
  const errors = [];
  const productSchema = schemas['product.schema.json']?.compiled;
  const placementSchema = schemas['fixture-placement.schema.json']?.compiled;

  for (const expected of golden.expectedFixtures || []) {
    const productPath = path.join(SYNTHETIC_PRODUCT_DIR, expected.productFile);
    const placementPath = path.join(SYNTHETIC_PLACEMENT_DIR, expected.placementFile);
    const product = loadJSON(productPath);
    const placement = loadJSON(placementPath);

    if (product._error) {
      errors.push(`${expected.productFile}: ${product._error}`);
      continue;
    }
    if (placement._error) {
      errors.push(`${expected.placementFile}: ${placement._error}`);
      continue;
    }
    if (!productSchema(product)) {
      errors.push(`${expected.productFile}: ${formatErrors(productSchema.errors)}`);
      continue;
    }
    if (!placementSchema(placement)) {
      errors.push(`${expected.placementFile}: ${formatErrors(placementSchema.errors)}`);
      continue;
    }
    if (product.productId !== expected.productId) {
      errors.push(`${expected.productFile}: productId expected ${expected.productId}, got ${product.productId}`);
    }
    if (placement.roomId !== expected.roomId) {
      errors.push(`${expected.placementFile}: roomId expected ${expected.roomId}, got ${placement.roomId}`);
    }
    if (placement.targetDrainagePoint !== expected.targetDrainagePoint) {
      errors.push(`${expected.placementFile}: targetDrainagePoint expected ${expected.targetDrainagePoint}, got ${placement.targetDrainagePoint}`);
    }

    const drain = (measurement.drainagePoints || []).find(item => item.drainId === expected.targetDrainagePoint);
    if (!drain || drain.type !== expected.targetDrainageType) {
      errors.push(`${expected.placementFile}: target drainage type expected ${expected.targetDrainageType}, got ${drain?.type || 'missing'}`);
    }

    errors.push(...validateFixturePlacementSemantics(measurement, product, placement));
  }

  return errors;
}

function validateSemanticNegativeCases(schemas) {
  const errors = [];
  const measurementSchema = schemas['measurement.schema.json']?.compiled;
  const productSchema = schemas['product.schema.json']?.compiled;
  const placementSchema = schemas['fixture-placement.schema.json']?.compiled;
  const measurement = loadJSON(path.join(SYNTHETIC_DIR, 'measurement-synthetic-005-full-featured.json'));
  const product = loadJSON(path.join(SYNTHETIC_PRODUCT_DIR, 'product-synthetic-005-toilet.json'));
  const placement = loadJSON(path.join(SYNTHETIC_PLACEMENT_DIR, 'fixture-placement-synthetic-005-toilet.json'));

  if (measurement._error || product._error || placement._error) {
    return ['semantic negative fixture source cannot be loaded'];
  }
  if (!measurementSchema(measurement) || !productSchema(product) || !placementSchema(placement)) {
    return ['semantic negative fixture source must pass schema validation before mutation'];
  }

  const measurementCases = [
    {
      name: 'roomHeight greater than wallHeight',
      mutate: data => { data.heights.wallHeight = data.heights.roomHeight - 1; },
      expected: 'wallHeight',
    },
    {
      name: 'wall segment does not match boundary edge',
      mutate: data => { data.walls[0].endPoint.x -= COORDINATE_TOLERANCE_MM + 1; },
      expected: 'does not match boundary edge',
    },
    {
      name: 'opening position is off owning wall',
      mutate: data => { data.openings[0].position.y += COORDINATE_TOLERANCE_MM + 1; },
      expected: 'position is not on wall',
    },
    {
      name: 'opening width exceeds wall length',
      mutate: data => { data.openings[0].width = 4000; },
      expected: 'width exceeds wall',
    },
    {
      name: 'drainage point is outside room boundary',
      mutate: data => { data.drainagePoints[0].position.x = 4000; },
      expected: 'is outside room boundary',
    },
    {
      name: 'pipe enclosure vertex is outside room boundary',
      mutate: data => { data.pipeEnclosures[0].boundary[0].x = 3200; },
      expected: 'pipe enclosure',
    },
  ];

  measurementCases.forEach(testCase => {
    const data = cloneJSON(measurement);
    testCase.mutate(data);
    const semanticErrors = validateMeasurementSemantics(data, 'FIXTURE-005');
    if (!semanticErrors.some(error => error.includes(testCase.expected))) {
      errors.push(`${testCase.name}: expected semantic failure containing "${testCase.expected}", got ${semanticErrors.join('; ') || 'none'}`);
    }
  });

  const placementCases = [
    {
      name: 'placement productId mismatch',
      mutate: data => { data.productId = 'PLACEHOLDER-sink'; },
      expected: 'productId',
    },
    {
      name: 'floor-mounted fixture has nonzero z',
      mutate: data => { data.position.z = 50; },
      expected: 'must have z=0',
    },
    {
      name: 'required drain reference is missing',
      mutate: data => { data.targetDrainagePoint = '55555555-5555-4555-8555-999999999999'; },
      expected: 'targetDrainagePoint is missing',
    },
    {
      name: 'fixture footprint exceeds room boundary',
      mutate: data => { data.position.x = 100; },
      expected: 'footprint vertex',
    },
    {
      name: 'rotated rectangular footprint exceeds room boundary',
      mutate: data => {
        data.position = { x: 1500, y: 1200, z: 0 };
        data.orientation.rotationZ = 90;
        data.footprint = { type: 'rectangular', width: 2600, depth: 300 };
      },
      expected: 'footprint vertex',
    },
  ];

  placementCases.forEach(testCase => {
    const data = cloneJSON(placement);
    testCase.mutate(data);
    const semanticErrors = validateFixturePlacementSemantics(measurement, product, data);
    if (!semanticErrors.some(error => error.includes(testCase.expected))) {
      errors.push(`${testCase.name}: expected semantic failure containing "${testCase.expected}", got ${semanticErrors.join('; ') || 'none'}`);
    }
  });

  return errors;
}

// --- Main ---

function main() {
  console.log('=== Bathroom Design Contract Validator ===\n');

  if (!fs.existsSync(SCHEMAS_DIR)) {
    console.error(`ERROR: Schemas directory not found: ${SCHEMAS_DIR}`);
    process.exit(2);
  }

  // 1. Validate each schema file
  console.log('--- Validating Schema Files ---\n');

  // Use strict for metaschema validation
  const metaAjv = new Ajv({ strict: true, allErrors: true });
  addFormats(metaAjv);

  // Validate that the draft-07 metaschema itself is available
  const metaSchema = metaAjv.getSchema('http://json-schema.org/draft-07/schema#');
  if (!metaSchema) {
    console.error('ERROR: Could not load JSON Schema draft-07 metaschema.');
    process.exit(2);
  }

  // Use relaxed strict for schema compilation — our schemas use valid patterns
  // (e.g., conditional required in allOf/then) that strict mode flags.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('version');

  const schemas = {};
  const evidenceSchemaFiles = fs.readdirSync(EVIDENCE_SCHEMA_DIR)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => {
      if (a === 'evidence-table.schema.json') return -1;
      if (b === 'evidence-table.schema.json') return 1;
      return a.localeCompare(b);
    });
  const schemaFiles = [
    ...fs.readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.json')).map(f => ({ file: f, filepath: path.join(SCHEMAS_DIR, f), key: f })),
    ...evidenceSchemaFiles.map(f => ({ file: `evidence/schema/${f}`, filepath: path.join(EVIDENCE_SCHEMA_DIR, f), key: f })),
  ];

  for (const { file, filepath, key } of schemaFiles) {
    const schema = loadJSON(filepath);

    if (schema._error) {
      log('FAIL', `${file}: ${schema._error}`);
      totalFailed++;
      failures.push({ file, type: 'schema-parse', error: schema._error });
      continue;
    }

    // Validate schema against draft-07 metaschema
    const valid = metaSchema(schema);
    if (!valid) {
      log('FAIL', `${file}: Invalid JSON Schema (draft-07)`);
      metaSchema.errors.forEach(e => {
        log('INFO', `  ${e.instancePath}: ${e.message}`);
      });
      totalFailed++;
      failures.push({ file, type: 'schema-invalid', errors: metaSchema.errors });
      continue;
    }

    log('PASS', `${file}: Valid JSON Schema (draft-07)`);
    totalPassed++;

    // Register the schema for later example validation
    try {
      ajv.addSchema(schema, key);
      const compiled = ajv.getSchema(key) || ajv.compile(schema);
      schemas[key] = { schema, compiled };
    } catch (e) {
      log('FAIL', `${file}: Cannot compile schema: ${e.message}`);
      totalFailed++;
      failures.push({ file, type: 'schema-compile', error: e.message });
    }
  }

  // 2. Validate positive examples (must pass)
  console.log('\n--- Validating Positive Examples (must PASS) ---\n');

  for (const [schemaFile, examplePrefix] of Object.entries(SCHEMA_EXAMPLE_MAP)) {
    if (!schemas[schemaFile]) continue;

    const { compiled } = schemas[schemaFile];
    const examples = getExampleFiles(VALID_DIR, examplePrefix);

    if (examples.length === 0) {
      log('FAIL', `${schemaFile}: No valid examples found for prefix '${examplePrefix}'`);
      totalFailed++;
      failures.push({ file: schemaFile, type: 'no-valid-examples', prefix: examplePrefix });
      continue;
    }

    for (const examplePath of examples) {
      const data = loadJSON(examplePath);
      const fname = path.basename(examplePath);

      if (data._error) {
        log('FAIL', `${fname}: ${data._error}`);
        totalFailed++;
        failures.push({ file: fname, type: 'example-parse', error: data._error });
        continue;
      }

      const valid = compiled(data);
      if (!valid) {
        log('FAIL', `${fname}: Should be valid but failed validation`);
        compiled.errors.forEach(e => {
          log('INFO', `  ${e.instancePath}: ${e.message}`);
        });
        totalFailed++;
        failures.push({ file: fname, type: 'valid-example-failed', errors: compiled.errors });
      } else {
        log('PASS', `${fname}: Correctly passes validation`);
        totalPassed++;
      }
    }
  }

  // 3. Validate negative examples (must fail)
  console.log('\n--- Validating Negative Examples (must FAIL) ---\n');

  for (const [schemaFile, examplePrefix] of Object.entries(SCHEMA_EXAMPLE_MAP)) {
    if (!schemas[schemaFile]) continue;

    const { compiled } = schemas[schemaFile];
    const examples = getExampleFiles(INVALID_DIR, examplePrefix);

    if (examples.length === 0) {
      log('INFO', `${schemaFile}: No invalid examples found for prefix '${examplePrefix}' (optional)`);
      continue;
    }

    for (const examplePath of examples) {
      const data = loadJSON(examplePath);
      const fname = path.basename(examplePath);

      if (data._error) {
        log('FAIL', `${fname}: ${data._error} (invalid JSON — cannot test)`);
        totalFailed++;
        failures.push({ file: fname, type: 'invalid-example-parse', error: data._error });
        continue;
      }

      const valid = compiled(data);
      if (valid) {
        log('FAIL', `${fname}: Should be invalid but passed validation`);
        totalFailed++;
        failures.push({ file: fname, type: 'invalid-example-passed' });
      } else {
        log('PASS', `${fname}: Correctly fails validation`);
        totalPassed++;
      }
    }
  }

  // 4. Validate W1D2 registry JSON files and policy constraints.
  console.log('\n--- Validating W1D2 Evidence Registries ---\n');

  const evidenceRegistry = loadJSON(path.join(EVIDENCE_REGISTRY_DIR, 'evidence-registry.json'));
  const thresholdRegistry = loadJSON(path.join(EVIDENCE_REGISTRY_DIR, 'threshold-registry.json'));

  const registryChecks = [
    ['evidence-registry.json', evidenceRegistry, schemas['evidence-registry.schema.json']?.compiled],
    ['threshold-registry.json', thresholdRegistry, schemas['threshold-registry.schema.json']?.compiled],
  ];

  for (const [fname, data, compiled] of registryChecks) {
    if (data._error) {
      log('FAIL', `${fname}: ${data._error}`);
      totalFailed++;
      failures.push({ file: fname, type: 'evidence-registry-parse', error: data._error });
      continue;
    }
    if (!compiled) {
      log('FAIL', `${fname}: Missing compiled schema`);
      totalFailed++;
      failures.push({ file: fname, type: 'missing-schema' });
      continue;
    }
    const valid = compiled(data);
    if (!valid) {
      log('FAIL', `${fname}: Should be valid but failed validation`);
      log('INFO', `  ${formatErrors(compiled.errors)}`);
      totalFailed++;
      failures.push({ file: fname, type: 'evidence-registry-invalid', errors: compiled.errors });
    } else {
      log('PASS', `${fname}: Correctly passes validation`);
      totalPassed++;
    }
  }

  if (!evidenceRegistry._error && !thresholdRegistry._error) {
    const policyErrors = validateEvidencePolicy(evidenceRegistry, thresholdRegistry);
    if (policyErrors.length > 0) {
      log('FAIL', `evidence-registry.json: ${policyErrors.join('; ')}`);
      totalFailed++;
      failures.push({ file: 'evidence-registry.json', type: 'evidence-policy-failed', errors: policyErrors });
    } else {
      log('PASS', 'evidence-registry.json: Business-confirmation policy passes');
      totalPassed++;
    }
  }

  // 5. Validate W1D2 synthetic fixtures and golden geometry/topology.
  console.log('\n--- Validating W1D2 Synthetic Fixtures and Golden Outputs ---\n');

  const measurementSchema = schemas['measurement.schema.json']?.compiled;
  const goldenSchema = schemas['synthetic-golden.schema.json']?.compiled;
  const syntheticFiles = listJsonFiles(SYNTHETIC_DIR);
  const goldenFiles = listJsonFiles(GOLDEN_DIR);
  const syntheticProductFiles = listJsonFiles(SYNTHETIC_PRODUCT_DIR);
  const syntheticPlacementFiles = listJsonFiles(SYNTHETIC_PLACEMENT_DIR);

  if (syntheticFiles.length !== 5) {
    log('FAIL', `Expected 5 synthetic fixture JSON files, found ${syntheticFiles.length}`);
    totalFailed++;
    failures.push({ file: 'evidence/samples/synthetic', type: 'synthetic-count' });
  }
  if (goldenFiles.length !== 5) {
    log('FAIL', `Expected 5 golden JSON files, found ${goldenFiles.length}`);
    totalFailed++;
    failures.push({ file: 'evidence/samples/golden', type: 'golden-count' });
  }

  for (const examplePath of syntheticFiles) {
    const data = loadJSON(examplePath);
    const fname = path.basename(examplePath);
    if (data._error || !measurementSchema(data)) {
      log('FAIL', `${fname}: Synthetic measurement fixture failed schema validation`);
      if (data._error) log('INFO', `  ${data._error}`);
      else log('INFO', `  ${formatErrors(measurementSchema.errors)}`);
      totalFailed++;
      failures.push({ file: fname, type: 'synthetic-fixture-invalid' });
    } else {
      log('PASS', `${fname}: Correctly passes measurement schema`);
      totalPassed++;

      const fixtureId = fname.match(/^measurement-synthetic-(\d{3})-/)?.[1];
      const semanticErrors = validateMeasurementSemantics(data, fixtureId ? `FIXTURE-${fixtureId}` : fname);
      if (semanticErrors.length > 0) {
        log('FAIL', `${fname}: Synthetic measurement semantic check failed`);
        log('INFO', `  ${semanticErrors.join('; ')}`);
        totalFailed++;
        failures.push({ file: fname, type: 'synthetic-fixture-semantic-failed', errors: semanticErrors });
      } else {
        log('PASS', `${fname}: Synthetic measurement semantics pass`);
        totalPassed++;
      }
    }
  }

  for (const examplePath of syntheticProductFiles) {
    const data = loadJSON(examplePath);
    const fname = path.basename(examplePath);
    const productSchema = schemas['product.schema.json']?.compiled;
    if (data._error || !productSchema(data)) {
      log('FAIL', `${fname}: Synthetic product fixture failed schema validation`);
      if (data._error) log('INFO', `  ${data._error}`);
      else log('INFO', `  ${formatErrors(productSchema.errors)}`);
      totalFailed++;
      failures.push({ file: fname, type: 'synthetic-product-invalid' });
    } else {
      log('PASS', `${fname}: Correctly passes product schema`);
      totalPassed++;
    }
  }

  for (const examplePath of syntheticPlacementFiles) {
    const data = loadJSON(examplePath);
    const fname = path.basename(examplePath);
    const placementSchema = schemas['fixture-placement.schema.json']?.compiled;
    if (data._error || !placementSchema(data)) {
      log('FAIL', `${fname}: Synthetic fixture placement failed schema validation`);
      if (data._error) log('INFO', `  ${data._error}`);
      else log('INFO', `  ${formatErrors(placementSchema.errors)}`);
      totalFailed++;
      failures.push({ file: fname, type: 'synthetic-placement-invalid' });
    } else {
      log('PASS', `${fname}: Correctly passes fixture placement schema`);
      totalPassed++;
    }
  }

  for (const goldenPath of goldenFiles) {
    const golden = loadJSON(goldenPath);
    const fname = path.basename(goldenPath);
    if (golden._error || !goldenSchema(golden)) {
      log('FAIL', `${fname}: Golden JSON failed schema validation`);
      if (golden._error) log('INFO', `  ${golden._error}`);
      else log('INFO', `  ${formatErrors(goldenSchema.errors)}`);
      totalFailed++;
      failures.push({ file: fname, type: 'golden-invalid' });
      continue;
    }

    const measurementPath = path.join(SYNTHETIC_DIR, golden.measurementFile);
    const measurement = loadJSON(measurementPath);
    const consistencyErrors = measurement._error ? [measurement._error] : [
      ...validateGoldenConsistency(measurement, golden),
      ...validateGoldenFixtureExpectations(golden, measurement, schemas),
    ];
    if (consistencyErrors.length > 0) {
      log('FAIL', `${fname}: Golden consistency check failed`);
      log('INFO', `  ${consistencyErrors.join('; ')}`);
      totalFailed++;
      failures.push({ file: fname, type: 'golden-consistency-failed', errors: consistencyErrors });
    } else {
      log('PASS', `${fname}: Golden geometry/topology matches measurement fixture`);
      totalPassed++;
    }
  }

  // 6. Validate W1D2 invalid samples (must fail either schema or policy).
  console.log('\n--- Validating W1D2 Negative Examples (must FAIL) ---\n');

  const d2InvalidChecks = [
    ['evidence-registry-invalid-001-confirmed-pending-threshold.json', schemas['evidence-registry.schema.json']?.compiled, data => {
      if (!data._error && schemas['evidence-registry.schema.json'].compiled(data)) {
        return validateEvidencePolicy(data, thresholdRegistry).length === 0;
      }
      return false;
    }],
    ['threshold-registry-invalid-001-pending-with-value.json', schemas['threshold-registry.schema.json']?.compiled, data => !data._error && schemas['threshold-registry.schema.json'].compiled(data)],
    ['synthetic-fixture-invalid-001-missing-heights.json', measurementSchema, data => !data._error && measurementSchema(data)],
  ];

  for (const [fname, compiled, passes] of d2InvalidChecks) {
    const data = loadJSON(path.join(EVIDENCE_INVALID_DIR, fname));
    if (!compiled) {
      log('FAIL', `${fname}: Missing compiled schema for invalid check`);
      totalFailed++;
      failures.push({ file: fname, type: 'missing-schema' });
      continue;
    }
    if (passes(data)) {
      log('FAIL', `${fname}: Should be invalid but passed validation/policy`);
      totalFailed++;
      failures.push({ file: fname, type: 'd2-invalid-passed' });
    } else {
      log('PASS', `${fname}: Correctly fails validation/policy`);
      totalPassed++;
    }
  }

  const semanticNegativeErrors = validateSemanticNegativeCases(schemas);
  if (semanticNegativeErrors.length > 0) {
    log('FAIL', `semantic negative cases: ${semanticNegativeErrors.join('; ')}`);
    totalFailed++;
    failures.push({ file: 'semantic-negative-cases', type: 'semantic-negative-failed', errors: semanticNegativeErrors });
  } else {
    log('PASS', 'semantic negative cases: Correctly fail semantic validation');
    totalPassed++;
  }

  // 7. Summary
  console.log('\n=== Validation Summary ===');
  console.log(`  Passed: ${totalPassed}`);
  console.log(`  Failed: ${totalFailed}`);

  if (totalFailed > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => {
      console.log(`    - ${f.file} (${f.type})`);
    });
    process.exit(1);
  } else {
    console.log('\n  All contract validations passed.');
    process.exit(0);
  }
}

main();
