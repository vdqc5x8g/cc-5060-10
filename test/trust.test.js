import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrustFixtures } from '../src/trust/fixtures-trust.js';
import { completeBands } from '../src/kernel/complete.js';
import { runTrustVerification } from '../src/trust/runner.js';
import { knownRegionError, candidateDivergence, subbandConservation, fillConsistency } from '../src/trust/reference.js';
import {
  timeLinearProjection, periodicProjection, projectionDisagreement,
  observedFitResiduals, maskProjectionOrthogonality, boundCheckAgainstTruth,
} from '../src/trust/projection-limit.js';
import { polluteKnownRegion, injectOverconfidence, injectWrongFill } from '../src/trust/faults.js';
import { judgeAcceptance, ACCEPTANCE_THRESHOLDS } from '../src/trust/acceptance.js';
import { stft } from '../src/kernel/stft.js';

const fixtures = buildTrustFixtures();
const byId = new Map(fixtures.map((f) => [f.id, f]));

function kernelRun(fx) {
  return completeBands({
    audio: fx.defective, sampleRate: fx.sampleRate, fftSize: fx.fftSize, hop: fx.hop,
    regions: [{ ...fx.region }], options: {},
  });
}

test('equal-width pair: same geometry, opposite identifiability', () => {
  const harmonic = byId.get('pairA-harmonic');
  const inharmonic = byId.get('pairA-inharmonic');
  assert.deepEqual(harmonic.region, inharmonic.region);
  assert.equal(harmonic.identifiability, 'identifiable');
  assert.equal(inharmonic.identifiability, 'unidentifiable');
  // The kernel never receives the truth track.
  assert.equal(harmonic.truth.length, harmonic.defective.length);
  assert.notDeepEqual(harmonic.truth, harmonic.defective);

  const outH = runTrustVerification(harmonic);
  const outI = runTrustVerification(inharmonic);
  assert.equal(outH.verdict.passed, true, 'identifiable harmonic gap must pass');
  // Independent candidate divergence must separate the two materials.
  const divH = outH.measurements.divergence.meanDb;
  const divI = outI.measurements.divergence.meanDb;
  assert.ok(divI > divH + 10, `unidentifiable divergence ${divI} must dwarf identifiable ${divH}`);
});

test('positive case: known-region error and subband conservation on a wide harmonic gap', () => {
  const fx = byId.get('width-harmonic-narrow');
  const out = runTrustVerification(fx);
  assert.equal(out.verdict.passed, true);
  const k = out.measurements.known;
  assert.ok(k.observedChangeDb <= ACCEPTANCE_THRESHOLDS.observedChangeDbMax,
    `pooled observed change ${k.observedChangeDb} dB must stay within tolerance`);
  assert.equal(k.outsideWindowUntouched, true);
  assert.ok(k.outsideWindowChangeDb <= ACCEPTANCE_THRESHOLDS.outsideWindowDbMax);
  const c = out.measurements.conservation;
  assert.ok(c.worstConservationDb <= ACCEPTANCE_THRESHOLDS.subbandConservationDbMax);
  assert.ok(c.cleanFrameCount > 0);
  for (const compartment of c.compartments) {
    assert.ok(compartment.conservationDb <= ACCEPTANCE_THRESHOLDS.subbandConservationDbMax,
      `${compartment.name} must conserve energy`);
  }
});

test('negative case: non-harmonic prior-violation material exposes candidate disagreement', () => {
  const fx = byId.get('prior-mismatch-noise');
  const result = kernelRun(fx);
  const region = result.report.regions[0];
  assert.equal(region.conflict, true);
  assert.ok(region.candidates.length >= 3);
  const out = runTrustVerification(fx);
  assert.equal(out.verdict.passed, true, 'conflict marker makes the honest run pass');
  assert.ok(out.measurements.divergence.maxDb >= ACCEPTANCE_THRESHOLDS.divergenceDbMin);
  assert.equal(region.confidence.level, 'low');
});

test('polluting the trusted region is a named known-pollution failure', () => {
  const fx = byId.get('pairA-harmonic');
  const result = kernelRun(fx);
  const polluted = polluteKnownRegion({
    reconstructed: result.audio, mask: result.mask, grid: fx.grid,
    fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
  });
  const out = runTrustVerification(fx, { fault: 'known-region-pollution', polluted });
  assert.equal(out.verdict.passed, false);
  assert.ok(out.verdict.failureCodes.includes('known-pollution'));
  assert.ok(out.measurements.known.observedChangeDb > ACCEPTANCE_THRESHOLDS.observedChangeDbMax);
  assert.equal(out.measurements.known.outsideWindowUntouched, false);
});

test('false confidence on unidentifiable material is a named failure', () => {
  const fx = byId.get('prior-mismatch-noise');
  const result = kernelRun(fx);
  assert.equal(result.report.regions[0].confidence.level, 'low');
  const mutated = injectOverconfidence(result.report);
  assert.equal(mutated.report.regions[0].confidence.level, 'high');
  const out = runTrustVerification(fx, { fault: 'false-confidence', overconfidentReport: mutated.report });
  assert.equal(out.verdict.passed, false);
  assert.ok(out.verdict.failureCodes.includes('false-confidence'));
});

test('wrong fill is caught by fill consistency while known region stays clean', () => {
  const fx = byId.get('pairA-harmonic');
  const result = kernelRun(fx);
  const wrong = injectWrongFill({
    reconstructed: result.audio, mask: result.mask,
    fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
  });
  const out = runTrustVerification(fx, { fault: 'wrong-fill', wrongFill: wrong });
  assert.equal(out.verdict.passed, false);
  assert.ok(out.verdict.failureCodes.includes('fill-inconsistency'));
  // The two checks are independent: known-region evidence must remain clean.
  assert.ok(out.measurements.known.observedChangeDb <= ACCEPTANCE_THRESHOLDS.observedChangeDbMax);
  assert.equal(out.measurements.known.outsideWindowUntouched, true);
  assert.ok(out.measurements.fill.fillResidualDb > ACCEPTANCE_THRESHOLDS.fillResidualDbMax);
});

test('over-wide gaps are refused and the recording is returned untouched', () => {
  for (const id of ['width-harmonic-wide', 'width-inharmonic-wide']) {
    const out = runTrustVerification(byId.get(id));
    assert.equal(out.refused, true);
    assert.equal(out.outputUntouched, true);
    assert.equal(out.verdict.passed, true);
  }
});

test('independent reference modules never import kernel truth or the completion kernel', async () => {
  const fs = await import('node:fs/promises');
  const referenceSrc = await fs.readFile(new URL('../src/trust/reference.js', import.meta.url), 'utf8');
  const projectionSrc = await fs.readFile(new URL('../src/trust/projection-limit.js', import.meta.url), 'utf8');
  const importsOf = (src) => src.split('\n').filter((line) => /^\s*import\b/.test(line)).join('\n');
  assert.doesNotMatch(importsOf(referenceSrc), /complete\.js/);
  assert.doesNotMatch(importsOf(referenceSrc), /fixtures/);
  assert.doesNotMatch(importsOf(projectionSrc), /complete\.js/);
});

test('mask projection is an exact orthogonal energy split', () => {
  const fx = byId.get('pairA-harmonic');
  const result = kernelRun(fx);
  const spec = stft(fx.defective, { fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate });
  const ortho = maskProjectionOrthogonality(spec, result.mask);
  assert.equal(ortho.orthogonal, true);
  assert.ok(ortho.maskedEnergy > 0 && ortho.observedEnergy > 0);
});

test('projection lower bound: triangle inequality holds on every fixture', () => {
  for (const fx of fixtures) {
    if (fx.identifiability === 'refused') continue;
    const out = runTrustVerification(fx, { withTruth: true });
    assert.equal(out.scopeCheck.boundHolds, true, `${fx.id}: lower bound must never be violated`);
    assert.ok(Number.isFinite(out.scopeCheck.lowerBoundDb));
    assert.ok(out.measurements.projection.lowerBoundLinear >= 0);
  }
});

test('projection lower bound scope: informative under prior mismatch, vacuous under a shared null space', () => {
  const fx = byId.get('pairA-inharmonic');
  const specDef = stft(fx.defective, { fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate });
  const mag = Array.from({ length: specDef.frames }, (_, m) => {
    const row = new Float64Array(specDef.bins);
    for (let b = 0; b < specDef.bins; b++) row[b] = Math.hypot(specDef.re[m][b], specDef.im[m][b]);
    return row;
  });
  const grid = fx.grid;
  const predA = timeLinearProjection(mag, grid);
  const periodic = periodicProjection(mag, grid);
  const predB = periodic.grid;
  const specTruth = stft(fx.truth, { fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate });
  const truthGrid = Array.from(
    { length: grid.frameEnd - grid.frameStart + 1 },
    (_, y) => Float64Array.from(
      Array.from({ length: grid.binEnd - grid.binStart + 1 }, (_, x) =>
        Math.hypot(specTruth.re[grid.frameStart + y][grid.binStart + x], specTruth.im[grid.frameStart + y][grid.binStart + x])),
    ),
  );
  const scope = boundCheckAgainstTruth({ predA, predB, truthGrid, mag, maskGrid: grid });
  assert.equal(scope.boundHolds, true);
  assert.equal(scope.informative, true, 'independent priors disagree on stochastic texture');

  // Shared null space: make both projections identical. The triangle bound
  // still holds but becomes vacuous (zero disagreement certifies nothing).
  const degenerate = boundCheckAgainstTruth({ predA, predB: predA, truthGrid, mag, maskGrid: grid });
  assert.equal(degenerate.boundHolds, true);
  assert.equal(degenerate.informative, false);
  assert.match(degenerate.scopeNote, /vacuous/);
});

test('observed fit residuals distinguish harmonic from inharmonic priors', () => {
  const harmonic = byId.get('width-harmonic-narrow');
  const inharmonic = byId.get('width-inharmonic-narrow');
  function residuals(fx) {
    const spec = stft(fx.defective, { fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate });
    const mag = Array.from({ length: spec.frames }, (_, m) => {
      const row = new Float64Array(spec.bins);
      for (let b = 0; b < spec.bins; b++) row[b] = Math.hypot(spec.re[m][b], spec.im[m][b]);
      return row;
    });
    return observedFitResiduals(mag, fx.grid);
  }
  const rH = residuals(harmonic);
  const rI = residuals(inharmonic);
  assert.ok(rH.meanPeriodicity > rI.meanPeriodicity);
  assert.ok(rH.linearFitDb < rI.linearFitDb, 'linear prior fits harmonic context better');
});

test('candidate divergence collapses for identical grids and grows for distinct ones', () => {
  const a = [Float64Array.from([1, 2, 3]), Float64Array.from([4, 5, 6])];
  const identical = candidateDivergence([a, a.map((r) => Float64Array.from(r))]);
  assert.ok(identical.maxDb <= ACCEPTANCE_THRESHOLDS.divergenceDbCollapse);
  const b = [Float64Array.from([6, 5, 4]), Float64Array.from([3, 2, 1])];
  const distinct = candidateDivergence([a, b]);
  assert.ok(distinct.maxDb > ACCEPTANCE_THRESHOLDS.divergenceDbMin);
});

test('acceptance layer does not pass on fabricated evidence', () => {
  // A payload claiming success despite a huge observed change must fail.
  const verdict = judgeAcceptance({
    fixtureId: 'synthetic',
    identifiability: 'identifiable',
    status: 'ok',
    regionStatus: 'completed',
    candidateCount: 1,
    confidenceLevel: 'high',
    conflict: false,
    known: { observedChangeDb: -5, outsideWindowChangeDb: -5, outsideWindowUntouched: false, changedSamples: 999 },
    conservation: { worstConservationDb: -5, compartments: [] },
    fill: { fillResidualDb: -30 },
    divergence: { meanDb: -60, maxDb: -60 },
    projection: { disagreementDb: -60, lowerBoundDb: -66, boundHolds: true, residuals: {} },
  });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.failureCodes.includes('known-pollution'));
});
