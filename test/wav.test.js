import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeWav, encodeWavFloat32, encodeWavPcm16, toBase64, fromBase64,
} from '../src/kernel/wav.js';

function bufOf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

test('float32 wav roundtrip preserves samples', () => {
  const sr = 16000;
  const x = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
  const bytes = encodeWavFloat32(x, sr);
  const dec = decodeWav(bufOf(bytes));
  assert.equal(dec.sampleRate, sr);
  assert.equal(dec.channels, 1);
  assert.equal(dec.frames, x.length);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(dec.mono[i] - x[i]) < 1e-6);
});

test('pcm16 wav clamps and quantizes', () => {
  const sr = 8000;
  const x = new Float32Array([0, 0.25, -0.25, 1.5, -1.5]);
  const dec = decodeWav(bufOf(encodeWavPcm16(x, sr)));
  assert.equal(dec.bitsPerSample, 16);
  assert.equal(dec.frames, x.length);
  assert.ok(Math.abs(dec.mono[1] - 0.25) < 1e-3);
  assert.ok(dec.mono[3] <= 1 && dec.mono[3] > 0.99, 'positive clamp');
  assert.ok(dec.mono[4] >= -1 && dec.mono[4] < -0.99, 'negative clamp');
});

test('base64 roundtrip is byte-exact', () => {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
  const back = fromBase64(toBase64(bytes));
  assert.equal(back.length, bytes.length);
  for (let i = 0; i < bytes.length; i++) assert.equal(back[i], bytes[i]);
});

test('decode rejects non-wav input', () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.throws(() => decodeWav(bufOf(junk)));
});
