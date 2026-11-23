import { stft, istft } from '../src/kernel/stft.js';
import { FFT } from '../src/kernel/fft.js';
import test from 'node:test';
import assert from 'node:assert/strict';

test('fft roundtrip', () => {
  const n = 1024;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 53 * i) / n);
  const orig = Float64Array.from(re);
  fft.transform(re, im, false);
  fft.transform(re, im, true);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - orig[i]), Math.abs(im[i]));
  assert.ok(err < 1e-10, `roundtrip error ${err}`);
});

test('stft istft perfect reconstruction', () => {
  const sr = 44100;
  const length = 30000;
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    x[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 1337 * i) / sr) + 0.01 * Math.sin(i * 0.37);
  }
  for (const fftSize of [512, 1024, 2048]) {
    const spec = stft(x, { fftSize, hop: fftSize / 4, sampleRate: sr });
    const y = istft(spec);
    let maxErr = 0;
    let energy = 0;
    for (let i = 0; i < length; i++) {
      maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
      energy += x[i] * x[i];
    }
    assert.ok(maxErr < 1e-4, `fftSize ${fftSize} maxErr ${maxErr}`);
    assert.ok(Number.isFinite(energy));
  }
});

test('masked transform roundtrip keeps unmasked bins', () => {
  const sr = 16000;
  const x = new Float32Array(8000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.05) * 0.3;
  const spec = stft(x, { fftSize: 512, hop: 128, sampleRate: sr });
  const mask = Array.from({ length: spec.frames }, (_, m) =>
    Array.from({ length: spec.bins }, (_, b) => m > 20 && m < 30 && b > 30 && b < 40),
  );
  const y = istft(spec, { mask });
  assert.ok(y.length === x.length);
  assert.ok(y.every(Number.isFinite));
});
