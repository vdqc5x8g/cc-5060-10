// Deterministic synthetic fixtures for the band-completion bench.
//
// Each fixture produces:
//   truth      full synthetic recording (never given to the kernel)
//   defective  the same recording with a declared time-frequency band removed
//   regions    declared defect regions in seconds/Hz
//   expected   what the kernel should report for the default region
//
// The defective track is created by zeroing only the declared STFT cells. This
// keeps the defect honest: the removed content is exactly what the declared
// mask says, and everything outside it is untouched observation.

import { stft, istft } from '../kernel/stft.js';
import { encodeWavFloat32 } from '../kernel/wav.js';

const FFT = 1024;
const HOP = 256;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(x) { return x * x * (3 - 2 * x); }

function harmonicNote({ t, f0, harmonics, amp, vibratoHz = 4.2, vibratoCents = 12, phaseSeed = 0 }) {
  let v = 0;
  const rand = mulberry32(1234 + phaseSeed * 977);
  const d = (vibratoCents * Math.LN2) / 1200;
  for (let h = 1; h <= harmonics; h++) {
    const jitter = 1 + (rand() - 0.5) * 0.0004;
    const fh = h * f0 * jitter;
    // Integrate the FM explicitly so the instantaneous frequency does not
    // drift with t; multiplying a time-varying f by t adds a spurious glide.
    const phase = 2 * Math.PI * fh * t
      + (fh * d / vibratoHz) * (1 - Math.cos(2 * Math.PI * vibratoHz * t))
      + h * 0.37
      + phaseSeed;
    const a = (amp / Math.pow(h, 1.15)) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.37 * t + h));
    v += a * Math.cos(phase);
  }
  return v;
}

function makeFixture(spec) {
  const { durationSec, sampleRate, render } = spec;
  const length = Math.round(durationSec * sampleRate);
  const truth = new Float32Array(length);
  const rand = mulberry32(spec.seed ?? 7);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    truth[i] = render(t, rand);
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(truth[i]));
  if (peak > 0) {
    const gain = 0.72 / peak;
    for (let i = 0; i < length; i++) truth[i] *= gain;
  }

  const defective = Float32Array.from(truth);
  const regions = spec.regions.map((r) => ({ ...r }));
  const specT = stft(truth, { fftSize: FFT, hop: HOP, sampleRate });
  const re = specT.re.map((row) => Float64Array.from(row));
  const im = specT.im.map((row) => Float64Array.from(row));
  for (const r of regions) {
    const b0 = Math.max(1, Math.round(r.lowHz / specT.binHz));
    const b1 = Math.min(specT.bins - 2, Math.round(r.highHz / specT.binHz));
    let m0 = specT.frames;
    let m1 = -1;
    for (let m = 0; m < specT.frames; m++) {
      if (specT.frameTimes[m] >= r.startSec) { m0 = m; break; }
    }
    for (let m = specT.frames - 1; m >= 0; m--) {
      if (specT.frameTimes[m] <= r.endSec) { m1 = m; break; }
    }
    if (m1 < m0) throw new Error(`fixture ${spec.id}: region has no frames`);
    for (let m = m0; m <= m1; m++) {
      for (let b = b0; b <= b1; b++) { re[m][b] = 0; im[m][b] = 0; }
    }
    r.grid = { frameStart: m0, frameEnd: m1, binStart: b0, binEnd: b1 };
  }
  const defect = istft({ ...specT, re, im });
  defective.set(defect);
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    expected: spec.expected ?? 'supported',
    truth,
    defective,
    sampleRate,
    regions,
    truthWav: encodeWavFloat32(truth, sampleRate),
    defectiveWav: encodeWavFloat32(defective, sampleRate),
  };
}

const defs = [
  {
    id: 'harmonic-short',
    title: '谐波音符 · 短缺口',
    description: '稳定谐波音符（基频约 196 Hz，含 16 次谐波与轻微颤音），在 0.90–0.95 s、520–980 Hz 被人为挖去。两侧观察一致，期望由谐波轨迹补全。',
    durationSec: 2.0,
    sampleRate: 16000,
    seed: 11,
    render: (t) => harmonicNote({ t, f0: 196, harmonics: 16, amp: 0.5, vibratoCents: 10 })
      + 0.02 * Math.sin(2 * Math.PI * 3133 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.8 * t)),
    regions: [{ startSec: 0.9, endSec: 0.95, lowHz: 520, highHz: 980 }],
    expected: 'supported',
  },
  {
    id: 'harmonic-long',
    title: '谐波音符 · 超长缺口',
    description: '同一类谐波音符，但缺口宽 450 ms，超出声明支持范围（200 ms）。期望内核拒绝补全并报告原因，而不是复制邻近频带。',
    durationSec: 2.4,
    sampleRate: 16000,
    seed: 12,
    render: (t) => harmonicNote({ t, f0: 220, harmonics: 14, amp: 0.5, vibratoCents: 14 }),
    regions: [{ startSec: 0.8, endSec: 1.25, lowHz: 500, highHz: 1000 }],
    expected: 'refused',
  },
  {
    id: 'pad-noise',
    title: '噪声铺底 · 窄带缺口',
    description: '谐波和弦叠加带限噪声铺底，在 1.00–1.07 s、800–1500 Hz 挖去。谐波性较弱，期望退化到逐频点连续性候选。',
    durationSec: 2.2,
    sampleRate: 16000,
    seed: 21,
    render: (t, rand) => {
      let v = 0;
      for (const f0 of [146.8, 185.0, 246.9]) v += harmonicNote({ t, f0, harmonics: 10, amp: 0.16, vibratoHz: 5.1, vibratoCents: 6, phaseSeed: f0 });
      let noise = 0;
      for (let k = 0; k < 3; k++) noise += (rand() * 2 - 1) / 3;
      const noiseGain = 0.10 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t));
      return v + noiseGain * noise;
    },
    regions: [{ startSec: 1.0, endSec: 1.07, lowHz: 800, highHz: 1500 }],
    expected: 'supported',
  },
  {
    id: 'conflict-or-not',
    title: '音区切换 · 相斥延拓',
    description: '缺口左前方为 220 Hz 谐波音，右后方为 330 Hz 谐波音，缺口跨越切换处。两侧证据指向互斥的延拓，期望给出左右候选与置信边界，而非单一事实。',
    durationSec: 2.2,
    sampleRate: 16000,
    seed: 31,
    render: (t) => {
      const fade = smoothstep(Math.min(1, Math.max(0, (t - 0.98) / 0.06)));
      const a = harmonicNote({ t, f0: 220, harmonics: 12, amp: 0.5, vibratoCents: 6 });
      const b = harmonicNote({ t, f0: 330, harmonics: 9, amp: 0.45, vibratoCents: 6, phaseSeed: 3 });
      return a * (1 - fade) + b * fade;
    },
    regions: [{ startSec: 0.97, endSec: 1.04, lowHz: 400, highHz: 1400 }],
    expected: 'conflict',
  },
  {
    id: 'wide-gap',
    title: '过宽缺口',
    description: '缺口频带宽度 2100 Hz，超过声明支持范围（1500 Hz）。期望拒绝并说明宽度超限。',
    durationSec: 2.0,
    sampleRate: 16000,
    seed: 41,
    render: (t) => harmonicNote({ t, f0: 180, harmonics: 18, amp: 0.5, vibratoCents: 8 }),
    regions: [{ startSec: 0.95, endSec: 1.00, lowHz: 300, highHz: 2400 }],
    expected: 'refused',
  },
  {
    id: 'clean-mid',
    title: '中频缺口 · 可支持',
    description: '长笛式音色（基频 262 Hz，强调 2–6 次谐波），0.60–0.66 s、700–1200 Hz 缺损。用于常规演示。',
    durationSec: 1.8,
    sampleRate: 16000,
    seed: 51,
    render: (t) => {
      let v = 0;
      for (let h = 1; h <= 12; h++) {
        const a = 0.5 * Math.exp(-0.5 * ((h - 3) / 2.2) ** 2) / Math.sqrt(h);
        v += a * Math.cos(2 * Math.PI * h * 262 * t + 0.4 * h + 0.05 * Math.sin(2 * Math.PI * 5.5 * t));
      }
      return v + 0.008 * Math.sin(2 * Math.PI * 4200 * t);
    },
    regions: [{ startSec: 0.6, endSec: 0.66, lowHz: 700, highHz: 1200 }],
    expected: 'supported',
  },
];

export function buildFixtures() {
  return defs.map((d) => makeFixture(d));
}

export const FIXTURE_DEFS = defs;
export { FFT, HOP };
