import { FFT } from './fft.js';

export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function reflectIndex(i, length) {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  let x = ((i % period) + period) % period;
  if (x >= length) x = period - x;
  return x;
}

export function padReflect(x, left, right) {
  const out = new Float64Array(x.length + left + right);
  for (let i = 0; i < left; i++) out[i] = x[reflectIndex(i - left, x.length)];
  out.set(x, left);
  for (let i = 0; i < right; i++) out[left + x.length + i] = x[reflectIndex(x.length + i, x.length)];
  return out;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function stft(x, options = {}) {
  const fftSize = options.fftSize ?? 2048;
  const hop = options.hop ?? fftSize / 4;
  const sampleRate = options.sampleRate ?? 44100;
  if ((fftSize & (fftSize - 1)) !== 0) throw new Error('fftSize must be a power of two');
  if (hop < 1 || hop > fftSize) throw new Error('hop must be between 1 and fftSize');
  const window = options.window ?? hannPeriodic(fftSize);
  if (window.length !== fftSize) throw new Error('window length must equal fftSize');
  const padLeft = options.padLeft ?? fftSize;
  const padRight = options.padRight ?? fftSize + hop;
  const padded = padReflect(x, padLeft, padRight);
  const frameCount = Math.floor((padded.length - fftSize) / hop) + 1;
  const bins = fftSize / 2 + 1;
  const re = [];
  const im = [];
  const scratchRe = new Float64Array(fftSize);
  const scratchIm = new Float64Array(fftSize);
  const fft = new FFT(fftSize);
  const frameTimes = new Float64Array(frameCount);
  for (let m = 0; m < frameCount; m++) {
    const start = m * hop;
    for (let n = 0; n < fftSize; n++) {
      scratchRe[n] = padded[start + n] * window[n];
      scratchIm[n] = 0;
    }
    fft.transform(scratchRe, scratchIm, false);
    const fr = new Float64Array(bins);
    const fi = new Float64Array(bins);
    fr.set(scratchRe.subarray(0, bins));
    fi.set(scratchIm.subarray(0, bins));
    re.push(fr);
    im.push(fi);
    frameTimes[m] = (start + fftSize / 2 - padLeft) / sampleRate;
  }
  return {
    re, im, frames: frameCount, bins, fftSize, hop, sampleRate,
    window, padLeft, padRight, paddedLength: padded.length,
    frameTimes, binHz: sampleRate / fftSize,
    duration: x.length / sampleRate,
    length: x.length,
  };
}

export function istft(spectrogram) {
  const { re, im, frames, bins, fftSize, hop, window, padLeft, paddedLength, length } = spectrogram;
  const scratchRe = new Float64Array(fftSize);
  const scratchIm = new Float64Array(fftSize);
  const fft = new FFT(fftSize);
  const out = new Float64Array(paddedLength);
  const norm = new Float64Array(paddedLength);
  for (let m = 0; m < frames; m++) {
    scratchRe.fill(0);
    scratchIm.fill(0);
    scratchRe.set(re[m]);
    scratchIm.set(im[m]);
    for (let b = 1; b < bins - 1; b++) {
      scratchRe[fftSize - b] = re[m][b];
      scratchIm[fftSize - b] = -im[m][b];
    }
    fft.transform(scratchRe, scratchIm, true);
    const start = m * hop;
    for (let n = 0; n < fftSize; n++) {
      const w = window[n];
      out[start + n] += scratchRe[n] * w;
      norm[start + n] += w * w;
    }
  }
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const n = norm[padLeft + i];
    result[i] = n > 1e-12 ? out[padLeft + i] / n : 0;
  }
  return result;
}

export function magnitude(spectrogram) {
  const mags = [];
  for (let m = 0; m < spectrogram.frames; m++) {
    const a = new Float64Array(spectrogram.bins);
    const { re, im } = spectrogram;
    for (let b = 0; b < spectrogram.bins; b++) a[b] = Math.hypot(re[m][b], im[m][b]);
    mags.push(a);
  }
  return mags;
}

export function stftOfMasked(spectrogram, mask, fill = null) {
  const re = [];
  const im = [];
  for (let m = 0; m < spectrogram.frames; m++) {
    const fr = new Float64Array(spectrogram.bins);
    const fi = new Float64Array(spectrogram.bins);
    for (let b = 0; b < spectrogram.bins; b++) {
      if (fill && fill[m] && fill[m][b]) {
        fr[b] = fill[m][b][0];
        fi[b] = fill[m][b][1];
      } else if (!mask || !mask[m] || !mask[m][b]) {
        fr[b] = spectrogram.re[m][b];
        fi[b] = spectrogram.im[m][b];
      }
    }
    re.push(fr);
    im.push(fi);
  }
  return { ...spectrogram, re, im };
}

export function maskedComponent(spectrogram, mask) {
  return istft(stftOfMasked(spectrogram, mask));
}
