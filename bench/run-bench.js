// Ground-truth bench: run every synthetic fixture through the kernel, then
// score the result against the withheld truth track.
//
// Truth isolation is structural: completeBands() receives only `defective`.
// evaluateCompletion() is the sole truth-aware call and runs afterwards.

import { buildFixtures, FFT, HOP } from '../src/fixtures/generate.js';
import { completeBands } from '../src/kernel/complete.js';
import { evaluateCompletion } from '../src/eval/evaluate.js';

const fixtures = buildFixtures();
const rows = [];

for (const fx of fixtures) {
  const regions = fx.regions.map(({ startSec, endSec, lowHz, highHz }) => ({ startSec, endSec, lowHz, highHz }));
  const result = completeBands({
    audio: fx.defective,
    sampleRate: fx.sampleRate,
    fftSize: FFT,
    hop: HOP,
    regions,
    options: {},
  });
  const evaluation = evaluateCompletion({
    truth: fx.truth,
    defective: fx.defective,
    reconstructed: result.audio,
    result,
    sampleRate: fx.sampleRate,
    regions,
    fftSize: FFT,
    hop: HOP,
    observedToleranceDb: result.report.limits.observedToleranceDb,
  });

  const statusOk =
    (fx.expected === 'refused' && result.report.status === 'refused') ||
    (fx.expected === 'conflict' && result.report.regions[0]?.conflict === true) ||
    (fx.expected === 'supported' && result.report.regions[0]?.status === 'completed');

  const region = result.report.regions[0];

  rows.push({
    id: fx.id,
    expected: fx.expected,
    status: result.report.status,
    matched: statusOk,
    conflict: Boolean(region?.conflict),
    selected: region?.selectedCandidate ?? null,
    confidence: region?.confidence?.level ?? null,
    improvementDb: evaluation.regions[0]?.gap?.improvementDb ?? null,    correlation: evaluation.regions[0]?.gap?.correlation ?? null,
    copyImprovementDb: evaluation.regions[0]?.gap?.copyNeighbourImprovementDb ?? null,
    knownChangeDb: evaluation.regions[0]?.knownRegion?.bandChangeDb ?? null,
    knownWithin: evaluation.regions[0]?.knownRegion?.withinTolerance ?? null,
    outsideChanged: evaluation.regions[0]?.knownRegion?.outsideGapWindowSamplesChanged ?? null,
    crestIncrease: evaluation.regions[0]?.artifacts?.crestIncrease ?? null,
    elapsedMs: result.report.elapsedMs,
    evaluation,
  });
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined) return '—';
  if (!Number.isFinite(v)) return String(v);
  return v.toFixed(digits);
}

const headers = [
  'fixture', 'expect', 'status', 'match', 'chosen', 'conf',
  'improve_dB', 'corr', 'copy_dB', 'known_dB', 'known_ok', 'outside_smpl', 'crest+',
];
console.log(headers.join('\t'));
for (const r of rows) {
  console.log([
    r.id, r.expected, r.status, r.matched ? 'yes' : 'NO', r.selected ?? '—', r.confidence ?? '—',
    fmt(r.improvementDb), fmt(r.correlation, 3), fmt(r.copyImprovementDb),
    fmt(r.knownChangeDb, 1), r.knownChangeDb === null ? 'ident' : r.knownWithin ? 'yes' : 'NO',
    r.outsideChanged ?? '—', fmt(r.crestIncrease),
  ].join('\t'));
}

const completed = rows.filter((r) => r.improvementDb !== null);
const worst = completed.length ? Math.min(...completed.map((r) => r.improvementDb)) : null;
const mean = completed.length ? completed.reduce((a, r) => a + r.improvementDb, 0) / completed.length : null;
const violations = rows.filter((r) => r.knownWithin === false || (r.outsideChanged ?? 0) > 0);
const mismatches = rows.filter((r) => !r.matched);

console.log('');
console.log(`completed regions : ${completed.length}/${rows.length}`);
console.log(`worst improvement : ${fmt(worst)} dB`);
console.log(`mean improvement  : ${fmt(mean)} dB`);
console.log(`known-region violations: ${violations.length}`);
console.log(`expectation mismatches : ${mismatches.length}`);
if (violations.length) console.log('  violations:', violations.map((r) => r.id).join(', '));
if (mismatches.length) console.log('  mismatched:', mismatches.map((r) => `${r.id}(${r.status})`).join(', '));

const ok = violations.length === 0 && mismatches.length === 0;
process.exitCode = ok ? 0 : 1;
