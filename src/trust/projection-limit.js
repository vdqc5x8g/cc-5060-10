// Error lower bound from independent projections, and its scope.
//
// Two projections estimate the masked cells using *different* structural
// subspaces and only observed data:
//   V_time     every bin's magnitude is linear in time across the gap
//              (polynomial subspace, fitted from boundary rows)
//   V_periodic magnitude along frequency is periodic at an estimated f0
//              (harmonic subspace; f0 comes from autocorrelation of observed
//               rows, never from the gap or the truth)
//
// If z1 and z2 are their gap-cell predictions and z is the true content,
//   max(||z - z1||, ||z - z2||) >= ||z1 - z2|| / 2 =: e_lb          (triangle)
// so the disagreement is a truth-free LOWER bound on at least one error. The
// bound is always valid, but it is not always *informative*: when both priors
// fail in the same way their disagreement shrinks even though both are wrong
// (a shared null space). Small disagreement therefore never certifies
// certainty; only large disagreement certifies uncertainty. That one-directional
// scope is what this module measures, alongside observed-cell fit residuals
// that gate whether either prior is applicable at all.
//
// The truth-aware helper is named ...AgainstTruth and is used only by the
// test/bench layer to map the scope; the acceptance gate itself consumes only
// the truth-free quantities.

function gapSlice(grid) {
  return {
    height: grid.frameEnd - grid.frameStart + 1,
    width: grid.binEnd - grid.binStart + 1,
  };
}

// V_time: per-bin linear interpolation between the nearest fully observed frame
// on each side of the mask window.
export function timeLinearProjection(mag, grid, guard = 3) {
  const { frameStart, frameEnd, binStart, binEnd } = grid;
  const { height, width } = gapSlice(grid);
  const mL = Math.max(0, frameStart - guard);
  const mR = Math.min(mag.length - 1, frameEnd + guard);
  const out = Array.from({ length: height }, () => new Float64Array(width));
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0.5;
    for (let x = 0; x < width; x++) {
      const b = binStart + x;
      out[y][x] = mag[mL][b] * (1 - t) + mag[mR][b] * t;
    }
  }
  return out;
}

function estimatePeriodBins(observedRow, minBins = 4, maxBins = 90) {
  // Autocorrelation of an observed boundary row; the first strong peak is the
  // spectral period in bins. Generic stochastic texture yields no stable peak,
  // which is itself reported as a poor prior fit.
  const n = observedRow.length;
  let bestLag = 0;
  let bestScore = -Infinity;
  const hi = Math.min(maxBins, Math.floor(n / 2));
  for (let lag = minBins; lag <= hi; lag++) {
    let num = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i + lag < n; i++) {
      num += observedRow[i] * observedRow[i + lag];
      e0 += observedRow[i] * observedRow[i];
      e1 += observedRow[i + lag] * observedRow[i + lag];
    }
    const score = e0 > 0 && e1 > 0 ? num / Math.sqrt(e0 * e1) : 0;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return { periodBins: bestLag, periodicity: Number(bestScore.toFixed(4)) };
}

// V_periodic: build a one-period magnitude template from observed rows, then
// tile it across the gap at the estimated period.
export function periodicProjection(mag, grid, guard = 3) {
  const { frameStart, frameEnd, binStart, binEnd } = grid;
  const { height, width } = gapSlice(grid);
  const mL = Math.max(0, frameStart - guard);
  const mR = Math.min(mag.length - 1, frameEnd + guard);
  const rowL = mag[mL].subarray(binStart, binEnd + 1);
  const rowR = mag[mR].subarray(binStart, binEnd + 1);
  const avg = new Float64Array(width);
  for (let x = 0; x < width; x++) avg[x] = 0.5 * (rowL[x] + rowR[x]);
  const { periodBins, periodicity } = estimatePeriodBins(avg);
  const template = new Float64Array(Math.max(1, periodBins));
  const counts = new Float64Array(template.length);
  for (let x = 0; x < width; x++) {
    template[x % template.length] += avg[x];
    counts[x % template.length] += 1;
  }
  for (let k = 0; k < template.length; k++) template[k] = counts[k] ? template[k] / counts[k] : 0;
  const out = Array.from({ length: height }, () => new Float64Array(width));
  // Hold the periodic template, with a mild temporal tilt toward each boundary.
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0.5;
    for (let x = 0; x < width; x++) {
      const periodic = template[x % template.length];
      out[y][x] = periodic * (1 + 0.15 * (t - 0.5));
    }
  }
  return { grid: out, periodBins, periodicity };
}

function gridEnergy(g) {
  let e = 0;
  for (const row of g) for (const v of row) e += v * v;
  return e;
}

function gridDiffDb(a, b) {
  let num = 0;
  let den = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[0].length; x++) {
      const d = a[y][x] - b[y][x];
      num += d * d;
      den += b[y][x] * b[y][x];
    }
  }
  return den > 0 ? 10 * Math.log10(num / den) : (num === 0 ? 300 : -300);
}

// Truth-free disagreement and lower bound.
export function projectionDisagreement(predA, predB) {
  let d2 = 0;
  let scaleA = 0;
  let scaleB = 0;
  for (let y = 0; y < predA.length; y++) {
    for (let x = 0; x < predA[0].length; x++) {
      d2 += (predA[y][x] - predB[y][x]) ** 2;
      scaleA += predA[y][x] ** 2;
      scaleB += predB[y][x] ** 2;
    }
  }
  const delta = Math.sqrt(d2);
  const ref = Math.sqrt(Math.max(scaleA, scaleB, 1e-20));
  return {
    deltaLinear: delta,
    lowerBoundLinear: delta / 2,
    disagreementDb: Number((20 * Math.log10(Math.max(delta, 1e-12) / ref)).toFixed(2)),
    lowerBoundDb: Number((20 * Math.log10(Math.max(delta / 2, 1e-12) / ref)).toFixed(2)),
  };
}

// How well each proposed subspace fits the OBSERVED context frames. Large
// residuals mean the prior does not apply, so any bound derived through it has
// no informative scope even if the triangle inequality still holds.
export function observedFitResiduals(mag, grid, guard = 3) {
  const { frameStart, frameEnd, binStart, binEnd } = grid;
  const width = binEnd - binStart + 1;
  const testFrames = [];
  for (let k = 1; k <= guard; k++) {
    if (frameStart - guard - k >= 0) testFrames.push(frameStart - guard - k);
    if (frameEnd + guard + k < mag.length) testFrames.push(frameEnd + guard + k);
  }
  const linear = timeLinearProjection(mag, { ...grid, frameStart: frameStart - guard, frameEnd: frameStart - guard }, guard);
  let numL = 0;
  let denL = 0;
  let numP = 0;
  let denP = 0;
  let periodicitySum = 0;
  let periodicityN = 0;
  for (const m of testFrames) {
    const row = mag[m].subarray(binStart, binEnd + 1);
    const predRow = linear[0];
    for (let x = 0; x < width; x++) {
      numL += (row[x] - predRow[x]) ** 2;
      denL += row[x] ** 2;
    }
    const { periodicity } = estimatePeriodBins(Float64Array.from(row));
    periodicitySum += periodicity;
    periodicityN++;
    // Periodic prior predicts self-similarity at the lag; residual = 1 - score.
    numP += (1 - periodicity) ** 2;
    denP += 1;
  }
  return {
    linearFitDb: Number((10 * Math.log10(Math.max(numL, 1e-20) / Math.max(denL, 1e-20))).toFixed(2)),
    periodicFitResidual: Number(Math.sqrt(numP / Math.max(denP, 1)).toFixed(4)),
    meanPeriodicity: Number((periodicitySum / Math.max(periodicityN, 1)).toFixed(4)),
  };
}

// Test-only: verify the triangle lower bound against withheld truth and report
// whether the bound is informative (lower bound within 12 dB of the smaller
// true error) or vacuous (both projections share a biased null space).
export function boundCheckAgainstTruth({ predA, predB, truthGrid, mag, maskGrid }) {
  const errA = gridDiffDb(predA, truthGrid);
  const errB = gridDiffDb(predB, truthGrid);
  const disagreement = projectionDisagreement(predA, predB);
  const linTruth = Math.sqrt(gridEnergy(truthGrid));
  let ea2 = 0;
  let eb2 = 0;
  for (let y = 0; y < truthGrid.length; y++) {
    for (let x = 0; x < truthGrid[0].length; x++) {
      ea2 += (predA[y][x] - truthGrid[y][x]) ** 2;
      eb2 += (predB[y][x] - truthGrid[y][x]) ** 2;
    }
  }
  const boundHolds = Math.max(Math.sqrt(ea2), Math.sqrt(eb2)) + 1e-9 >= disagreement.lowerBoundLinear;
  const bestErrorDb = 10 * Math.log10(Math.min(ea2, eb2) / Math.max(linTruth ** 2, 1e-20));
  const informative = disagreement.lowerBoundDb > bestErrorDb - 12;
  return {
    errADb: Number(errA.toFixed(2)),
    errBDb: Number(errB.toFixed(2)),
    disagreementDb: disagreement.disagreementDb,
    lowerBoundDb: disagreement.lowerBoundDb,
    boundHolds,
    informative,
    scopeNote: informative
      ? 'projections disagree: bound certifies real uncertainty'
      : 'bound valid but vacuous: shared null space; small disagreement must not be read as certainty',
    residuals: observedFitResiduals(mag, maskGrid),
  };
}

// Orthogonality / Parseval check for the observation mask projection P_Omega:
// the complex STFT energy must split exactly into observed and masked parts.
// This is the algebraic fact behind trusted-subband conservation.
export function maskProjectionOrthogonality(spec, mask) {
  let observed = 0;
  let masked = 0;
  let total = 0;
  for (let m = 0; m < spec.frames; m++) {
    for (let b = 0; b < spec.bins; b++) {
      const e = spec.re[m][b] ** 2 + spec.im[m][b] ** 2;
      total += e;
      if (mask[m]?.[b]) masked += e;
      else observed += e;
    }
  }
  const splitError = Math.abs((observed + masked) - total) / Math.max(total, 1e-20);
  return {
    observedEnergy: observed,
    maskedEnergy: masked,
    totalEnergy: total,
    splitRelativeError: Number(splitError.toExponential(3)),
    orthogonal: splitError < 1e-12,
  };
}
