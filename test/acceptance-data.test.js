// The committed acceptance data is part of the repository and must not be a
// fabricated report. This test loads data/trust-acceptance.json and checks:
//   1. every record carries an expectation derived from identifiability/fault,
//      never copied from measured output;
//   2. measured evidence is internally consistent with the verdict (a pass has
//      no failure codes; named failures match their evidence thresholds);
//   3. deterministic evidence fields are finite and within physical ranges.
// Reproduction against a live run is covered by `npm run trust:verify-data`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCEPTANCE_THRESHOLDS } from '../src/trust/acceptance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(here, '..', 'data', 'trust-acceptance.json');

const data = JSON.parse(await readFile(dataPath, 'utf8'));

test('acceptance data exists with a record per clean run and per mutation', () => {
  assert.ok(Array.isArray(data.records));
  assert.ok(data.records.length >= 22);
  const clean = data.records.filter((r) => r.injectedFault === null);
  assert.equal(clean.length, 7);
  for (const record of data.records) {
    assert.ok(['identifiable', 'unidentifiable', 'refused'].includes(record.identifiability));
    assert.ok(record.expectation && typeof record.expectation.pass === 'boolean');
    assert.ok(Array.isArray(record.expectation.failureCodes));
    assert.ok(record.actual && typeof record.actual.passed === 'boolean');
  }
});

test('expectations are derived from identifiability and injected fault, not output', () => {
  for (const r of data.records) {
    if (r.identifiability === 'refused') {
      assert.equal(r.expectation.pass, true);
      assert.deepEqual(r.expectation.failureCodes, []);
      continue;
    }
    if (r.injectedFault === 'known-region-pollution') {
      assert.deepEqual(r.expectation.failureCodes, ['known-pollution']);
    } else if (r.injectedFault === 'wrong-fill') {
      assert.ok(r.expectation.failureCodes.includes('fill-inconsistency'));
    }
    if (r.injectedFault === 'false-confidence' && r.identifiability === 'unidentifiable') {
      assert.ok(r.expectation.failureCodes.includes('false-confidence'));
    }
  }
});

test('actual verdicts match the committed expectations (no false reporting)', () => {
  for (const r of data.records) {
    assert.equal(r.actual.passed, r.expectation.pass,
      `${r.fixtureId}/${r.injectedFault ?? 'clean'} verdict contradicts expectation`);
    for (const code of r.expectation.failureCodes) {
      assert.ok(r.actual.failureCodes.includes(code),
        `${r.fixtureId}: expected named failure ${code} missing`);
    }
    if (r.actual.passed) assert.deepEqual(r.actual.failureCodes, []);
  }
});

test('evidence backs each verdict through the independent threshold gates', () => {
  for (const r of data.records) {
    if (r.identifiability === 'refused') {
      assert.equal(r.evidence.outputUntouchedWhenRefused, true);
      continue;
    }
    const k = r.evidence.known;
    const c = r.evidence.conservation;
    assert.ok(Number.isFinite(k.observedChangeDb));
    assert.ok(Number.isFinite(c.worstConservationDb));
    const hasKnownPollution = r.actual.failureCodes.includes('known-pollution');
    assert.equal(
      k.observedChangeDb > ACCEPTANCE_THRESHOLDS.observedChangeDbMax
      || k.outsideWindowChangeDb > ACCEPTANCE_THRESHOLDS.outsideWindowDbMax,
      hasKnownPollution,
      `${r.fixtureId}/${r.injectedFault}: known-region evidence inconsistent with verdict`,
    );
    const hasConservationBreach = r.actual.failureCodes.includes('conservation-breach');
    assert.equal(c.worstConservationDb > ACCEPTANCE_THRESHOLDS.subbandConservationDbMax, hasConservationBreach);
    if (r.actual.failureCodes.includes('fill-inconsistency')) {
      assert.ok(r.evidence.fill.fillResidualDb > ACCEPTANCE_THRESHOLDS.fillResidualDbMax);
    }
    // Mask orthogonality must always hold to machine precision.
    assert.ok(r.evidence.orthogonalitySplitRelativeError < 1e-10);
  }
});

test('projection lower bound never violates the triangle inequality', () => {
  for (const r of data.records) {
    if (r.identifiability === 'refused') continue;
    assert.equal(r.evidence.projection.boundHolds, true);
    assert.ok(Number.isFinite(r.evidence.projection.lowerBoundDb));
  }
});
