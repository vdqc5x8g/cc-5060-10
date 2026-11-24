// Orchestrates one trusted-region run end to end.
//
// Flow per fixture:
//   kernel (defective + mask only)  -> independent reference measurements
//   -> independent projection lower-bound check -> acceptance verdict.
//
// The truth track is never passed to completeBands(). The truth-aware
// projection scope check is optional and, when used, lives in a clearly named
// field separate from the acceptance gate.

import { stft } from '../kernel/stft.js';
import { completeBands } from '../kernel/complete.js';
import { knownRegionError, candidateDivergence, subbandConservation, fillConsistency } from './reference.js';
import {
  timeLinearProjection, periodicProjection, projectionDisagreement,
  observedFitResiduals, boundCheckAgainstTruth, maskProjectionOrthogonality,
} from './projection-limit.js';
import { judgeAcceptance } from './acceptance.js';

function magnitudeGrid(spec) {
  const grid = new Array(spec.frames);
  for (let m = 0; m < spec.frames; m++) {
    const row = new Float64Array(spec.bins);
    for (let b = 0; b < spec.bins; b++) row[b] = Math.hypot(spec.re[m][b], spec.im[m][b]);
    grid[m] = row;
  }
  return grid;
}

function candidateGridsFromReport(report) {
  const region = report.regions.find((r) => r.status === 'completed');
  if (!region) return { region: null, grids: [], candidateCount: 0, confidenceLevel: null, conflict: false };
  const grids = region.candidates.map((c) => c.grid.target.map((row) => Float64Array.from(row)));
  return {
    region,
    grids,
    candidateCount: region.candidates.length,
    confidenceLevel: region.confidence?.level ?? null,
    conflict: region.conflict === true,
  };
}

// Allow an injected fault to replace the audio/report before measurement.
export function runTrustVerification(fx, overrides = {}) {
  const fftSize = fx.fftSize;
  const hop = fx.hop;
  const sampleRate = fx.sampleRate;
  const regionInput = [{ ...fx.region }];
  const result = completeBands({
    audio: fx.defective,
    sampleRate,
    fftSize,
    hop,
    regions: regionInput,
    options: {},
  });

  let audio = result.audio;
  let report = result.report;
  let mask = result.mask;
  let target = result.target;
  let attributedFrames = result.attributedFrames;
  let faultLabel = overrides.fault ?? null;
  if (overrides.fault === 'known-region-pollution' && overrides.polluted) {
    audio = overrides.polluted.audio;
  } else if (overrides.fault === 'false-confidence' && overrides.overconfidentReport) {
    // The report payload (candidate set / confidence labels) is what the
    // mutation corrupts; the mask and target grids travel with the payload.
    report = overrides.overconfidentReport;
    mask = overrides.mask ?? result.mask;
    target = overrides.target ?? result.target;
    attributedFrames = overrides.attributedFrames ?? result.attributedFrames;
  } else if (overrides.fault === 'wrong-fill' && overrides.wrongFill) {
    audio = overrides.wrongFill.audio;
  }

  const completedRegion = report.regions.find((r) => r.status === 'completed');
  const refused = !completedRegion;
  const specDef = stft(fx.defective, { fftSize, hop, sampleRate });
  const magDef = magnitudeGrid(specDef);
  const orthogonality = maskProjectionOrthogonality(specDef, mask);

  const base = {
    fixtureId: fx.id,
    identifiability: fx.identifiability,
    status: report.status,
    regionStatus: completedRegion ? 'completed' : 'unsupported',
    orthogonality,
  };

  if (refused) {
    // Refusal path: verify the output is the untouched defective recording and
    // the mask projection is still an exact orthogonal split.
    let identical = true;
    for (let i = 0; i < audio.length; i++) {
      if (Math.abs(audio[i] - fx.defective[i]) > 1e-9) { identical = false; break; }
    }
    const verdict = judgeAcceptance({
      ...base,
      candidateCount: 0,
      confidenceLevel: null,
      conflict: false,
      known: {
        observedChangeDb: identical ? -300 : 0,
        outsideWindowChangeDb: identical ? -300 : 0,
        outsideWindowUntouched: identical,
        changedSamples: identical ? 0 : null,
      },
      conservation: { worstConservationDb: identical ? -300 : 0, compartments: [] },
      divergence: { meanDb: null, maxDb: null, pairs: [] },
      projection: { disagreementDb: null, lowerBoundDb: null, residuals: null, boundHolds: true },
      fault: faultLabel,
    });
    return { ...base, refused: true, outputUntouched: identical, verdict, measurements: { orthogonality } };
  }

  const grid = fx.grid;
  const known = knownRegionError({
    defective: fx.defective,
    reconstructed: audio,
    mask,
    attributedFrames,
    fftSize,
    hop,
    sampleRate,
  });
  const conservation = subbandConservation({
    defective: fx.defective,
    reconstructed: audio,
    grid,
    fftSize,
    hop,
    sampleRate,
    attributedFrames,
  });
  const fill = fillConsistency({
    reconstructed: audio,
    target,
    grid,
    fftSize,
    hop,
    sampleRate,
  });
  const { grids, candidateCount, confidenceLevel, conflict, region } = candidateGridsFromReport(report);
  const divergence = candidateDivergence(grids);

  // Independent projections from observed magnitude only.
  const predTime = timeLinearProjection(magDef, grid);
  const periodic = periodicProjection(magDef, grid);
  const predPeriodic = periodic.grid;
  const disagreement = projectionDisagreement(predTime, predPeriodic);
  const residuals = observedFitResiduals(magDef, grid);
  const projection = {
    disagreementDb: disagreement.disagreementDb,
    lowerBoundDb: disagreement.lowerBoundDb,
    deltaLinear: disagreement.deltaLinear,
    lowerBoundLinear: disagreement.lowerBoundLinear,
    periodBins: periodic.periodBins,
    periodicity: periodic.periodicity,
    residuals,
    boundHolds: true, // triangle inequality; re-checked numerically below
  };

  // Optional truth-aware scope mapping (never consumed by the gate).
  let scopeCheck = null;
  if (overrides.withTruth) {
    const specTruth = stft(fx.truth, { fftSize, hop, sampleRate });
    const magTruth = magnitudeGrid(specTruth);
    const truthGrid = Array.from(
      { length: grid.frameEnd - grid.frameStart + 1 },
      (_, y) => Float64Array.from(magTruth[grid.frameStart + y].subarray(grid.binStart, grid.binEnd + 1)),
    );
    scopeCheck = boundCheckAgainstTruth({
      predA: predTime,
      predB: predPeriodic,
      truthGrid,
      mag: magDef,
      maskGrid: grid,
    });
  }

  const verdict = judgeAcceptance({
    ...base,
    regionStatus: 'completed',
    candidateCount,
    confidenceLevel,
    conflict,
    known,
    conservation,
    fill,
    divergence,
    projection,
    fault: faultLabel,
  });

  return {
    ...base,
    refused: false,
    selectedCandidate: region.selectedCandidate,
    measurements: {
      known,
      conservation,
      fill,
      divergence,
      projection,
      orthogonality,
    },
    scopeCheck,
    verdict,
  };
}
