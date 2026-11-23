import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFixtures, FFT, HOP } from '../src/fixtures/generate.js';
import { completeBands, DEFAULT_LIMITS } from '../src/kernel/complete.js';
import { evaluateCompletion } from '../src/eval/evaluate.js';

const fixtures = buildFixtures();
const byId = new Map(fixtures.map((fx) => [fx.id, fx]));

function runFixture(id) {
  const fx = byId.get(id);
  const regions = fx.regions.map(({ startSec, endSec, lowHz, highHz }) => ({ startSec, endSec, lowHz, highHz }));
  const result = completeBands({
    audio: fx.defective, sampleRate: fx.sampleRate, fftSize: FFT, hop: HOP, regions, options: {},
  });
  return { fx, regions, result };
}

test('supported short gap completes and preserves observed samples', () => {
  const { fx, regions, result } = runFixture('harmonic-short');
  assert.equal(result.report.status, 'ok');
  const region = result.report.regions[0];
  assert.equal(region.status, 'completed');
  assert.ok(region.candidates.length >= 1);
  assert.equal(region.selectedCandidate, 'harmonic');

  const audit = region.audit;
  assert.equal(audit.outsideAffectedSpanNonZeroSamples, 0, 'samples outside the affected span must be identical');
  assert.ok(audit.outsideOverlapUntouched, `outside-overlap change ${audit.outsideOverlapChangeDb} dB must be untouched`);
  assert.ok(audit.withinTolerance, `observed change ${audit.observedChangeDb} dB within ${audit.declaredToleranceDb} dB`);

  const ev = evaluateCompletion({
    truth: fx.truth, defective: fx.defective, reconstructed: result.audio,
    result, sampleRate: fx.sampleRate, regions, fftSize: FFT, hop: HOP,
  });
  const gap = ev.regions[0].gap;
  assert.ok(gap.improvementDb > 3, `expected a real improvement, got ${gap.improvementDb} dB`);
  assert.ok(gap.correlation > 0.8, `correlation ${gap.correlation} should align with truth`);
  assert.ok(!gap.copyNeighbourBeatsCompletion, 'completion must beat the forbidden neighbour-copy baseline');
  assert.ok(ev.regions[0].knownRegion.withinTolerance);
  assert.equal(ev.summary.anyKnownRegionViolation, false);
});

test('over-wide region is refused, not filled', () => {
  const { fx, result } = runFixture('wide-gap');
  assert.equal(result.report.status, 'refused');
  const region = result.report.regions[0];
  assert.equal(region.status, 'unsupported');
  assert.ok(region.reasons.some((r) => /exceeds supported limit/.test(r)));
  assert.equal(region.candidates.length, 0);
  // Refusal must return audio that is not fabricated content.
  let changed = 0;
  for (let i = 0; i < result.audio.length; i++) if (Math.abs(result.audio[i] - fx.defective[i]) > 1e-6) changed++;
  assert.equal(changed, 0, 'refused output must not modify the recording');
});

test('over-long region is refused', () => {
  const { result } = runFixture('harmonic-long');
  assert.equal(result.report.status, 'refused');
  assert.equal(result.report.regions[0].status, 'unsupported');
});

test('conflicting evidence yields multiple candidates with low confidence', () => {
  const { result } = runFixture('conflict-or-not');
  const region = result.report.regions[0];
  assert.equal(region.status, 'completed');
  assert.equal(region.conflict, true);
  const ids = region.candidates.map((c) => c.id);
  assert.ok(['blend', 'left', 'right'].every((id) => ids.includes(id)), `missing conflict candidates: ${ids}`);
  assert.equal(region.selectedCandidate, 'blend');
  assert.equal(region.confidence.level, 'low');
  assert.ok(region.hypotheses.some((h) => h.id === 'conflict'));
  // Confidence band must be an honest, non-degenerate interval.
  assert.ok(region.confidence.band.upperDb > region.confidence.band.lowerDb);
});

test('confidence band and estimate semantics are explicit', () => {
  const { result } = runFixture('clean-mid');
  const region = result.report.regions[0];
  assert.ok(region.confidence.estimatedErrorDb >= 1);
  assert.match(region.confidence.basis, /not a guarantee/);
  assert.match(result.report.semantics.estimated, /not recovered ground truth/);
});

test('model limits come from options and are reported', () => {
  const fx = byId.get('harmonic-short');
  const regions = fx.regions.map(({ startSec, endSec, lowHz, highHz }) => ({ startSec, endSec, lowHz, highHz }));
  const result = completeBands({
    audio: fx.defective, sampleRate: fx.sampleRate, fftSize: FFT, hop: HOP, regions,
    options: { maxGapSeconds: 0.01 },
  });
  assert.equal(result.report.status, 'refused');
  assert.equal(result.report.limits.maxGapSeconds, 0.01);
  assert.ok(result.report.limits.maxGapHz === DEFAULT_LIMITS.maxGapHz);
});

test('kernel report never claims ground-truth recovery', () => {
  const { result } = runFixture('harmonic-short');
  const json = JSON.stringify(result.report);
  assert.doesNotMatch(json, /recovered original/i);
  assert.match(result.report.semantics.estimated, /estimate|not recovered/i);
});
