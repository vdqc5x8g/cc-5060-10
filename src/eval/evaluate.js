// Held-out evaluation. This module is the ONLY place that touches synthetic
// ground truth. The kernel never imports it, and the serve path only calls it
// when the request explicitly supplies a truth track that was *not* used as the
// kernel input.
//
// Rules enforced here:
//  * Truth is a separate audio track; the kernel input is the defective track.
//  * Metrics never mix known (observed) and unknown (masked) cells.
//  * A "silence baseline" (leave the hole empty) and a "neighbour copy baseline"
//    are reported so improvement is not confused with adding energy.
//  * Loudness/artifact checks measure the whole output, not just the gap.

import { stft, istft } from '../kernel/stft.js';

const DB = (x) => 20 * Math.log10(Math.max(x, 1e-12));

function segEnergy(x, start, end) {
  let e = 0;
  for (let i = Math.max(0, start); i < Math.min(x.length, end); i++) e += x[i] * x[i];
  return e;
}

function snrDb(targetEnergy, errEnergy) {
  if (errEnergy <= 0) return 300;
  if (targetEnergy <= 0) return -300;
  return 10 * Math.log10(targetEnergy / errEnergy);
}

export function bandlimit(x, sampleRate, lowHz, highHz, fftSize = 1024, hop = 256) {
  const spec = stft(x, { fftSize, hop, sampleRate });
  const b0 = Math.max(1, Math.round(lowHz / spec.binHz));
  const b1 = Math.min(spec.bins - 2, Math.round(highHz / spec.binHz));
  const re = spec.re.map((r) => Float64Array.from(r));
  const im = spec.im.map((r) => Float64Array.from(r));
  for (let m = 0; m < spec.frames; m++) {
    for (let b = 0; b < spec.bins; b++) {
      if (b < b0 || b > b1) { re[m][b] = 0; im[m][b] = 0; }
    }
  }
  return istft({ ...spec, re, im });
}

function framesOverlapping(spec, startSec, endSec) {
  const frames = [];
  for (let m = 0; m < spec.frames; m++) {
    const center = spec.frameTimes[m];
    if (center + spec.fftSize / 2 / spec.sampleRate < startSec) continue;
    if (center - spec.fftSize / 2 / spec.sampleRate > endSec) continue;
    frames.push(m);
  }
  return frames;
}

function bandSpecDiffDb(a, b, frameList, b0, b1) {
  let num = 0, den = 0;
  for (const m of frameList) {
    for (let bx = b0; bx <= b1; bx++) {
      const dr = a.re[m][bx] - b.re[m][bx];
      const di = a.im[m][bx] - b.im[m][bx];
      num += dr * dr + di * di;
      den += b.re[m][bx] ** 2 + b.im[m][bx] ** 2;
    }
  }
  return den > 0 ? 10 * Math.log10(num / den) : -300;
}

function overallSpecDiffDb(a, b) {
  let num = 0, den = 0;
  const frames = Math.min(a.frames, b.frames);
  for (let m = 0; m < frames; m++) {
    for (let bx = 0; bx < a.bins; bx++) {
      const dr = a.re[m][bx] - b.re[m][bx];
      const di = a.im[m][bx] - b.im[m][bx];
      num += dr * dr + di * di;
      den += b.re[m][bx] ** 2 + b.im[m][bx] ** 2;
    }
  }
  return den > 0 ? 10 * Math.log10(num / den) : -300;
}

function finiteDb(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

function geometryMask(spec, g) {
  const mask = Array.from({ length: spec.frames }, () => new Uint8Array(spec.bins));
  for (let m = Math.max(0, g.frameStart); m <= Math.min(spec.frames - 1, g.frameEnd); m++) {
    for (let b = Math.max(0, g.binStart); b <= Math.min(spec.bins - 1, g.binEnd); b++) mask[m][b] = 1;
  }
  return mask;
}

function crest(x, start, end) {
  let peak = 0, sum = 0, n = 0;
  for (let i = Math.max(0, start); i < Math.min(x.length, end); i++) {
    peak = Math.max(peak, Math.abs(x[i]));
    sum += x[i] * x[i];
    n++;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  return rms > 0 ? peak / rms : 0;
}

// Flat-copy the masked band from the nearest unmasked neighbour in time. This is
// the "cheat" baseline the brief forbids; it is computed for reporting only.
function copyNeighbourBaseline({ spec, mask, g, sampleRate, fftSize, hop }) {
  const re = spec.re.map((row) => Float64Array.from(row));
  const im = spec.im.map((row) => Float64Array.from(row));
  const leftM = g.frameStart - 1;
  const rightM = g.frameEnd + 1;
  for (let m = g.frameStart; m <= g.frameEnd; m++) {
    for (let b = g.binStart; b <= g.binEnd; b++) {
      if (!mask[m]?.[b]) continue;
      const useLeft = leftM >= 0 && (rightM >= spec.frames || (m - g.frameStart) <= (g.frameEnd - m));
      const srcM = useLeft ? leftM : rightM;
      re[m][b] = re[srcM][b];
      im[m][b] = im[srcM][b];
    }
  }
  return istft({ ...spec, re, im });
}

export function evaluateCompletion({
  truth, defective, reconstructed, result, sampleRate, regions,
  fftSize = 1024, hop = 256, observedToleranceDb = -40,
}) {
  if (!truth || !defective || !reconstructed) throw new Error('evaluateCompletion requires truth, defective and reconstructed audio');
  if (truth.length !== defective.length) throw new Error('truth must share the defective recording length');
  const specTruth = stft(truth, { fftSize, hop, sampleRate });
  const specOut = stft(reconstructed, { fftSize, hop, sampleRate });
  const specDef = stft(defective, { fftSize, hop, sampleRate });
  const attributed = result.attributedFrames;
  const regionsOut = [];

  for (const region of result.report.regions) {
    if (region.status !== 'completed') continue;
    const g = region.geometry;
    const b0 = g.binStart;
    const b1 = g.binEnd;
    const gapFrames = framesOverlapping(specTruth, g.startSec, g.endSec);
    const nStart = Math.max(0, g.frameStart * hop - specTruth.padLeft);
    const nEnd = Math.min(truth.length, g.frameEnd * hop - specTruth.padLeft + fftSize);

    const bandTruth = bandlimit(truth, sampleRate, g.lowHz, g.highHz, fftSize, hop);
    const bandOut = bandlimit(reconstructed, sampleRate, g.lowHz, g.highHz, fftSize, hop);
    const bandDef = bandlimit(defective, sampleRate, g.lowHz, g.highHz, fftSize, hop);

    const truthBandEnergy = segEnergy(bandTruth, nStart, nEnd);
    const outErr = [];
    const defErr = [];
    for (let i = nStart; i < nEnd; i++) {
      if (i < 0 || i >= truth.length) continue;
      outErr.push(bandOut[i] - bandTruth[i]);
      defErr.push(bandDef[i] - bandTruth[i]);
    }
    const outErrEnergy = outErr.reduce((a, v) => a + v * v, 0);
    const defErrEnergy = defErr.reduce((a, v) => a + v * v, 0);

    // Baseline that simply copies the neighbouring band: it confirms a good
    // score is not just duplicated nearby content.
    const copyBaseline = copyNeighbourBaseline({
      spec: specDef,
      mask: geometryMask(specDef, g),
      g, sampleRate, fftSize, hop,
    });
    let copyErrEnergy = null;
    let copyImprovementDb = null;
    if (copyBaseline) {
      const bandCopy = bandlimit(copyBaseline, sampleRate, g.lowHz, g.highHz, fftSize, hop);
      let e = 0;
      for (let i = nStart; i < nEnd; i++) {
        if (i < 0 || i >= truth.length) continue;
        e += (bandCopy[i] - bandTruth[i]) ** 2;
      }
      copyErrEnergy = e;
      copyImprovementDb = Number((snrDb(truthBandEnergy, e) - snrDb(truthBandEnergy, defErrEnergy)).toFixed(2));
    }

    // Correlated-signal improvement is capped: we also report correlation so a
    // large SNR caused by matching energy but wrong phase cannot be mistaken
    // for recovered content.
    let xy = 0, xx = 0, yy = 0;
    for (let i = nStart; i < nEnd; i++) {
      if (i < 0 || i >= truth.length) continue;
      xy += bandOut[i] * bandTruth[i];
      xx += bandTruth[i] * bandTruth[i];
      yy += bandOut[i] * bandOut[i];
    }
    const correlation = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;

    const knownFrames = [];
    for (let m = 0; m < specTruth.frames; m++) {
      if (attributed && attributed[m]) continue;
      knownFrames.push(m);
    }
    const knownBandChangeDb = knownFrames.length
      ? bandSpecDiffDb(specOut, specDef, knownFrames, 0, specTruth.bins - 1)
      : -300;
    // Outside the gap window the output must be sample-identical to the input.
    let outsideChanged = 0;
    let outsideMax = 0;
    for (let i = 0; i < reconstructed.length; i++) {
      if (i >= nStart && i < nEnd) continue;
      const d = Math.abs(reconstructed[i] - defective[i]);
      if (d > 0) outsideChanged++;
      if (d > outsideMax) outsideMax = d;
    }

    // Artifact checks over the full file.
    const wholeChangeDb = overallSpecDiffDb(specOut, specDef);
    const crestOut = crest(reconstructed, 0, reconstructed.length);
    const crestDef = crest(defective, 0, defective.length);

    const maskedMagErr = bandSpecDiffDb(specOut, specTruth, gapFrames, b0, b1);
    const defectMagErr = bandSpecDiffDb(specDef, specTruth, gapFrames, b0, b1);

    regionsOut.push({
      startSec: g.startSec,
      endSec: g.endSec,
      lowHz: g.lowHz,
      highHz: g.highHz,
      gap: {
        bandSnrOutDb: Number(snrDb(truthBandEnergy, outErrEnergy).toFixed(2)),
        bandSnrDefectDb: Number(snrDb(truthBandEnergy, defErrEnergy).toFixed(2)),
        improvementDb: Number((snrDb(truthBandEnergy, outErrEnergy) - snrDb(truthBandEnergy, defErrEnergy)).toFixed(2)),
        correlation: Number(correlation.toFixed(3)),
        maskedMagnitudeErrorDb: Number(maskedMagErr.toFixed(2)),
        defectMagnitudeErrorDb: Number(defectMagErr.toFixed(2)),
        copyNeighbourImprovementDb: copyImprovementDb,
        copyNeighbourBeatsCompletion: copyImprovementDb !== null && copyImprovementDb > (snrDb(truthBandEnergy, outErrEnergy) - snrDb(truthBandEnergy, defErrEnergy)),
        metricBasis: `band-limited to ${g.lowHz.toFixed(0)}–${g.highHz.toFixed(0)} Hz, gap span only; correlation reported to expose phase-blind energy`,
      },
      knownRegion: {
        maxAbsChange: Number(region.audit?.outsideAffectedSpanMaxAbs?.toFixed(6) ?? 0),
        outsideGapWindowSamplesChanged: region.audit?.outsideAffectedSpanNonZeroSamples ?? null,
        bandChangeDb: finiteDb(knownBandChangeDb),
        knownFramesIdentical: !Number.isFinite(knownBandChangeDb),
        outsideGapWindowSamplesChanged: outsideChanged,
        outsideGapWindowMaxAbs: Number(outsideMax.toExponential(3)),
        toleranceDb: observedToleranceDb,
        withinTolerance: knownBandChangeDb <= observedToleranceDb,
      },
      artifacts: {
        wholeFileChangeDb: Number(wholeChangeDb.toFixed(2)),
        crestOut: Number(crestOut.toFixed(2)),
        crestDefect: Number(crestDef.toFixed(2)),
        crestIncrease: Number((crestOut - crestDef).toFixed(2)),
      },
      caveat: 'The algorithm never saw this truth track. These numbers measure how a hypothesis compares with withheld material; they do not certify general performance.',
    });
  }

  const gated = regionsOut.map((r) => r.gap.improvementDb);
  return {
    truthUsedFor: 'evaluation-only (held out from kernel input)',
    regions: regionsOut,
    summary: {
      worstImprovementDb: gated.length ? Math.min(...gated) : null,
      meanImprovementDb: gated.length ? Number((gated.reduce((a, b) => a + b, 0) / gated.length).toFixed(2)) : null,
      anyKnownRegionViolation: regionsOut.some((r) => !r.knownRegion.withinTolerance),
      note: 'Improvement over leaving the hole silent; correlation near 0 means the energy does not align with withheld content.',
    },
  };
}
