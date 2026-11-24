// Independent reference for trusted-region verification.
//
// Everything here is derived from first principles with the STFT primitives
// only. It deliberately imports neither the kernel (complete.js) nor any
// ground-truth track, so acceptance expectations cannot silently reuse the
// quantities they are supposed to check.
//
// Three quantities, each answerable without the pre-gap truth:
//   1. known-region error  : does the output move any OBSERVED cell/sample?
//   2. candidate divergence : how far apart are the competing hypotheses?
//   3. subband conservation  : does energy in reference subbands survive?
//
// A fourth module (projection-limit.js) uses the same primitives to test where
// an error lower bound derived from independent projections is valid.

import { stft } from '../kernel/stft.js';

function energyDb(num, den) {
  if (den <= 0) return num <= 0 ? 300 : -300;
  const v = 10 * Math.log10(num / den);
  return Number.isFinite(v) ? v : (v < 0 ? -300 : 300);
}

function complexEnergy(spec, frameSet, binSet) {
  let e = 0;
  for (const m of frameSet) {
    const rowRe = spec.re[m];
    const rowIm = spec.im[m];
    for (const b of binSet) e += rowRe[b] * rowRe[b] + rowIm[b] * rowIm[b];
  }
  return e;
}

function range(n, lo, hi) {
  const out = [];
  for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) out.push(i);
  return out;
}

// 1. Known-region (observed) error.
//
// Compares the output STFT against the *defective* recording's STFT over
// observed cells. The defective recording is the legitimate observation, so no
// truth is involved. `excludedFrames` marks analysis windows whose STFT
// overlaps the mask (the kernel's attributed frames): outside them the output
// must be sample-identical; inside them observed bins may only move within the
// declared tolerance.
export function knownRegionError({ defective, reconstructed, mask, attributedFrames, fftSize, hop, sampleRate }) {
  const specDef = stft(defective, { fftSize, hop, sampleRate });
  const specOut = stft(reconstructed, { fftSize, hop, sampleRate });
  const frames = Math.min(specDef.frames, specOut.frames);
  const bins = specDef.bins;
  let nearNum = 0, nearDen = 0, farNum = 0, farDen = 0, changedSamples = 0, maxAbs = 0;
  let poolNum = 0, poolDen = 0;
  for (let m = 0; m < frames; m++) {
    const attributed = attributedFrames ? attributedFrames[m] === 1 : false;
    for (let b = 0; b < bins; b++) {
      if (mask[m]?.[b]) continue;
      const dr = specOut.re[m][b] - specDef.re[m][b];
      const di = specOut.im[m][b] - specDef.im[m][b];
      const d2 = dr * dr + di * di;
      const e2 = specDef.re[m][b] ** 2 + specDef.im[m][b] ** 2;
      poolNum += d2; poolDen += e2;
      if (attributed) { nearNum += d2; nearDen += e2; }
      else { farNum += d2; farDen += e2; }
    }
  }
  const n = Math.min(reconstructed.length, defective.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(reconstructed[i] - defective[i]);
    if (d > 0) changedSamples++;
    if (d > maxAbs) maxAbs = d;
  }
  const pooledDb = energyDb(poolNum, poolDen);
  const adjacentDb = energyDb(nearNum, nearDen);
  const untouchedDb = energyDb(farNum, farDen);
  return {
    observedChangeDb: pooledDb,
    pooledObservedChangeDb: pooledDb,
    adjacentOverlapChangeDb: Number(adjacentDb.toFixed(2)),
    outsideWindowChangeDb: Number(untouchedDb.toFixed(2)),
    outsideWindowUntouched: untouchedDb <= -120,
    changedSamples,
    maxAbsSampleChange: Number(maxAbs.toExponential(3)),
    basis: 'output STFT vs defective STFT over observed cells; no truth track used',
  };
}

// 2. Candidate divergence.
//
// Given the per-region magnitude grids produced by independent kernel
// hypotheses (each built only from left context, right context, or both),
// measure how mutually exclusive they are. Large divergence on unidentifiable
// material is expected; a falsely over-confident single answer would suppress
// it. Magnitudes are normalized so the score compares shapes, not absolute
// loudness. The kernel's own confidence labels are not used.
export function candidateDivergence(candidateGrids) {
  const grids = candidateGrids.filter((g) => g && g.length && g[0].length);
  if (grids.length < 2) {
    return { pairs: [], maxDb: 0, meanDb: 0, span: 0, basis: 'single candidate: divergence undefined' };
  }
  const norm = (g) => {
    let e = 0;
    for (const row of g) for (const v of row) e += v * v;
    return Math.sqrt(e || 1);
  };
  const scales = grids.map(norm);
  const pairs = [];
  let sumDb = 0;
  let maxDb = -Infinity;
  let maxSpan = 0;
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const a = grids[i];
      const b = grids[j];
      let num = 0;
      let dot = 0;
      let ea = 0;
      let eb = 0;
      let peakA = 0;
      let peakB = 0;
      for (let y = 0; y < a.length; y++) {
        for (let x = 0; x < a[0].length; x++) {
          const va = a[y][x] / scales[i];
          const vb = b[y][x] / scales[j];
          const d = va - vb;
          num += d * d;
          dot += va * vb;
          ea += va * va;
          eb += vb * vb;
          peakA = Math.max(peakA, va);
          peakB = Math.max(peakB, vb);
        }
      }
      const cosine = ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0;
      const diffDb = 10 * Math.log10(Math.max(num, 1e-12));
      pairs.push({ i, j, normalizedDiffDb: Number(diffDb.toFixed(2)), cosine: Number(cosine.toFixed(4)) });
      sumDb += diffDb;
      maxDb = Math.max(maxDb, diffDb);
      maxSpan = Math.max(maxSpan, Math.abs(peakA - peakB));
    }
  }
  return {
    pairs,
    maxDb: Number(maxDb.toFixed(2)),
    meanDb: Number((sumDb / pairs.length).toFixed(2)),
    span: Number(maxSpan.toFixed(4)),
    basis: 'normalized pairwise magnitude-grid distance between independent hypotheses; confidence labels ignored',
  };
}

// 3. Subband conservation (the trusted-subband conservation reference).
//
// Reference subbands are observed energy compartments whose analysis windows
// never overlap the mask (the kernel's attributed frames), so overlap-add of
// the repair cannot reach them:
//   timeRef    : the gap's frequency band in clean frames before and after the
//                mask window (same content band, different time)
//   freqRef    : neighbouring frequency bins below and above the gap in the
//                same clean time columns (same time neighbourhood, other band)
// Conservation compares defective vs output energy in each compartment. A
// completion that fabricates or destroys energy in an observed compartment
// fails conservation regardless of its internal self-audit.
export function subbandConservation({ defective, reconstructed, grid, fftSize, hop, sampleRate, attributedFrames, guardFrames = 3 }) {
  const specDef = stft(defective, { fftSize, hop, sampleRate });
  const specOut = stft(reconstructed, { fftSize, hop, sampleRate });
  const { frameStart, frameEnd, binStart, binEnd } = grid;
  const bandWidth = binEnd - binStart + 1;
  const clean = (m) => !(attributedFrames && attributedFrames[m] === 1);
  const cleanFramesAround = [];
  for (let m = 0; m < specDef.frames; m++) {
    if (clean(m) && (m < frameStart - guardFrames || m > frameEnd + guardFrames)) cleanFramesAround.push(m);
  }
  const gapBins = range(specDef.bins, binStart, binEnd);
  const neighbourBins = [
    ...range(specDef.bins, binStart - 1 - bandWidth, binStart - 1),
    ...range(specDef.bins, binEnd + 1, binEnd + bandWidth),
  ];
  const compartments = [
    { name: 'timeRef', frames: cleanFramesAround, bins: gapBins },
    { name: 'freqRef', frames: cleanFramesAround, bins: neighbourBins },
  ];
  const results = [];
  let worstDb = -Infinity;
  for (const c of compartments) {
    if (!c.frames.length || !c.bins.length) {
      results.push({ name: c.name, conservationDb: null, defectiveEnergy: 0, outputEnergy: 0, skipped: true });
      continue;
    }
    const eDef = complexEnergy(specDef, c.frames, c.bins);
    const eOut = complexEnergy(specOut, c.frames, c.bins);
    const rawDb = eDef > 0 ? 10 * Math.log10(Math.abs(eOut - eDef) / eDef) : (eOut === 0 ? 300 : -300);
    const db = Number.isFinite(rawDb) ? rawDb : (rawDb < 0 ? -300 : 300);
    results.push({
      name: c.name,
      conservationDb: Number(energyDb(Math.abs(eOut - eDef), eDef).toFixed(2)),
      defectiveEnergy: Number(eDef.toExponential(4)),
      outputEnergy: Number(eOut.toExponential(4)),
      skipped: false,
    });
    worstDb = Math.max(worstDb, db);
  }
  return {
    compartments: results,
    worstConservationDb: Number(worstDb.toFixed(2)),
    cleanFrameCount: cleanFramesAround.length,
    basis: 'observed-compartment energy in mask-window-free frames, before vs after reconstruction; gap cells excluded',
  };
}

// 4. Fill consistency.
//
// Independently reconstructs the magnitude grid the kernel *claimed* (its
// chosen target) and compares it with the magnitude actually present in the
// output STFT over the masked cells. A wrong-fill mutation that scrambles the
// gap while pinning observed cells leaves known-region error clean but breaks
// this check. Target and output come through different code paths, so this is
// not a self-comparison.
export function fillConsistency({ reconstructed, target, grid, fftSize, hop, sampleRate }) {
  const specOut = stft(reconstructed, { fftSize, hop, sampleRate });
  let num = 0;
  let den = 0;
  let peak = 0;
  for (let m = grid.frameStart; m <= grid.frameEnd; m++) {
    for (let b = grid.binStart; b <= grid.binEnd; b++) {
      const claimed = target[m]?.[b] ?? 0;
      const actual = Math.hypot(specOut.re[m][b], specOut.im[m][b]);
      num += (actual - claimed) ** 2;
      den += claimed * claimed;
      peak = Math.max(peak, claimed);
    }
  }
  const db = energyDb(num, den);
  return {
    fillResidualDb: Number(db.toFixed(2)),
    targetPeak: Number(peak.toExponential(3)),
    basis: 'output masked-cell magnitude vs kernel-declared target grid; observed cells excluded',
  };
}
