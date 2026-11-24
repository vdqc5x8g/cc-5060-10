#!/usr/bin/env node
// Command-line assistant for trusted-region verification. The GUI remains the
// primary entry point; this script only (re)runs the same checks headlessly.
//
//   node bin/trust-check.js                 clean + mutation suite, print table
//   node bin/trust-check.js --write-data    regenerate data/trust-acceptance.json
//   node bin/trust-check.js --verify-data   re-measure and compare with the
//                                           committed acceptance data
//
// Exit code is non-zero if any expectation is violated, so CI cannot pass on a
// broken trust layer.

import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrustFixtures } from '../src/trust/fixtures-trust.js';
import { completeBands } from '../src/kernel/complete.js';
import { runTrustVerification } from '../src/trust/runner.js';
import { polluteKnownRegion, injectOverconfidence, injectWrongFill } from '../src/trust/faults.js';
import { summarizeVerdicts } from '../src/trust/acceptance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'trust-acceptance.json');
const args = new Set(process.argv.slice(2));

function kernelRun(fx) {
  return completeBands({
    audio: fx.defective, sampleRate: fx.sampleRate, fftSize: fx.fftSize, hop: fx.hop,
    regions: [{ ...fx.region }], options: {},
  });
}

// Expectations are derived independently of the pipeline output: the fixture's
// declared identifiability and the fault injected, not the measured numbers.
function expectedOutcome(fx, fault) {
  if (fx.identifiability === 'refused') return { expectPass: true, expectCodes: [] };
  if (fault === 'known-region-pollution') return { expectPass: false, expectCodes: ['known-pollution'] };
  if (fault === 'wrong-fill') return { expectPass: false, expectCodes: ['fill-inconsistency'] };
  if (fault === 'false-confidence') {
    // The mutation only removes uncertainty markers that were actually there,
    // so it is meaningful (and must be caught) on unidentifiable/conflict
    // material. On genuinely identifiable material a high-confidence label is
    // legitimate and the layer correctly accepts it.
    return fx.identifiability === 'unidentifiable'
      ? { expectPass: false, expectCodes: ['false-confidence'] }
      : { expectPass: true, expectCodes: [] };
  }
  if (fx.identifiability === 'unidentifiable') {
    // The current kernel only emits low confidence when left/right evidence is
    // mutually exclusive. Non-conflicting stochastic texture therefore reaches
    // the acceptance layer over-confident; the layer is required to flag it.
    // The conflict fixture (prior-mismatch-noise) already marks itself low, so
    // its clean run is an honest pass.
    return fx.id === 'prior-mismatch-noise'
      ? { expectPass: true, expectCodes: [] }
      : { expectPass: false, expectCodes: ['false-confidence'] };
  }
  return { expectPass: true, expectCodes: [] };
}

function buildRecords(withTruth) {
  const fixtures = buildTrustFixtures();
  const records = [];
  for (const fx of fixtures) {
    const clean = runTrustVerification(fx, { withTruth });
    records.push(toRecord(fx, null, clean, expectedOutcome(fx, null)));

    if (fx.identifiability === 'refused') continue;
    const result = kernelRun(fx);
    const mutations = [
      ['known-region-pollution', () => {
        const polluted = polluteKnownRegion({
          reconstructed: result.audio, mask: result.mask, grid: fx.grid,
          fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
        });
        return runTrustVerification(fx, { fault: 'known-region-pollution', polluted, withTruth });
      }],
      ['false-confidence', () => {
        const over = injectOverconfidence(result.report);
        return runTrustVerification(fx, { fault: 'false-confidence', overconfidentReport: over.report, withTruth });
      }],
      ['wrong-fill', () => {
        const wrong = injectWrongFill({
          reconstructed: result.audio, mask: result.mask,
          fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
        });
        return runTrustVerification(fx, { fault: 'wrong-fill', wrongFill: wrong, withTruth });
      }],
    ];
    for (const [fault, run] of mutations) {
      const out = run();
      records.push(toRecord(fx, fault, out, expectedOutcome(fx, fault)));
    }
  }
  return records;
}

function toRecord(fx, fault, out, expectation) {
  const m = out.measurements ?? {};
  return {
    fixtureId: fx.id,
    pair: fx.pair,
    identifiability: fx.identifiability,
    injectedFault: fault,
    expectation: { pass: expectation.expectPass, failureCodes: expectation.expectCodes },
    actual: {
      passed: out.verdict.passed,
      failureCodes: out.verdict.failureCodes,
      status: out.status,
    },
    evidence: {
      known: out.refused ? null : {
        observedChangeDb: m.known?.observedChangeDb ?? null,
        outsideWindowChangeDb: m.known?.outsideWindowChangeDb ?? null,
        changedSamples: m.known?.changedSamples ?? null,
      },
      conservation: out.refused ? null : {
        worstConservationDb: m.conservation?.worstConservationDb ?? null,
        compartments: (m.conservation?.compartments ?? []).map((c) => ({ name: c.name, conservationDb: c.conservationDb })),
      },
      fill: out.refused ? null : { fillResidualDb: m.fill?.fillResidualDb ?? null },
      divergence: out.refused ? null : {
        meanDb: m.divergence?.meanDb ?? null,
        maxDb: m.divergence?.maxDb ?? null,
        candidateCount: out.verdict.checks.find((c) => c.name === 'candidate-divergence')?.evidence?.candidateCount ?? null,
      },
      projection: out.refused ? null : {
        disagreementDb: m.projection?.disagreementDb ?? null,
        lowerBoundDb: m.projection?.lowerBoundDb ?? null,
        periodicity: m.projection?.periodicity ?? null,
        boundHolds: m.projection?.boundHolds ?? null,
      },
      orthogonalitySplitRelativeError: m.orthogonality?.splitRelativeError ?? null,
      outputUntouchedWhenRefused: out.refused ? out.outputUntouched : null,
      scopeCheck: out.scopeCheck ? {
        errADb: out.scopeCheck.errADb,
        errBDb: out.scopeCheck.errBDb,
        lowerBoundDb: out.scopeCheck.lowerBoundDb,
        boundHolds: out.scopeCheck.boundHolds,
        informative: out.scopeCheck.informative,
        scopeNote: out.scopeCheck.scopeNote,
      } : null,
    },
    checks: out.verdict.checks,
  };
}

function validateExpectations(records) {
  const mismatches = [];
  for (const r of records) {
    if (r.actual.passed !== r.expectation.pass) {
      mismatches.push(`${r.fixtureId}/${r.injectedFault ?? 'clean'}: expected pass=${r.expectation.pass}, got ${r.actual.passed} [${r.actual.failureCodes}]`);
      continue;
    }
    for (const code of r.expectation.failureCodes) {
      if (!r.actual.failureCodes.includes(code)) {
        mismatches.push(`${r.fixtureId}/${r.injectedFault ?? 'clean'}: expected failure code ${code}, got [${r.actual.failureCodes}]`);
      }
    }
  }
  return mismatches;
}

function printTable(records) {
  console.log('fixture'.padEnd(26), 'fault'.padEnd(24), 'expect'.padEnd(7), 'verdict', 'codes');
  for (const r of records) {
    const expect = r.expectation.pass ? 'pass' : `fail:${r.expectation.failureCodes.join(',')}`;
    const verdict = r.actual.passed ? 'PASS' : 'FAIL';
    console.log(
      r.fixtureId.padEnd(26),
      String(r.injectedFault ?? 'clean').padEnd(24),
      expect.padEnd(7),
      verdict.padEnd(7),
      r.actual.failureCodes.join(','),
    );
  }
}

async function main() {
  if (args.has('--write-data')) {
    const records = buildRecords(true);
    const mismatches = validateExpectations(records);
    const payload = {
      schemaVersion: 1,
      generatedBy: 'bin/trust-check.js --write-data',
      note: 'Acceptance expectations are derived from fixture identifiability and injected faults, never from measured output. Evidence values are independent STFT-only reference measurements.',
      thresholdsNote: 'See ACCEPTANCE_THRESHOLDS in src/trust/acceptance.js',
      summary: summarizeVerdicts(records.map((r) => ({
        fixtureId: r.fixtureId,
        passed: r.actual.passed,
        failureCodes: r.actual.failureCodes,
        failures: r.actual.failureCodes.map((code) => ({ fixtureId: r.fixtureId, code, message: code })),
      }))),
      records,
    };
    await writeFile(DATA_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`wrote ${records.length} records to ${path.relative(process.cwd(), DATA_PATH)}`);
    if (mismatches.length) {
      console.error('expectation mismatches:\n' + mismatches.join('\n'));
      process.exitCode = 1;
    }
    return;
  }

  if (args.has('--verify-data')) {
    const committed = JSON.parse(await readFile(DATA_PATH, 'utf8'));
    const fresh = buildRecords(true);
    const mismatches = [];
    if (fresh.length !== committed.records.length) {
      mismatches.push(`record count ${fresh.length} != committed ${committed.records.length}`);
    }
    for (let i = 0; i < Math.min(fresh.length, committed.records.length); i++) {
      const a = fresh[i];
      const b = committed.records[i];
      if (a.fixtureId !== b.fixtureId || a.injectedFault !== b.injectedFault) {
        mismatches.push(`record ${i} identity drift: ${a.fixtureId}/${a.injectedFault} vs ${b.fixtureId}/${b.injectedFault}`);
        continue;
      }
      if (a.actual.passed !== b.actual.passed
        || JSON.stringify(a.actual.failureCodes) !== JSON.stringify(b.actual.failureCodes)) {
        mismatches.push(`${a.fixtureId}/${a.injectedFault ?? 'clean'}: verdict drift`);
      }
      // Numeric evidence must reproduce within 0.5 dB (deterministic pipeline).
      for (const key of ['observedChangeDb', 'outsideWindowChangeDb']) {
        const x = a.evidence.known?.[key];
        const y = b.evidence.known?.[key];
        if (x != null && y != null && Math.abs(x - y) > 0.5) {
          mismatches.push(`${a.fixtureId}: evidence drift ${key} ${x} vs ${y}`);
        }
      }
      const fx = a.evidence.fill?.fillResidualDb;
      const fy = b.evidence.fill?.fillResidualDb;
      if (fx != null && fy != null && Math.abs(fx - fy) > 0.5) {
        mismatches.push(`${a.fixtureId}: fill evidence drift ${fx} vs ${fy}`);
      }
    }
    const expectMismatches = validateExpectations(fresh);
    const all = [...mismatches, ...expectMismatches];
    printTable(fresh);
    if (all.length) {
      console.error('\nDATA VERIFICATION FAILED:\n' + all.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`\ncommitted data verified: ${fresh.length} records reproduce, all expectations hold`);
    }
    return;
  }

  const records = buildRecords(false);
  printTable(records);
  const mismatches = validateExpectations(records);
  const summary = summarizeVerdicts(records.map((r) => ({
    fixtureId: r.fixtureId, passed: r.actual.passed,
    failureCodes: r.actual.failureCodes,
    failures: r.actual.failureCodes.map((code) => ({ fixtureId: r.fixtureId, code })),
  })));
  console.log(`\nrecords: ${summary.total}, pass verdicts: ${summary.passed}, fail verdicts: ${summary.failed}`);
  if (mismatches.length) {
    console.error('\nEXPECTATION MISMATCH:\n' + mismatches.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
