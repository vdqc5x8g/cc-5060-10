// Trust-region test generator.
//
// The brief: synthesize recordings with *controlled* defects and, crucially,
// pairs of gaps that have the SAME width but OPPOSITE identifiability. A
// harmonic tone with stable partials crossing the gap is identifiable from the
// observed context; a stochastic inharmonic texture with the same gap width is
// not. An honest completion must behave differently on the two cases.
//
// Like src/fixtures/generate.js, the defective track is produced by zeroing
// exactly the declared STFT cells, and `truth` is withheld from the kernel.
// Nothing here is imported by the kernel or by the independent reference
// module; expected values used by acceptance live in
// data/trust-acceptance.json and are re-derived there, not copied from output.

import { stft, istft } from '../kernel/stft.js';
import { encodeWavFloat32 } from '../kernel/wav.js';

export const TRUST_FFT = 1024;
export const TRUST_HOP = 256;
const SAMPLE_RATE = 16000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harmonicTone({ t, f0, harmonics, amp, vibratoCents = 10, phaseSeed = 0 }) {
  let v = 0;
  const rand = mulberry32(9001 + phaseSeed * 977);
  const d = (vibratoCents * Math.LN2) / 1200;
  for (let h = 1; h <= harmonics; h++) {
    const jitter = 1 + (rand() - 0.5) * 0.0004;
    const fh = h * f0 * jitter;
    const phase = 2 * Math.PI * fh * t
      + (fh * d / 4.2) * (1 - Math.cos(2 * Math.PI * 4.2 * t))
      + h * 0.37 + phaseSeed;
    const a = (amp / Math.pow(h, 1.15)) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.37 * t + h));
    v += a * Math.cos(phase);
  }
  return v;
}

// Band-limited stochastic texture: summed detuned, inharmonic narrow-band
// oscillators with slow random amplitude walks, plus shaped noise. There is no
// partial lattice, so a gap cannot be continued from either boundary.
function inharmonicTexture(t, rand, state) {
  let v = 0;
  // Inharmonic partials at irrational frequency ratios, each independently
  // amplitude-modulated by a slow random walk held in `state`.
  const bases = [317.4, 463.1, 691.7, 907.3, 1153.9, 1381.2, 1627.6, 1901.8];
  for (let k = 0; k < bases.length; k++) {
    const f = bases[k] * (1 + 0.004 * Math.sin(2 * Math.PI * (0.7 + 0.13 * k) * t + k));
    state.env[k] += (rand() - 0.5) * 0.02;
    state.env[k] = Math.max(0.15, Math.min(1.0, state.env[k]));
    v += 0.085 * state.env[k] * Math.cos(2 * Math.PI * f * t + k * 1.71);
  }
  // Shaped broadband noise keeps the masked band stochastic frame to frame.
  const n = (rand() * 2 - 1) * 0.5 + (state.lastNoise * 0.5);
  state.lastNoise = n;
  const noiseGate = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.31 * t + 1.3);
  v += 0.12 * noiseGate * n;
  return v;
}

function renderSignal(def, length) {
  const truth = new Float32Array(length);
  const rand = mulberry32(def.seed);
  const state = { env: new Float64Array(8).fill(0.6), lastNoise: 0 };
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    truth[i] = def.kind === 'harmonic'
      ? harmonicTone({ t, f0: def.f0, harmonics: def.harmonics, amp: 0.5, phaseSeed: def.seed })
      : inharmonicTexture(t, rand, state);
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(truth[i]));
  if (peak > 0) {
    const gain = 0.72 / peak;
    for (let i = 0; i < length; i++) truth[i] *= gain;
  }
  return truth;
}

function carveDefect(truth, region) {
  const spec = stft(truth, { fftSize: TRUST_FFT, hop: TRUST_HOP, sampleRate: SAMPLE_RATE });
  const re = spec.re.map((row) => Float64Array.from(row));
  const im = spec.im.map((row) => Float64Array.from(row));
  const b0 = Math.max(1, Math.round(region.lowHz / spec.binHz));
  const b1 = Math.min(spec.bins - 2, Math.round(region.highHz / spec.binHz));
  let m0 = spec.frames;
  let m1 = -1;
  for (let m = 0; m < spec.frames; m++) {
    if (spec.frameTimes[m] >= region.startSec) { m0 = m; break; }
  }
  for (let m = spec.frames - 1; m >= 0; m--) {
    if (spec.frameTimes[m] <= region.endSec) { m1 = m; break; }
  }
  if (m1 < m0) throw new Error('trust fixture: region has no frames');
  for (let m = m0; m <= m1; m++) {
    for (let b = b0; b <= b1; b++) { re[m][b] = 0; im[m][b] = 0; }
  }
  const defective = istft({ ...spec, re, im });
  return {
    defective,
    grid: { frameStart: m0, frameEnd: m1, binStart: b0, binEnd: b1 },
    specMeta: { frames: spec.frames, bins: spec.bins, binHz: spec.binHz },
  };
}

// Pair A: identical geometry (same 60 ms x ~688 Hz box), opposite
// identifiability. Pair B/C sweep gap width within and beyond the model limit.
const DEF_DEFS = [
  {
    id: 'pairA-harmonic',
    title: '同宽配对 · 谐波（可辨）',
    kind: 'harmonic', f0: 196, harmonics: 16, seed: 701,
    durationSec: 2.2, pair: 'equal-width',
    region: { startSec: 0.95, endSec: 1.01, lowHz: 800, highHz: 1487.5 },
    identifiability: 'identifiable',
    description: '稳定谐波音符，缺口两侧由同一组分音轨迹贯穿；同宽缺口可从观测区辨。',
  },
  {
    id: 'pairA-inharmonic',
    title: '同宽配对 · 非谐随机（不可辨）',
    kind: 'inharmonic', seed: 702,
    durationSec: 2.2, pair: 'equal-width',
    region: { startSec: 0.95, endSec: 1.01, lowHz: 800, highHz: 1487.5 },
    identifiability: 'unidentifiable',
    description: '非谐、随机幅度纹理；缺口与配对 A 同宽同时长，但两侧无共同轨迹，缺口内容不可辨。',
  },
  {
    id: 'width-harmonic-narrow',
    title: '宽度扫描 · 谐波窄缺口',
    kind: 'harmonic', f0: 220, harmonics: 14, seed: 711,
    durationSec: 2.2, pair: 'width-sweep-harmonic',
    region: { startSec: 0.9, endSec: 1.0, lowHz: 600, highHz: 1400 },
    identifiability: 'identifiable',
    description: '谐波素材上 800 Hz 缺口，落在模型支持范围内。',
  },
  {
    id: 'width-harmonic-wide',
    title: '宽度扫描 · 谐波宽缺口（拒答）',
    kind: 'harmonic', f0: 180, harmonics: 18, seed: 712,
    durationSec: 2.2, pair: 'width-sweep-harmonic',
    region: { startSec: 0.9, endSec: 1.0, lowHz: 300, highHz: 2400 },
    identifiability: 'refused',
    description: '同一谐波族上的 2100 Hz 宽缺口，超出声明带宽上限，内核必须拒答而非硬填。',
  },
  {
    id: 'width-inharmonic-narrow',
    title: '宽度扫描 · 非谐窄缺口',
    kind: 'inharmonic', seed: 721,
    durationSec: 2.2, pair: 'width-sweep-inharmonic',
    region: { startSec: 0.9, endSec: 1.0, lowHz: 600, highHz: 1400 },
    identifiability: 'unidentifiable',
    description: '非谐素材上的同尺寸窄缺口；即使宽度受支持，先验不成立，候选必须分歧并标低置信。',
  },
  {
    id: 'width-inharmonic-wide',
    title: '宽度扫描 · 非谐宽缺口（拒答）',
    kind: 'inharmonic', seed: 722,
    durationSec: 2.2, pair: 'width-sweep-inharmonic',
    region: { startSec: 0.9, endSec: 1.0, lowHz: 300, highHz: 2400 },
    identifiability: 'refused',
    description: '非谐素材上的宽缺口；不可辨且超范围，拒答是唯一诚实输出。',
  },
  {
    id: 'prior-mismatch-noise',
    title: '先验不满足素材 · 宽频噪声',
    kind: 'inharmonic', seed: 731,
    durationSec: 2.4, pair: 'prior-violation',
    region: { startSec: 1.0, endSec: 1.12, lowHz: 500, highHz: 1900 },
    identifiability: 'unidentifiable',
    description: '纯随机纹理上 120 ms、1400 Hz 缺口；谐波/连续性先验均不成立，用于正反例的反例。',
  },
];

function makeTrustFixture(def) {
  const length = Math.round(def.durationSec * SAMPLE_RATE);
  const truth = renderSignal(def, length);
  const region = { ...def.region };
  const carved = carveDefect(truth, region);
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    kind: def.kind,
    pair: def.pair,
    identifiability: def.identifiability,
    sampleRate: SAMPLE_RATE,
    fftSize: TRUST_FFT,
    hop: TRUST_HOP,
    region,
    grid: carved.grid,
    truth,
    defective: carved.defective,
    truthWav: encodeWavFloat32(truth, SAMPLE_RATE),
    defectiveWav: encodeWavFloat32(carved.defective, SAMPLE_RATE),
  };
}

export function buildTrustFixtures() {
  return DEF_DEFS.map(makeTrustFixture);
}

export const TRUST_DEFS = DEF_DEFS;
