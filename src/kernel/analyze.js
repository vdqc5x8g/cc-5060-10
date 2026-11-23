// Analysis primitives for the band-completion kernel.
// Everything in this module only ever sees the *defective* recording and the
// declared mask. Truth material lives in evaluate.js and is never imported
// here.

export function magnitudeGrid(spec) {
  const grid = new Array(spec.frames);
  for (let m = 0; m < spec.frames; m++) {
    const row = new Float64Array(spec.bins);
    const re = spec.re[m];
    const im = spec.im[m];
    for (let b = 0; b < spec.bins; b++) row[b] = Math.hypot(re[b], im[b]);
    grid[m] = row;
  }
  return grid;
}

export function db(x) {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

export function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

export function quantile(values, q) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function parabolicPeak(mag, b) {
  if (b < 1 || b >= mag.length - 1) return { bin: b, mag: mag[b] ?? 0 };
  const l = Math.log(mag[b - 1] + 1e-15);
  const c = Math.log(mag[b] + 1e-15);
  const r = Math.log(mag[b + 1] + 1e-15);
  const den = l - 2 * c + r;
  const delta = Math.abs(den) > 1e-12 ? (0.5 * (l - r)) / den : 0;
  const logMag = c - 0.25 * (l - r) * delta;
  return { bin: b + delta, mag: Math.exp(logMag) };
}

export function localNoiseFloor(magGrid, m, bLo, bHi) {
  const vals = [];
  for (const mm of [m - 1, m, m + 1]) {
    if (mm < 0 || mm >= magGrid.length) continue;
    for (let b = Math.max(1, bLo); b <= Math.min(magGrid[0].length - 2, bHi); b++) {
      vals.push(magGrid[mm][b]);
    }
  }
  return median(vals);
}

export function findPeaks(mag, bLo, bHi, threshold) {
  const out = [];
  for (let b = Math.max(1, bLo); b <= Math.min(mag.length - 2, bHi); b++) {
    if (mag[b] > mag[b - 1] && mag[b] >= mag[b + 1] && mag[b] > threshold) {
      const p = parabolicPeak(mag, b);
      if (p.mag > threshold) out.push({ bin: p.bin, mag: p.mag });
    }
  }
  return out;
}

export function estimateF0(mag, binHz, loHz = 60, hiHz = 1200) {
  const lo = Math.max(2, Math.round(loHz / binHz));
  const hi = Math.min(mag.length - 3, Math.round(hiHz / binHz));
  let best = 0;
  let bestScore = -Infinity;
  for (let f = lo; f <= hi; f++) {
    let s = 0;
    for (let h = 1; h <= 6; h++) {
      const b = Math.round(f * h);
      if (b >= mag.length) break;
      s += mag[b];
    }
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return best;
}

// Track spectral peaks from a boundary frame into the observed past/future.
// side = -1 walks backwards in time from the boundary, side = +1 forwards.
export function trackPartials(magGrid, spec, boundaryFrame, side, region, contextFrames = 16) {
  const { bins } = spec;
  const bLo = Math.max(1, region.binStart - Math.max(8, Math.round((region.binEnd - region.binStart) * 0.3)));
  const bHi = Math.min(bins - 2, region.binEnd + Math.max(8, Math.round((region.binEnd - region.binStart) * 0.3)));
  const floor = localNoiseFloor(magGrid, boundaryFrame, region.binStart, region.binEnd);
  const peaks = findPeaks(magGrid[boundaryFrame], bLo, bHi, Math.max(floor * 3, 1e-9));
  peaks.sort((a, b) => b.mag - a.mag);
  const tracks = [];
  for (const p of peaks.slice(0, 48)) {
    const points = [{
      m: boundaryFrame,
      bin: p.bin,
      mag: p.mag,
      phase: Math.atan2(spec.im[boundaryFrame][Math.max(0, Math.min(bins - 1, Math.round(p.bin)))],
        spec.re[boundaryFrame][Math.max(0, Math.min(bins - 1, Math.round(p.bin)))]),
    }];
    let slope = 0;
    let lastBin = p.bin;
    for (let k = 1; k <= contextFrames; k++) {
      const m = boundaryFrame + side * k;
      if (m < 0 || m >= spec.frames) break;
      const guess = lastBin + slope * side;
      const candidates = findPeaks(magGrid[m], Math.max(1, Math.floor(guess) - 3), Math.min(bins - 2, Math.ceil(guess) + 3), floor * 1.2);
      if (!candidates.length) break;
      let best = null;
      let bestD = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c.bin - guess);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (!best || bestD > 2.2) break;
      const step = best.bin - lastBin;
      if (Math.abs(step) < 3) slope = step * side;
      points.push({
        m,
        bin: best.bin,
        mag: best.mag,
        phase: Math.atan2(spec.im[m][Math.round(best.bin)], spec.re[m][Math.round(best.bin)]),
      });
      lastBin = best.bin;
    }
    if (points.length >= 3) {
      tracks.push(fitTrack(points, side));
    } else if (points.length >= 2) {
      tracks.push(fitTrack(points, side));
    }
  }
  return { tracks, floor, peaks };
}

function fitTrack(points, side) {
  const n = points.length;
  let sumM = 0;
  let sumB = 0;
  let sumDb = 0;
  for (const p of points) {
    sumM += p.m;
    sumB += p.bin;
    sumDb += db(p.mag);
  }
  const meanM = sumM / n;
  const meanB = sumB / n;
  const meanDb = sumDb / n;
  let covB = 0;
  let varM = 0;
  let covDb = 0;
  for (const p of points) {
    const dm = p.m - meanM;
    covB += dm * (p.bin - meanB);
    covDb += dm * (db(p.mag) - meanDb);
    varM += dm * dm;
  }
  const slopeBin = varM > 0 ? covB / varM : 0;
  const slopeDb = varM > 0 ? covDb / varM : 0;
  const boundary = points[0];
  return {
    side,
    points,
    count: n,
    boundaryFrame: boundary.m,
    boundaryBin: boundary.bin,
    boundaryMag: boundary.mag,
    boundaryPhase: boundary.phase,
    slopeBin,
    slopeDb,
    freqAt(m) { return this.boundaryBin + this.slopeBin * (m - this.boundaryFrame); },
    dbAt(m) { return db(this.boundaryMag) + this.slopeDb * (m - this.boundaryFrame); },
  };
}

// Robust per-bin phase advance (radians per hop) measured from observed frames
// on a given side of the region.
export function measurePhaseAdvance(spec, side, region, contextFrames = 8) {
  const adv = new Float64Array(spec.bins);
  const border = side === -1 ? region.frameStart - 1 : region.frameEnd + 1;
  let count = 0;
  for (let k = 1; k <= contextFrames; k++) {
    const m1 = border - side * k;
    const m2 = border - side * (k - 1);
    if (m1 < 0 || m2 < 0 || m1 >= spec.frames || m2 >= spec.frames) break;
    for (let b = 1; b < spec.bins - 1; b++) {
      let d = Math.atan2(spec.im[m2][b], spec.re[m2][b]) - Math.atan2(spec.im[m1][b], spec.re[m1][b]);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      adv[b] += d;
    }
    count++;
  }
  if (count > 0) for (let b = 0; b < spec.bins; b++) adv[b] /= count;
  return adv;
}

export function horizontalProfile(magGrid, frame, bLo, bHi) {
  const row = new Float64Array(bHi - bLo + 1);
  for (let b = bLo; b <= bHi; b++) row[b - bLo] = magGrid[frame][b];
  return row;
}
