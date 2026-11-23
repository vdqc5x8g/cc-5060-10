const RIFF = 0x52494646;
const WAVE = 0x57415645;
const FMT = 0x666d7420;
const DATA = 0x64617461;
const FACT = 0x66616374;

function readAscii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 44) throw new Error('WAV file is too short');
  if (view.getUint32(0, false) !== RIFF || view.getUint32(8, false) !== WAVE) {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === FMT) {
      let audioFormat = view.getUint16(body, true);
      if (audioFormat === 0xfffe && size >= 40) audioFormat = view.getUint16(body + 24, true);
      fmt = {
        audioFormat,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === DATA) {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV fmt chunk missing');
  if (dataOffset < 0) throw new Error('WAV data chunk missing');
  const { channels, sampleRate, bitsPerSample } = fmt;
  if (channels < 1 || channels > 8) throw new Error('Unsupported channel count');
  if (sampleRate < 4000 || sampleRate > 384000) throw new Error('Unsupported sample rate');
  const bytesPerSample = bitsPerSample / 8;
  if (![1, 2, 3, 4].includes(bytesPerSample)) throw new Error('Unsupported WAV sample width');
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const mono = new Float32Array(frames);
  const interleaved = new Float32Array(frames * channels);
  const scale = bytesPerSample === 4 && fmt.audioFormat === 3 ? 1 : Math.pow(2, bitsPerSample - 1);
  let p = dataOffset;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      let v;
      if (bytesPerSample === 1) v = (view.getUint8(p) - 128) / 128;
      else if (bytesPerSample === 2) v = view.getInt16(p, true) / scale;
      else if (bytesPerSample === 3) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getUint8(p + 2);
        let x = (b2 << 16) | (b1 << 8) | b0;
        if (x & 0x800000) x |= 0xff000000;
        v = x / 8388608;
      } else {
        v = fmt.audioFormat === 3 ? view.getFloat32(p, true) : view.getInt32(p, true) / scale;
      }
      interleaved[f * channels + c] = v;
      sum += v;
      p += bytesPerSample;
    }
    mono[f] = sum / channels;
  }
  return { sampleRate, channels, bitsPerSample, audioFormat: fmt.audioFormat, mono, interleaved, frames };
}

export function encodeWavFloat32(samples, sampleRate) {
  const frames = samples.length;
  const dataBytes = frames * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) view.setFloat32(44 + i * 4, samples[i], true);
  return new Uint8Array(buffer);
}

export function encodeWavPcm16(samples, sampleRate) {
  const frames = samples.length;
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
  }
  return new Uint8Array(buffer);
}

export function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(b64) {
  return Buffer.from(b64, 'base64');
}
