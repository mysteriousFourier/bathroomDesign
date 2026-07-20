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
const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const VALID_DIR = path.join(EXAMPLES_DIR, 'valid');
const INVALID_DIR = path.join(EXAMPLES_DIR, 'invalid');

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

function getExampleFiles(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => path.join(dir, f));
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
  const schemaFiles = fs.readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.json'));

  for (const file of schemaFiles) {
    const filepath = path.join(SCHEMAS_DIR, file);
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
      const compiled = ajv.compile(schema);
      schemas[file] = { schema, compiled };
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

  // 4. Summary
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
