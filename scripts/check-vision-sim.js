#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const visionPath = path.join(root, 'evidence', 'vision-sim', 'handdrawn-plan-vision-output.json');
const candidatePath = path.join(root, 'contracts', 'vision-sim', 'handdrawn-plan-measurement-candidate.json');
const EXPECTED_ATTACHMENT_ID = '019f87f8-6b1e-7dd2-857a-60abfe565b31';

function loadJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (error) {
    return { _error: error.message };
  }
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function findMeasurement(data, id) {
  return (data.recognized_measurements || []).find(item => item.id === id);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const vision = loadJSON(visionPath);
const candidate = loadJSON(candidatePath);

if (vision._error) fail(`cannot load Vision output: ${vision._error}`);
if (candidate._error) fail(`cannot load Vision measurement candidate: ${candidate._error}`);
if (process.exitCode) process.exit(process.exitCode);

assert(vision.source_agent === 'Vision', 'Vision output source_agent must be Vision');
assert(/not a real external AI API call/i.test(vision.simulation_scope), 'Vision output must declare it is not a real external AI API call');
assert(vision.image_asset?.attachment_id === EXPECTED_ATTACHMENT_ID, 'Vision output attachment ID mismatch');
assert(candidate.source?.attachmentId === EXPECTED_ATTACHMENT_ID, 'candidate attachment ID mismatch');
assert(candidate.status === 'unverified', 'candidate status must remain unverified');
assert(candidate.notRealAiE2E === true, 'candidate must explicitly mark notRealAiE2E=true');

const widthTop = findMeasurement(vision, 'M-outer-width-top-1840');
const widthBottom = findMeasurement(vision, 'M-outer-width-bottom-1840');
const depth = findMeasurement(vision, 'M-outer-depth-left-5530');
const door = findMeasurement(vision, 'M-door-800x2100');
const height = findMeasurement(vision, 'M-height-2100');

assert(widthTop?.value_mm === 1840, 'missing top 1840 width measurement');
assert(widthBottom?.value_mm === 1840, 'missing bottom 1840 width measurement');
assert(depth?.value_mm === 5530, 'missing 5530 depth measurement');
assert(door?.width_mm === 800 && door?.height_mm === 2100, 'missing 800x2100 door measurement');
assert(height?.value_mm === 2100, 'missing 2100 height measurement');

assert(candidate.roomOutline?.widthMm === 1840, 'candidate roomOutline width must be 1840');
assert(candidate.roomOutline?.depthMm === 5530, 'candidate roomOutline depth must be 5530');
assert(candidate.height?.roomHeightMm === 2100, 'candidate roomHeight must be 2100');
assert(candidate.openings?.[0]?.widthMm === 800 && candidate.openings?.[0]?.heightMm === 2100, 'candidate door must be 800x2100');
assert((candidate.utilityMarkers || []).length >= 4, 'candidate must retain utility marker candidates');
assert((vision.visual_evidence || []).every(item => Array.isArray(item.bbox) && item.bbox.length === 4), 'every visual evidence item must have bbox [x,y,w,h]');
assert((vision.acceptance_notes?.not_a_substitute_for_real_ai_e2e || []).length > 0, 'Vision output must retain real AI E2E caveat');
assert(candidate.acceptanceBoundary?.cannotReplaceRealAiApi === true, 'candidate must retain real AI API caveat');
assert(candidate.acceptanceBoundary?.cannotReplaceReferenceDwgQa === true, 'candidate must retain reference DWG QA caveat');

if (process.exitCode) process.exit(process.exitCode);

console.log('Vision simulation evidence checks passed');
