// Constrained time-frequency band completion.
//
// The kernel only ever receives the defective recording and the declared mask.
// It has no access to any ground truth; evaluate.js is a separate, truth-aware
// module used by the bench.
//
// Pipeline per connected masked region:
//   1. Validate against explicit model limits (gap length/width, real context
//      on both sides). Outside the limits the region is refused, not filled.
//   2. Build candidate content models from observed context only:
//        - harmonic: matched partial tracks continued across the gap
//        - continuity: per-frequency-bin magnitude interpolated in time
//        - left/right: one-sided extrapolations, kept for conflicting evidence
//   3. Detect mutually exclusive left/right continuation and expose both
//      candidates with confidence bounds instead of pretending a single truth.
//   4. Reconstruct a waveform with constrained iterative phase retrieval:
//      observed STFT bins are held fixed every iteration, masked bins follow the
//      selected magnitude model, then the result is re-projected and audited.
//
// Terminology used in reports: filled cells are *estimates*, never "recovered
// original facts". Cells outside the mask are *observed*.

import { stft, istft } from './stft.js';
import {
  magnitudeGrid, db, median, findPeaks, trackPartials, measurePhaseAdvance,
} from './analyze.js';

export const KERNEL_VERSION = '1.0.0';

export const DEFAULT_LIMITS = Object.freeze({
  maxGapSeconds: 0.2,
  maxGapHz: 1500,
  minContextFrames: 4,
  maxIterations: 80,
  observedToleranceDb: -30,
  previewIterations: 12,
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function copyGrid(grid) { return grid.map((row) => Float64Array.from(row)); }
function zerosGrid(frames, bins) { return Array.from({ length: frames }, () => new Float64Array(bins)); }

export function framesForRegions(spec, regions, options = {}) {
  const { sampleRate, hop, frames, bins, frameTimes } = spec;
  const duration = spec.length / sampleRate;
  const firstContent = frameTimes.findIndex((t) => t >= 0 && t <= duration);
  let lastContent = -1;
  for (let m = frames - 1; m >= 0; m--) if (frameTimes[m] >= 0 && frameTimes[m] <= duration) { lastContent = m; break; }
  if (firstContent < 0 || lastContent < firstContent) throw new Error('audio is too short for analysis');
  const out = [];
  const notes = [];
  for (const [i, region] of regions.entries()) {
    const startSec = Number(region.startSec);
    const endSec = Number(region.endSec);
    const lowHz = Number(region.lowHz);
    const highHz = Number(region.highHz);
    if (![startSec, endSec, lowHz, highHz].every(Number.isFinite)) {
      throw new Error(`region ${i}: startSec/endSec/lowHz/highHz must be finite numbers`);
    }
    if (endSec <= startSec) throw new Error(`region ${i}: endSec must exceed startSec`);
    if (highHz <= lowHz) throw new Error(`region ${i}: highHz must exceed lowHz`);
    let m0 = frames;
    for (let m = 0; m < frames; m++) if (frameTimes[m] >= startSec) { m0 = m; break; }
    let m1 = -1;
    for (let m = frames - 1; m >= 0; m--) if (frameTimes[m] <= endSec) { m1 = m; break; }
    m0 = clamp(m0, firstContent, lastContent);
    m1 = clamp(m1, firstContent, lastContent);
    if (m1 < m0) throw new Error(`region ${i}: time span contains no analysis frame`);
    let b0 = Math.round(lowHz / spec.binHz);
    let b1 = Math.round(highHz / spec.binHz);
    const rawB0 = b0;
    const rawB1 = b1;
    b0 = clamp(b0, 1, bins - 2);
    b1 = clamp(b1, 1, bins - 2);
    if (b1 < b0) throw new Error(`region ${i}: frequency span contains no usable bin`);
    if (rawB0 < 1 || rawB1 > bins - 2) {
      notes.push(`region ${i}: DC/Nyquist edge bins excluded from mask`);
    }
    out.push({
      frameStart: m0, frameEnd: m1, binStart: b0, binEnd: b1,
      startSec: frameTimes[m0], endSec: frameTimes[m1],
      lowHz: b0 * spec.binHz, highHz: b1 * spec.binHz,
    });
  }
  return { regions: out, notes, firstContent, lastContent };
}

export function maskFromRegions(spec, regionGrids) {
  const mask = Array.from({ length: spec.frames }, () => new Uint8Array(spec.bins));
  for (const r of regionGrids) {
    for (let m = r.frameStart; m <= r.frameEnd; m++) {
      for (let b = r.binStart; b <= r.binEnd; b++) mask[m][b] = 1;
    }
  }
  return mask;
}

export function connectedRegions(mask) {
  const frames = mask.length;
  const bins = mask[0]?.length ?? 0;
  const seen = new Uint8Array(frames * bins);
  const regions = [];
  const idx = (m, b) => m * bins + b;
  for (let m = 0; m < frames; m++) {
    for (let b = 0; b < bins; b++) {
      if (!mask[m][b] || seen[idx(m, b)]) continue;
      const stack = [[m, b]];
      seen[idx(m, b)] = 1;
      let f0 = m; let f1 = m; let b0 = b; let b1 = b; let count = 0;
      while (stack.length) {
        const [mm, bb] = stack.pop();
        count++;
        f0 = Math.min(f0, mm); f1 = Math.max(f1, mm);
        b0 = Math.min(b0, bb); b1 = Math.max(b1, bb);
        for (const [dm, db2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nm = mm + dm; const nb = bb + db2;
          if (nm < 0 || nb < 0 || nm >= frames || nb >= bins) continue;
          if (!mask[nm][nb] || seen[idx(nm, nb)]) continue;
          seen[idx(nm, nb)] = 1;
          stack.push([nm, nb]);
        }
      }
      regions.push({ frameStart: f0, frameEnd: f1, binStart: b0, binEnd: b1, cellCount: count });
    }
  }
  return regions;
}

// Mask frames leak into neighbouring analysis frames through the STFT window,
// so the first truly observed row sits `guard` frames outside the mask.
function guardFrames(spec) {
  return Math.max(2, Math.ceil(spec.fftSize / (2 * spec.hop)));
}

function contextFrame(spec, region, side, guard) {
  const m = side === -1 ? region.frameStart - guard : region.frameEnd + guard;
  return Math.max(0, Math.min(spec.frames - 1, m));
}

function boundaryRows(mag, region, spec, guard) {
  const mL = contextFrame(spec, region, -1, guard);
  const mR = contextFrame(spec, region, 1, guard);
  const offL = region.frameStart - mL;
  const offR = mR - region.frameEnd;
  const left = mag[mL]
    ? Float64Array.from(mag[mL].subarray(region.binStart, region.binEnd + 1))
    : null;
  const right = mag[mR]
    ? Float64Array.from(mag[mR].subarray(region.binStart, region.binEnd + 1))
    : null;
  return { left, right, frameL: mL, frameR: mR, offsetL: offL, offsetR: offR };
}

function smoothRow(row, sigmaBins = 1.6) {
  const out = new Float64Array(row.length);
  const reach = Math.ceil(sigmaBins * 3);
  for (let i = 0; i < row.length; i++) {
    let num = 0; let den = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = i + k;
      if (j < 0 || j >= row.length) continue;
      const w = Math.exp(-0.5 * (k / sigmaBins) ** 2);
      num += row[j] * w; den += w;
    }
    out[i] = num / den;
  }
  return out;
}

function rowStats(L, R) {
  L = smoothRow(L);
  R = smoothRow(R);
  const width = L.length;
  let dot = 0; let nL = 0; let nR = 0; let sumSq = 0; let count = 0; let peak = 0;
  for (let i = 0; i < width; i++) {
    const l = L[i]; const r = R[i];
    dot += l * r; nL += l * l; nR += r * r;
    peak = Math.max(peak, l, r);
  }
  const floor = Math.max(peak * 1e-4, 1e-10);
  for (let i = 0; i < width; i++) {
    if (Math.max(L[i], R[i]) <= floor) continue;
    const d = db(L[i]) - db(R[i]);
    sumSq += d * d; count++;
  }
  const corr = nL > 0 && nR > 0 ? dot / Math.sqrt(nL * nR) : 0;
  return {
    corr,
    rmsDiffDb: count ? Math.sqrt(sumSq / count) : 0,
    energyL: nL,
    energyR: nR,
    floor,
    weightedBins: count,
  };
}

function buildBlend(left, right) {
  return left.map((row, y) => row.map((v, x) => 0.5 * (v + right[y][x])));
}

function buildContinuity(region, L, R, side = 'both') {  const height = region.frameEnd - region.frameStart + 1;
  const width = region.binEnd - region.binStart + 1;
  const target = Array.from({ length: height }, () => new Float64Array(width));
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0.5;
    for (let x = 0; x < width; x++) {
      if (side === 'left') target[y][x] = L ? L[x] : 0;
      else if (side === 'right') target[y][x] = R ? R[x] : 0;
      else target[y][x] = (L ? L[x] * (1 - t) : 0) + (R ? R[x] * t : 0);
    }
  }
  return target;
}

function matchPartials(left, right, region) {
  const mid = (region.frameStart + region.frameEnd) / 2;
  const used = new Set();
  const matches = [];
  for (const l of left) {
    const predMid = l.freqAt(mid);
    let best = -1; let bestD = Infinity;
    for (let i = 0; i < right.length; i++) {
      if (used.has(i)) continue;
      const r = right[i];
      const d = Math.abs(r.freqAt(mid) - predMid);
      const ampDiff = Math.abs(db(l.boundaryMag) - db(r.boundaryMag));
      if (d < bestD && ampDiff <= 12) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= 1.6) {
      used.add(best);
      matches.push({ left: l, right: right[best], freqGapBins: bestD });
    }
  }
  return matches;
}

function buildHarmonic(region, matches, spec) {
  const height = region.frameEnd - region.frameStart + 1;
  const width = region.binEnd - region.binStart + 1;
  const target = Array.from({ length: height }, () => new Float64Array(width));
  const coverage = new Uint8Array(height);
  const sigmaBins = 0.85;
  for (const pair of matches) {
    for (let y = 0; y < height; y++) {
      const m = region.frameStart + y;
      const t = height > 1 ? y / (height - 1) : 0.5;
      const fL = pair.left.freqAt(m);
      const fR = pair.right.freqAt(m);
      const freqBin = fL * (1 - t) + fR * t;
      const dbVal = pair.left.dbAt(m) * (1 - t) + pair.right.dbAt(m) * t;
      const magVal = Math.pow(10, dbVal / 20);
      if (freqBin < region.binStart - 2 || freqBin > region.binEnd + 2) continue;
      coverage[y] = 1;
      for (let x = 0; x < width; x++) {
        const bin = region.binStart + x;
        const d = (bin - freqBin) / sigmaBins;
        const v = magVal * Math.exp(-0.5 * d * d);
        if (v > target[y][x]) target[y][x] = v;
      }
    }
  }
  const freqResidual = matches.length
    ? median(matches.map((p) => Math.abs(p.freqGapBins)))
    : 0;
  return { target, coverage: coverage.reduce((a, b) => a + b, 0) / height, freqResidual };
}

function harmonicity(rows) {
  // Fraction of band energy explained by the strongest few local peaks.
  const L = rows.left;
  const R = rows.right;
  const combined = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) combined[i] = Math.max(L[i], R[i]);
  const peakScale = Math.max(...combined) * 1e-3;
  const peaks = findPeaks(combined, 0, combined.length - 1, peakScale)
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 6);
  let total = 0;
  for (const v of combined) total += v * v;
  let peakEnergy = 0;
  const widthBins = 1.5;
  for (const p of peaks) {
    for (let i = 0; i < combined.length; i++) {
      const d = (i - p.bin) / widthBins;
      if (Math.abs(d) < 2) peakEnergy += Math.pow(combined[i] * Math.exp(-0.5 * d * d), 2);
    }
  }
  return total > 0 ? clamp(peakEnergy / total, 0, 1) : 0;
}

function buildConfidence(region, mag, target, agreement, selectedIsConflict) {
  const height = region.frameEnd - region.frameStart + 1;
  const width = region.binEnd - region.binStart + 1;
  const conf = Array.from({ length: height }, () => new Float64Array(width));
  const base = clamp(1 - agreement.rmsDiffDb / 20, 0.15, 1) * (selectedIsConflict ? 0.45 : 1);
  let peak = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) peak = Math.max(peak, target[y][x]);
  const floor = Math.max(peak * 1e-3, agreement.floor);
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0.5;
    const distFactor = 0.55 + 0.45 * (1 - Math.abs(t - 0.5) * 2);
    for (let x = 0; x < width; x++) {
      const v = target[y][x];
      const energyFactor = v <= floor ? 0 : v / (v + floor);
      conf[y][x] = base * distFactor * (0.25 + 0.75 * energyFactor);
    }
  }
  return conf;
}

function regionCandidateSummary(id, label, description, target, extra = {}) {
  return { id, label, description, target, ...extra };
}

function cropStats(target, conf) {
  let sum = 0; let count = 0; let max = 0;
  for (let y = 0; y < target.length; y++) {
    for (let x = 0; x < target[0].length; x++) {
      if (target[y][x] > 0) { sum += conf[y][x]; count++; max = Math.max(max, conf[y][x]); }
    }
  }
  return { mean: count ? sum / count : 0, max, coveredCells: count };
}

export function analyzeAudio(audio, { sampleRate, fftSize = 1024, hop = 256 } = {}) {
  const spec = stft(audio, { fftSize, hop, sampleRate });
  const mag = magnitudeGrid(spec);
  return { spec, mag };
}

function regionGridGeometry(region, spec) {
  const gapFrames = region.frameEnd - region.frameStart + 1;
  const gapBins = region.binEnd - region.binStart + 1;
  return {
    gapFrames,
    gapBins,
    gapSeconds: (gapFrames * spec.hop) / spec.sampleRate,
    gapHz: gapBins * spec.binHz,
    startSec: spec.frameTimes[region.frameStart],
    endSec: spec.frameTimes[region.frameEnd],
    lowHz: region.binStart * spec.binHz,
    highHz: region.binEnd * spec.binHz,
    cellCount: gapFrames * gapBins,
  };
}

function validateRegion(region, geometry, ctx) {
  const { limits, spec, firstContent, lastContent } = ctx;
  const reasons = [];
  if (geometry.gapSeconds > limits.maxGapSeconds + 1e-9) {
    reasons.push(`gap duration ${(geometry.gapSeconds * 1000).toFixed(0)} ms exceeds supported limit ${(limits.maxGapSeconds * 1000).toFixed(0)} ms`);
  }
  if (geometry.gapHz > limits.maxGapHz + 1e-9) {
    reasons.push(`gap width ${geometry.gapHz.toFixed(0)} Hz exceeds supported limit ${limits.maxGapHz.toFixed(0)} Hz`);
  }
  const leftContext = region.frameStart - firstContent;
  const rightContext = lastContent - region.frameEnd;
  if (leftContext < limits.minContextFrames) {
    reasons.push(`only ${Math.max(0, leftContext)} observed frames on the left (needs ${limits.minContextFrames})`);
  }
  if (rightContext < limits.minContextFrames) {
    reasons.push(`only ${Math.max(0, rightContext)} observed frames on the right (needs ${limits.minContextFrames})`);
  }
  return reasons;
}

function measureNeighbourPhase(spec, mask, m, b, dir, maxSteps = 40) {
  // Find one or two observed frames in the same bin on one side and estimate
  // phase and per-hop phase advance from them.
  let m1 = m + dir;
  let steps = 1;
  while (m1 >= 0 && m1 < spec.frames && steps <= maxSteps) {
    if (!mask[m1][b]) break;
    m1 += dir; steps++;
  }
  if (m1 < 0 || m1 >= spec.frames || mask[m1][b]) return null;
  const phase1 = Math.atan2(spec.im[m1][b], spec.re[m1][b]);
  const m2 = m1 + dir;
  let advance = 0;
  if (m2 >= 0 && m2 < spec.frames && !mask[m2][b]) {
    let d = Math.atan2(spec.im[m2][b], spec.re[m2][b]) - phase1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    advance = d * dir;
  }
  return { frame: m1, distance: steps, phase: phase1, advance };
}

function seedComplex(spec, mask, target) {
  const { frames, bins } = spec;
  const re = copyGrid(spec.re);
  const im = copyGrid(spec.im);
  for (let m = 0; m < frames; m++) {
    for (let b = 0; b < bins; b++) {
      if (!mask[m][b]) continue;
      const tgt = target[m][b] ?? 0;
      if (tgt <= 0) { re[m][b] = 0; im[m][b] = 0; continue; }
      const left = measureNeighbourPhase(spec, mask, m, b, -1);
      const right = measureNeighbourPhase(spec, mask, m, b, 1);
      let phase = 0;
      if (left && right) {
        const pL = left.phase + left.advance * left.distance;
        const pR = right.phase - right.advance * right.distance;
        let d = pR - pL;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const wL = 1 / (1 + left.distance);
        const wR = 1 / (1 + right.distance);
        phase = pL + (d * wR) / (wL + wR);
      } else if (left) phase = left.phase + left.advance * left.distance;
      else if (right) phase = right.phase - right.advance * right.distance;
      re[m][b] = tgt * Math.cos(phase);
      im[m][b] = tgt * Math.sin(phase);
    }
  }
  return { re, im };
}

export function reconstructConstrained({
  spec, mask, target, iterations = 40,
}) {
  const { frames, bins } = spec;
  const seeded = seedComplex(spec, mask, target);
  let audio = istft({ ...spec, re: seeded.re, im: seeded.im });
  let used = 0;
  for (let it = 1; it <= iterations; it++) {
    used = it;
    const S = stft(audio, { fftSize: spec.fftSize, hop: spec.hop, sampleRate: spec.sampleRate });
    const re = copyGrid(spec.re);
    const im = copyGrid(spec.im);
    const nF = Math.min(S.frames, frames);
    for (let m = 0; m < nF; m++) {
      for (let b = 0; b < bins; b++) {
        if (!mask[m][b]) continue;
        const tgt = target[m][b] ?? 0;
        if (tgt <= 0) { re[m][b] = 0; im[m][b] = 0; continue; }
        const phase = Math.atan2(S.im[m][b], S.re[m][b]);
        re[m][b] = tgt * Math.cos(phase);
        im[m][b] = tgt * Math.sin(phase);
      }
    }
    audio = istft({ ...spec, re, im });
  }
  // Final iteration pins observed cells to their measured complex values so
  // the returned waveform has exactly the original observation in its STFT.
  const S = stft(audio, { fftSize: spec.fftSize, hop: spec.hop, sampleRate: spec.sampleRate });
  const re = copyGrid(spec.re);
  const im = copyGrid(spec.im);
  const nF = Math.min(S.frames, frames);
  for (let m = 0; m < nF; m++) {
    for (let b = 0; b < bins; b++) {
      if (!mask[m][b]) continue;
      const tgt = target[m][b] ?? 0;
      if (tgt <= 0) { re[m][b] = 0; im[m][b] = 0; continue; }
      const phase = Math.atan2(S.im[m][b], S.re[m][b]);
      re[m][b] = tgt * Math.cos(phase);
      im[m][b] = tgt * Math.sin(phase);
    }
  }
  audio = istft({ ...spec, re, im });
  const finalSpec = stft(audio, { fftSize: spec.fftSize, hop: spec.hop, sampleRate: spec.sampleRate });
  return { audio, spec: finalSpec, iterationsUsed: used };
}

function auditReconstruction({ originalSpec, finalSpec, mask, target, attributed, defective, reconstructed, region, limits }) {
  const nF = Math.min(originalSpec.frames, finalSpec.frames);
  // Zone A: frames with no mask window overlap. These must be byte-for-byte
  // untouched; any change here is a defect in the reconstruction, not an
  // acceptable modelling error.
  let outNum = 0; let outDen = 0; let outMax = 0;
  // Zone B: frames whose window overlaps the mask. Cells outside the mask band
  // are still observed data, but the reconstruction is allowed slight movement
  // from overlap-add of the repaired cells.
  let nearNum = 0; let nearDen = 0; let nearMax = 0;
  let obsNum = 0; let obsDen = 0;
  for (let m = 0; m < nF; m++) {
    const near = attributed ? attributed[m] === 1 : (m >= region.frameStart && m <= region.frameEnd);
    for (let b = 0; b < originalSpec.bins; b++) {
      if (mask[m][b]) continue;
      const dRe = finalSpec.re[m][b] - originalSpec.re[m][b];
      const dIm = finalSpec.im[m][b] - originalSpec.im[m][b];
      const d2 = dRe * dRe + dIm * dIm;
      obsNum += d2;
      obsDen += originalSpec.re[m][b] ** 2 + originalSpec.im[m][b] ** 2;
      if (near) { nearNum += d2; nearDen += originalSpec.re[m][b] ** 2 + originalSpec.im[m][b] ** 2; nearMax = Math.max(nearMax, Math.sqrt(d2)); }
      else { outNum += d2; outDen += originalSpec.re[m][b] ** 2 + originalSpec.im[m][b] ** 2; outMax = Math.max(outMax, Math.sqrt(d2)); }
    }
  }
  const observedChangeDb = obsDen > 0 ? 10 * Math.log10(obsNum / obsDen) : -300;
  const outsideChangeDb = outDen > 0 ? 10 * Math.log10(outNum / outDen) : -300;
  const adjacentChangeDb = nearDen > 0 ? 10 * Math.log10(nearNum / nearDen) : -300;
  let tgtNum = 0; let tgtDen = 0;
  for (let m = region.frameStart; m <= region.frameEnd; m++) {
    for (let b = region.binStart; b <= region.binEnd; b++) {
      const tgt = target[m][b] ?? 0;
      const got = Math.hypot(finalSpec.re[m][b], finalSpec.im[m][b]);
      tgtNum += (got - tgt) ** 2;
      tgtDen += tgt * tgt;
    }
  }
  const targetResidualDb = tgtDen > 0 ? 10 * Math.log10(tgtNum / tgtDen) : -300;
  const affectedStart = Math.max(0, region.frameStart * originalSpec.hop - originalSpec.padLeft);
  const affectedEnd = Math.min(
    reconstructed.length,
    region.frameEnd * originalSpec.hop - originalSpec.padLeft + originalSpec.fftSize,
  );
  let outsideMax = 0;
  let outsideCount = 0;
  for (let i = 0; i < reconstructed.length; i++) {
    if (i >= affectedStart && i < affectedEnd) continue;
    const d = Math.abs(reconstructed[i] - defective[i]);
    if (d > 0) outsideCount++;
    outsideMax = Math.max(outsideMax, d);
  }
  const admissibleOutsideDb = -120;
  return {
    declaredToleranceDb: limits.observedToleranceDb,
    observedChangeDb: Number(observedChangeDb.toFixed(2)),
    outsideOverlapChangeDb: Number(outsideChangeDb.toFixed(2)),
    adjacentObservedChangeDb: Number(adjacentChangeDb.toFixed(2)),
    outsideOverlapToleranceDb: admissibleOutsideDb,
    withinTolerance: observedChangeDb <= limits.observedToleranceDb,
    outsideOverlapUntouched: outsideChangeDb <= admissibleOutsideDb,
    targetResidualDb: Number(targetResidualDb.toFixed(2)),
    outsideAffectedSpanMaxAbs: outsideMax,
    outsideAffectedSpanNonZeroSamples: outsideCount,
    affectedStart,
    affectedEnd,
  };
}

function candidateToPayload(candidate) {
  const { target, conf } = candidate;
  const height = target.length;
  const width = target[0].length;
  return {
    id: candidate.id,
    label: candidate.label,
    description: candidate.description,
    chosen: !!candidate.chosen,
    quality: candidate.quality ?? null,
    grid: { height, width, target, conf: conf ?? null },
  };
}

export function completeBands({
  audio, sampleRate, fftSize = 1024, hop = 256, regions, options = {}, includePreviewAudio = false,
}) {
  const started = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!regions?.length) throw new Error('at least one mask region is required');
  const { spec, mag } = analyzeAudio(audio, { sampleRate, fftSize, hop });
  const mapped = framesForRegions(spec, regions);
  const declaredMask = maskFromRegions(spec, mapped.regions);
  const components = connectedRegions(declaredMask);
  const target = zerosGrid(spec.frames, spec.bins);
  const confidence = zerosGrid(spec.frames, spec.bins);
  const attributed = new Uint8Array(spec.frames);
  const report = {
    kernel: KERNEL_VERSION,
    status: 'ok',
    limits: {
      maxGapSeconds: limits.maxGapSeconds,
      maxGapHz: limits.maxGapHz,
      minContextFrames: limits.minContextFrames,
      observedToleranceDb: limits.observedToleranceDb,
    },
    analysis: {
      sampleRate: spec.sampleRate,
      fftSize: spec.fftSize,
      hop: spec.hop,
      binHz: spec.binHz,
      frames: spec.frames,
      bins: spec.bins,
      durationSec: spec.duration,
    },
    notes: [...mapped.notes],
    regions: [],
    elapsedMs: 0,
    semantics: {
      observed: 'STFT bins outside the declared mask; held fixed during reconstruction',
      estimated: 'STFT bins inside the mask filled from hypotheses; not recovered ground truth',
      audio: 'reconstructed waveform; compare with the original defective recording',
    },
  };
  let anyCompleted = false;

  for (const region of components) {
    const geometry = regionGridGeometry(region, spec);
    const reasons = validateRegion(region, geometry, { limits, spec, firstContent: mapped.firstContent, lastContent: mapped.lastContent });
    if (reasons.length) {
      report.regions.push({
        geometry: {
        ...geometry,
        frameStart: region.frameStart,
        frameEnd: region.frameEnd,
        binStart: region.binStart,
        binEnd: region.binEnd,
      },
        status: 'unsupported',
        supported: false,
        reasons,
        candidates: [],
        chosen: null,
        conflict: false,
        confidence: null,
      });
      continue;
    }
    const guard = guardFrames(spec);
    const rows = boundaryRows(mag, region, spec, guard);
    if (!rows.left || !rows.right) {
      report.regions.push({
        geometry: {
        ...geometry,
        frameStart: region.frameStart,
        frameEnd: region.frameEnd,
        binStart: region.binStart,
        binEnd: region.binEnd,
      },
        status: 'unsupported',
        supported: false,
        reasons: ['missing observed boundary frame on one side'],
        candidates: [],
        chosen: null,
        conflict: false,
        confidence: null,
      });
      continue;
    }
    const stats = rowStats(rows.left, rows.right);
    const floor = Math.max(stats.floor, 1e-12);
    const energyL = stats.energyL;
    const energyR = stats.energyR;
    const bothCredible = energyL > floor * floor * rows.left.length * 4 && energyR > floor * floor * rows.right.length * 4;
    const conflict = bothCredible && (stats.corr < 0.75 || stats.rmsDiffDb > 6);

    const continuityBoth = buildContinuity(region, rows.left, rows.right, 'both', guard);
    const continuityLeft = buildContinuity(region, rows.left, rows.right, 'left', guard);
    const continuityRight = buildContinuity(region, rows.left, rows.right, 'right', guard);

    const leftTracks = trackPartials(mag, spec, rows.frameL, -1, region);
    const rightTracks = trackPartials(mag, spec, rows.frameR, 1, region);
    const matches = matchPartials(leftTracks.tracks, rightTracks.tracks, region);
    const harm = matches.length >= 2 ? buildHarmonic(region, matches, spec) : null;
    const harmScore = harmonicity(rows);

    const candidates = [];
    const agreement = {
      corr: Number(stats.corr.toFixed(4)),
      rmsDiffDb: Number(stats.rmsDiffDb.toFixed(2)),
      basis: 'left/right boundary magnitude comparison over the masked band',
    };
    const blendTarget = conflict ? buildBlend(continuityLeft, continuityRight) : null;
    if (harm) {
      candidates.push(regionCandidateSummary(
        'harmonic',
        '双侧匹配谐波轨迹',
        `${matches.length} 条在左右观察到并在缺损内匹配的分音轨迹；频率线性延拓、幅度按 dB 插值。`,
        harm.target,
        { quality: { matchedTracks: matches.length, frameCoverage: Number(harm.coverage.toFixed(3)), medianFrequencyResidualBins: Number(harm.freqResidual.toFixed(3)) } },
      ));
    }
    candidates.push(regionCandidateSummary(
      'continuity',
      '双侧幅度连续性插值',
      '对每个频点在时间上按左右边界幅度线性插值，不假设谐波结构。',
      continuityBoth,
    ));
    if (conflict) {
      candidates.push(regionCandidateSummary(
        'blend',
        '左右候选混合（冲突）',
        '左右两侧证据互斥，按中点混合；置信度整体减半，缺口内段不应当作唯一事实。',
        blendTarget,
      ));
      candidates.push(regionCandidateSummary(
        'left',
        '仅左侧上下文延拓',
        '只依据缺损左侧边界向缺口内延拓；与右侧证据相斥，作为候选保留。',
        continuityLeft,
      ));
      candidates.push(regionCandidateSummary(
        'right',
        '仅右侧上下文延拓',
        '只依据缺损右侧边界向缺口内延拓；与左侧证据相斥，作为候选保留。',
        continuityRight,
      ));
    }

    const pickHarmonic = harm && matches.length >= 2 && harmScore >= 0.4;
    let chosen;
    if (conflict) chosen = candidates.find((c) => c.id === 'blend');
    else if (pickHarmonic) chosen = candidates.find((c) => c.id === 'harmonic');
    else chosen = candidates.find((c) => c.id === 'continuity');
    for (const c of candidates) c.chosen = c === chosen;

    const gapLimitRatio = geometry.gapSeconds / limits.maxGapSeconds;
    const estimatedErrorDb = clamp(
      1.5
        + 2.5 * gapLimitRatio
        + 0.5 * stats.rmsDiffDb
        + 2.0 * (1 - harmScore)
        + (chosen.id === 'continuity' ? 1.0 : 0)
        + (conflict ? 5.0 : 0),
      1,
      24,
    );
    const confidenceBand = {
      lowerDb: Number((estimatedErrorDb * 0.6).toFixed(1)),
      upperDb: Number((estimatedErrorDb * 1.8).toFixed(1)),
    };
    for (const c of candidates) {
      c.conf = buildConfidence(region, mag, c.target, { ...stats, floor }, conflict || c.id !== chosen.id);
    }
    const conf = chosen.conf;

    const written = chosen.target;
    for (let m = region.frameStart; m <= region.frameEnd; m++) {
      for (let b = region.binStart; b <= region.binEnd; b++) {
        target[m][b] = written[m - region.frameStart][b - region.binStart];
        confidence[m][b] = conf[m - region.frameStart][b - region.binStart];
      }
    }
    // Attribute every analysis frame whose window overlaps the region span.
    const halfWindow = Math.floor((spec.fftSize / 2) / spec.hop) + 1;
    const startSample = region.frameStart * spec.hop - spec.padLeft;
    const endSample = region.frameEnd * spec.hop - spec.padLeft + spec.fftSize;
    for (let m = Math.max(0, region.frameStart - halfWindow); m <= Math.min(spec.frames - 1, region.frameEnd + halfWindow); m++) {
      const segStart = m * spec.hop - spec.padLeft;
      const segEnd = segStart + spec.fftSize;
      if (segEnd <= startSample || segStart >= endSample) continue;
      attributed[m] = 1;
    }
    anyCompleted = true;

    const confStats = cropStats(chosen.target, conf);
    const confidenceLevel = conflict ? 'low' : estimatedErrorDb <= 4 ? 'high' : estimatedErrorDb <= 9 ? 'medium' : 'low';
    const payloadCandidates = candidates.map((c, i) => ({
      ...candidateToPayload(c),
      chosen: c === chosen,
      rank: i,
    }));

    report.regions.push({
      geometry: {
        ...geometry,
        frameStart: region.frameStart,
        frameEnd: region.frameEnd,
        binStart: region.binStart,
        binEnd: region.binEnd,
      },
      status: 'completed',
      supported: true,
      reasons: conflict ? ['left and right observed context propose mutually exclusive continuations'] : [],
      conflict,
      selectedCandidate: chosen.id,
      selectedLabel: chosen.label,
      candidates: payloadCandidates,
      confidence: {
        level: confidenceLevel,
        estimatedErrorDb: Number(estimatedErrorDb.toFixed(1)),
        band: confidenceBand,
        basis: 'heuristic from boundary disagreement, distance from observed context, and harmonic match quality; not a guarantee',
        cellStats: {
          mean: Number(confStats.mean.toFixed(4)),
          max: Number(confStats.max.toFixed(4)),
          coveredCells: confStats.coveredCells,
        },
      },
      agreement,
      hypotheses: buildHypotheses({ conflict, chosen, matches, stats, harmScore, harm }),
      harmonicity: Number(harmScore.toFixed(3)),
    });
  }

  let reconstructed = audio;
  let audit = null;
  if (anyCompleted) {
    const previewIterations = includePreviewAudio
      ? Math.max(4, Math.min(limits.previewIterations, Math.floor(limits.maxIterations / 2)))
      : 0;
    const result = reconstructConstrained({
      spec, mask: declaredMask, target, iterations: Math.min(limits.maxIterations, options.iterations ?? 60),
    });
    reconstructed = result.audio;
    const finalSpec = result.spec;
    let worstAudit = null;
    for (const reg of report.regions) {
      if (reg.status !== 'completed') continue;
      const g = reg.geometry;
      const regionGrid = { frameStart: g.frameStart, frameEnd: g.frameEnd, binStart: g.binStart, binEnd: g.binEnd };
      const a = auditReconstruction({
        originalSpec: spec,
        finalSpec,
        mask: declaredMask,
        target,
        attributed,
        defective: audio,
        reconstructed,
        region: regionGrid,
        limits,
      });
      reg.audit = a;
      if (!worstAudit || a.observedChangeDb > worstAudit.observedChangeDb) worstAudit = a;
    }
    audit = worstAudit;
    if (audit && (!audit.withinTolerance || !audit.outsideOverlapUntouched)) {
      report.status = 'inconsistent';
      if (!audit.withinTolerance) {
        report.notes.push(`observed-region change ${audit.observedChangeDb.toFixed(1)} dB exceeds declared tolerance ${audit.declaredToleranceDb} dB; treat output as failed consistency`);
      }
      if (!audit.outsideOverlapUntouched) {
        report.notes.push(`frames outside the gap window changed by ${audit.outsideOverlapChangeDb.toFixed(1)} dB; those samples must stay untouched`);
      }
    }
    if (includePreviewAudio) {
      for (const reg of report.regions) {
        if (reg.status !== 'completed') continue;
        for (const cand of reg.candidates) {
          const fullTarget = zerosGrid(spec.frames, spec.bins);
          if (cand.id === reg.selectedCandidate) {
            for (let m = 0; m < spec.frames; m++) fullTarget[m].set(target[m]);
          } else {
            const g = reg.geometry;
            const height = cand.grid.height;
            const width = cand.grid.width;
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) fullTarget[g.frameStart + y][g.binStart + x] = cand.grid.target[y][x];
            }
          }
          const pre = reconstructConstrained({
            spec, mask: declaredMask, target: fullTarget, iterations: previewIterations,
          });
          cand.previewIterations = previewIterations;
          cand.previewAudio = pre.audio;
        }
      }
    }
  } else {
    report.status = 'refused';
    report.notes.push('no region satisfied the model conditions; original audio returned unchanged');
  }

  if (report.regions.some((r) => r.status === 'unsupported') && anyCompleted) {
    report.status = report.status === 'ok' ? 'partial' : report.status;
  }

  report.audit = audit;
  report.elapsedMs = Date.now() - started;
  return {
    audio: reconstructed,
    mask: declaredMask,
    attributedFrames: attributed,
    target,
    confidence,
    report,
    specMeta: {
      sampleRate: spec.sampleRate, fftSize, hop, binHz: spec.binHz,
      frames: spec.frames, bins: spec.bins,
    },
  };
}

function buildHypotheses({ conflict, chosen, matches, stats, harmScore, harm }) {
  const list = [];
  if (conflict) {
    list.push({
      id: 'conflict',
      statement: `左右两侧边界在缺损频带内不一致（相关 ${stats.corr.toFixed(2)}，均方幅度差 ${stats.rmsDiffDb.toFixed(1)} dB）。左右延拓互斥，结果仅为候选混合，不是唯一事实。`,
    });
  }
  if (chosen.id === 'harmonic') {
    list.push({
      id: 'harmonic',
      statement: `采用 ${matches.length} 条双侧匹配谐波轨迹（谐波性 ${(harmScore * 100).toFixed(0)}%），频率与幅度均由观测区延拓。`,
    });
  } else if (conflict) {
    list.push({ id: 'blend', statement: '采用左右候选中点混合以保留两侧证据；中段置信度降低，边界附近置信度较高。' });
  } else {
    list.push({ id: 'continuity', statement: `未发现足够可靠的双侧谐波轨迹（谐波性 ${(harmScore * 100).toFixed(0)}%），退化为逐频点时间连续性插值。` });
  }
  if (harm) {
    list.push({ id: 'harmonic-alt', statement: `谐波模型作为候选保留（${matches.length} 条轨迹），未被选中不代表已排除。` });
  }
  list.push({ id: 'estimate', statement: '缺口内的内容均为算法估计，未使用测试真值；不要在界面或报告中称为“已恢复的原始事实”。' });
  return list;
}

export function maskToRegionsSeconds(report, specMeta) {
  return report.regions.map((r) => ({
    startSec: r.geometry.startSec,
    endSec: r.geometry.endSec,
    lowHz: r.geometry.lowHz,
    highHz: r.geometry.highHz,
    status: r.status,
  }));
}
