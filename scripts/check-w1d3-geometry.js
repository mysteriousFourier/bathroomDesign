#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { cloneJSON } = require('../lib/geometry');
const { recover2D } = require('../lib/recovery2d');

const ROOT = path.join(__dirname, '..');
const SYNTHETIC_DIR = path.join(ROOT, 'evidence', 'samples', 'synthetic');
const GOLDEN_PATH = path.join(ROOT, 'contracts', 'geometry', 'w1d3-recovery-golden.json');
const FAILURE_PATH = path.join(ROOT, 'contracts', 'geometry', 'w1d3-failure-examples.json');

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

function runGolden() {
  const measurement = loadJSON(path.join(SYNTHETIC_DIR, 'measurement-synthetic-005-full-featured.json'));
  const expected = loadJSON(GOLDEN_PATH);
  assertEqual(recover2D(measurement), expected, 'W1D3 full-featured recovery golden');
}

function assertSyntheticGeometry(fixtureId, filename) {
  const measurement = loadJSON(path.join(SYNTHETIC_DIR, filename));
  const expected = loadJSON(path.join(ROOT, 'evidence', 'samples', 'golden', filename.replace('.json', '.golden.json')));
  const result = recover2D(measurement);
  const actual = {
    boundaryVertexCount: result.geometry.boundaryVertexCount,
    wallCount: result.geometry.wallCount,
    winding: result.geometry.winding,
    areaMm2: result.geometry.areaMm2,
    perimeterMm: Number(result.geometry.perimeterMm.toFixed(2)),
    coordinateToleranceMm: expected.expectedGeometry.coordinateToleranceMm,
    angularToleranceDeg: expected.expectedGeometry.angularToleranceDeg,
  };
  assertEqual(actual, expected.expectedGeometry, `W1D3 ${fixtureId} geometry`);
  if (result.status !== 'passed') {
    console.error(`FAIL W1D3 ${fixtureId}: expected passed, got ${result.status}`);
    console.error(stable(result.violations));
    process.exitCode = 1;
  }
}

function runOptionalInputsCase() {
  const measurement = loadJSON(path.join(SYNTHETIC_DIR, 'measurement-synthetic-001-rectangle-empty.json'));
  const result = recover2D(measurement);
  if (result.status !== 'passed') {
    console.error(`FAIL W1D3 optional inputs: expected passed, got ${result.status}`);
    console.error(stable(result.violations));
    process.exitCode = 1;
    return;
  }
  if (result.optionalInputs.openingCount !== 0 || result.optionalInputs.drainagePointCount !== 0 || result.optionalInputs.pipeEnclosureCount !== 0) {
    console.error('FAIL W1D3 optional inputs: empty optional topology counts must remain zero');
    process.exitCode = 1;
    return;
  }
  console.log('PASS W1D3 optional openings/drainagePoints/pipeEnclosures are not required');
}

function executableFailureCases() {
  return [
    {
      caseId: 'W1D3-FAIL-001',
      description: 'Required height is missing; recovery only reads heights.*.',
      expectedCode: 'missing_required_height',
      patch: data => { delete data.heights.roomHeight; },
    },
    {
      caseId: 'W1D3-FAIL-002',
      description: 'Walls no longer map 1:1 to boundary edges.',
      expectedCode: 'wall_boundary_count_mismatch',
      patch: data => { data.walls.pop(); },
    },
    {
      caseId: 'W1D3-FAIL-003',
      description: 'Boundary polygon edges cross each other.',
      expectedCode: 'self_intersecting_boundary',
      patch: data => { data.boundary = [data.boundary[0], data.boundary[2], data.boundary[1], data.boundary[3]]; },
    },
    {
      caseId: 'W1D3-FAIL-004',
      description: 'Opening center no longer lies on its owning wall.',
      expectedCode: 'opening_off_wall',
      patch: data => { data.openings[0].position.y = 50; },
    },
    {
      caseId: 'W1D3-FAIL-005',
      description: 'Opening width and position overlap a wall corner.',
      expectedCode: 'opening_width_exceeds_wall',
      patch: data => { data.openings[0].position.x = 100; data.openings[0].width = 900; },
    },
    {
      caseId: 'W1D3-FAIL-006',
      description: 'Two openings overlap on the same wall.',
      expectedCode: 'opening_overlap',
      patch: data => {
        data.openings[1] = cloneJSON(data.openings[0]);
        data.openings[1].openingId = '55555555-5555-4555-8555-000000000006';
        data.openings[1].position.x = 1000;
      },
    },
    {
      caseId: 'W1D3-FAIL-007',
      description: 'Drain point is outside the room boundary.',
      expectedCode: 'drain_outside_room',
      patch: data => { data.drainagePoints[0].position.x = 3200; },
    },
    {
      caseId: 'W1D3-FAIL-008',
      description: 'Drain record is present but has no recoverable coordinate.',
      expectedCode: 'drain_missing_position',
      patch: data => { delete data.drainagePoints[0].position; },
    },
    {
      caseId: 'W1D3-FAIL-009',
      description: 'Pipe enclosure vertex penetrates outside the boundary.',
      expectedCode: 'pipe_enclosure_outside_room',
      patch: data => { data.pipeEnclosures[0].boundary[0].x = 3200; },
    },
    {
      caseId: 'W1D3-FAIL-010',
      description: 'Pipe enclosure record is present but lacks a polygon boundary.',
      expectedCode: 'pipe_enclosure_missing_boundary',
      patch: data => { delete data.pipeEnclosures[0].boundary; },
    },
  ];
}

runGolden();
assertSyntheticGeometry('legal rectangle', 'measurement-synthetic-001-rectangle-empty.json');
assertSyntheticGeometry('legal near-rectangle', 'measurement-synthetic-002-near-rectangle.json');
runOptionalInputsCase();

const source = loadJSON(path.join(SYNTHETIC_DIR, 'measurement-synthetic-005-full-featured.json'));
const failureSpec = loadJSON(FAILURE_PATH);
const executableCases = executableFailureCases();
for (const example of failureSpec.cases) {
  const executable = executableCases.find(item => item.caseId === example.caseId);
  const mutated = cloneJSON(source);
  executable.patch(mutated);
  const result = recover2D(mutated);
  if (!result.violations.some(violation => violation.code === example.expectedCode)) {
    console.error(`FAIL ${example.caseId}: expected ${example.expectedCode}, got ${result.violations.map(item => item.code).join(', ') || 'none'}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${example.caseId}: ${example.expectedCode}`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
