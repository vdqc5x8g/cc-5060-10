// Controlled fault injection for acceptance mutation tests.
//
// A verification suite that only passes clean runs cannot prove it would catch
// bad results. These mutators synthesize the exact failure modes the brief
// names, and the acceptance layer must reject every one of them:
//
//   polluteKnownRegion  observed cells/samples are altered while the gap stays
//                       filled -> "污染已知样本" failure
//   injectOverconfidence an unidentifiable result is relabelled as a single
//                       high-confidence answer -> "错误自信" failure
//   injectWrongFill      gap magnitudes are scrambled while observed data is
//                       preserved -> divergence/conservation must expose it
//
// The mutators touch only kernel outputs (audio, report payloads). They never
// read the pre-gap truth, mirroring what an actual faulty pipeline could do.

import { stft, istft } from '../kernel/stft.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Add energy to an observed frequency band in frames OUTSIDE the mask window.
// The mask and the gap content are left alone; only trusted samples change.
export function polluteKnownRegion({ reconstructed, mask, grid, fftSize, hop, sampleRate, seed = 13, gain = 0.25 }) {
  const spec = stft(reconstructed, { fftSize, hop, sampleRate });
  const re = spec.re.map((row) => Float64Array.from(row));
  const im = spec.im.map((row) => Float64Array.from(row));
  const rand = mulberry32(seed);
  const { frameStart, frameEnd, binStart, binEnd } = grid;
  // Neighbour band just above the gap; choose frames well clear of the mask.
  const bLo = Math.min(spec.bins - 3, binEnd + 4);
  const bHi = Math.min(spec.bins - 2, bLo + Math.max(2, (binEnd - binStart)));
  const pollutedFrames = [];
  for (let m = 0; m < spec.frames; m++) {
    if (m >= frameStart - 1 && m <= frameEnd + 1) continue;
    if (rand() > 0.5) pollutedFrames.push(m);
  }
  let peak = 0;
  for (let m = 0; m < spec.frames; m++) {
    for (let b = 0; b < spec.bins; b++) peak = Math.max(peak, Math.hypot(re[m][b], im[m][b]));
  }
  const amp = peak * gain;
  for (const m of pollutedFrames) {
    for (let b = bLo; b <= bHi; b++) {
      const phase = rand() * 2 * Math.PI;
      re[m][b] += amp * Math.cos(phase);
      im[m][b] += amp * Math.sin(phase);
    }
  }
  const audio = istft({ ...spec, re, im });
  return {
    audio,
    fault: 'known-region-pollution',
    pollutedFrames,
    pollutedBins: { bLo, bHi },
  };
}

// Relabel an uncertain result as certain: collapse to one candidate, raise the
// confidence level, and shrink the error band. The audio is unchanged, so this
// isolates the "false confidence" failure from waveform corruption.
export function injectOverconfidence(report, { regionIndex = 0 } = {}) {
  const clone = structuredClone(report);
  const region = clone.regions[regionIndex];
  if (!region) throw new Error('injectOverconfidence: region index out of range');
  if (Array.isArray(region.candidates) && region.candidates.length > 1) {
    region.candidates = [region.candidates.find((c) => c.chosen) ?? region.candidates[0]];
    region.candidates[0].chosen = true;
  }
  region.conflict = false;
  region.confidence = {
    ...(region.confidence ?? {}),
    level: 'high',
    estimatedErrorDb: 1.0,
    band: { lowerDb: 0.4, upperDb: 1.6 },
    basis: 'MUTATED: overconfident label without supporting evidence',
  };
  region.reasons = (region.reasons ?? []).filter((r) => !/mutually exclusive/i.test(r));
  clone.status = 'ok';
  clone.notes = [...(clone.notes ?? []), 'MUTATED: uncertainty markers removed'];
  return { report: clone, fault: 'false-confidence' };
}

// Scramble the gap magnitudes while pinning observed cells exactly, so the
// waveform changes only through the masked region. A correct acceptance layer
// must catch this via the independent fill-consistency check (the delivered
// gap no longer matches the declared candidate) rather than known-region
// error, which stays clean by construction.
export function injectWrongFill({ reconstructed, mask, fftSize, hop, sampleRate, seed = 29 }) {
  const spec = stft(reconstructed, { fftSize, hop, sampleRate });
  const re = spec.re.map((row) => Float64Array.from(row));
  const im = spec.im.map((row) => Float64Array.from(row));
  const rand = mulberry32(seed);
  for (let m = 0; m < spec.frames; m++) {
    for (let b = 0; b < spec.bins; b++) {
      if (!mask[m]?.[b]) continue;
      const mag = Math.hypot(re[m][b], im[m][b]);
      if (mag <= 0) continue;
      // Invert/attenuate the magnitude and randomize phase: the cell carries
      // unrelated energy while the observation mask is never touched.
      const newMag = mag * (0.15 + 1.1 * rand());
      const phase = rand() * 2 * Math.PI;
      re[m][b] = newMag * Math.cos(phase);
      im[m][b] = newMag * Math.sin(phase);
    }
  }
  const audio = istft({ ...spec, re, im });
  return { audio, fault: 'wrong-fill-magnitude-scramble' };
}
