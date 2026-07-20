#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { cloneJSON } = require('../lib/geometry');
const { buildTopology } = require('../lib/topology');

const ROOT = path.join(__dirname, '..');
const SYNTHETIC_DIR = path.join(ROOT, 'evidence', 'samples', 'synthetic');
const PLACEMENT_DIR = path.join(ROOT, 'evidence', 'samples', 'placements');
const PRODUCT_DIR = path.join(ROOT, 'evidence', 'samples', 'products');
const GOLDEN_PATH = path.join(ROOT, 'contracts', 'topology', 'w1d4-topology-golden.json');
const FAILURE_PATH = path.join(ROOT, 'contracts', 'topology', 'w1d4-failure-examples.json');

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function stable(value) {
  return JSON.stringify(value, null, 2);
}

function assertEqual(actual, expected, label) {
  if (stable(actual) !== stable(expected)) {
    console.error(`FAIL ${label}: output drift`);
    console.error('Expected:', stable(expected));
    console.error('Actual:', stable(actual));
    process.exitCode = 1;
  } else {
    console.log(`PASS ${label}`);
  }
}

const measurement = loadJSON(path.join(SYNTHETIC_DIR, 'measurement-synthetic-005-full-featured.json'));
const placement = loadJSON(path.join(PLACEMENT_DIR, 'fixture-placement-synthetic-005-toilet.json'));
const product = loadJSON(path.join(PRODUCT_DIR, 'product-synthetic-005-toilet.json'));

assertEqual(
  buildTopology(measurement, [placement], [product]),
  loadJSON(GOLDEN_PATH),
  'W1D4 topology golden',
);

const failureSpec = loadJSON(FAILURE_PATH);
for (const example of failureSpec.cases) {
  const testMeasurement = cloneJSON(measurement);
  const testPlacement = cloneJSON(placement);
  const testProduct = cloneJSON(product);
  const testPlacements = [testPlacement];

  function syncWallsToBoundary() {
    testMeasurement.walls = testMeasurement.boundary.map((point, index) => ({
      startPoint: point,
      endPoint: testMeasurement.boundary[(index + 1) % testMeasurement.boundary.length],
      type: 'exterior',
      thickness: 120,
    }));
  }

  if (example.caseId === 'W1D4-FAIL-001') {
    testMeasurement.walls[1].startPoint = { x: 2990, y: 10 };
  } else if (example.caseId === 'W1D4-FAIL-002') {
    testMeasurement.boundary = [
      { x: 0, y: 0 },
      { x: 3000, y: 2400 },
      { x: 3000, y: 0 },
      { x: 0, y: 2400 },
    ];
    syncWallsToBoundary();
  } else if (example.caseId === 'W1D4-FAIL-003') {
    testMeasurement.openings[0].wallIndex = 9;
  } else if (example.caseId === 'W1D4-FAIL-004') {
    testPlacement.position.x = 100;
  } else if (example.caseId === 'W1D4-FAIL-005') {
    testPlacement.targetDrainagePoint = '55555555-5555-4555-8555-999999999999';
  } else if (example.caseId === 'W1D4-FAIL-006') {
    testPlacement.footprint = {
      type: 'polygonal',
      width: 500,
      depth: 500,
      vertices: [
        { x: -250, y: -250 },
        { x: 250, y: -250 },
        { x: 5000, y: 250 },
        { x: -250, y: 250 },
      ],
    };
  } else if (example.caseId === 'W1D4-FAIL-007') {
    testPlacement.footprint = {
      type: 'circular',
      width: 800,
      depth: 800,
    };
    testPlacement.position.x = 150;
  } else if (example.caseId === 'W1D4-FAIL-008') {
    testPlacement.position.x = 1510;
  } else if (example.caseId === 'W1D4-FAIL-009') {
    const sharedPlacement = cloneJSON(testPlacement);
    sharedPlacement.placementId = '55555555-5555-4555-8555-000000000007';
    sharedPlacement.position.x = 1600;
    testPlacements.push(sharedPlacement);
  }

  const result = buildTopology(testMeasurement, testPlacements, [testProduct]);
  if (example.expectedRelation) {
    const relation = result.relations[example.expectedRelation];
    if (!Array.isArray(relation) || relation.length === 0) {
      console.error(`FAIL ${example.caseId}: expected relation ${example.expectedRelation}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS ${example.caseId}: ${example.expectedRelation}`);
    }
  } else if (!result.violations.some(violation => violation.code === example.expectedCode)) {
    console.error(`FAIL ${example.caseId}: expected ${example.expectedCode}, got ${result.violations.map(item => item.code).join(', ') || 'none'}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${example.caseId}: ${example.expectedCode}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
