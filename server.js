import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeBands, reconstructConstrained, analyzeAudio } from './src/kernel/complete.js';
import { evaluateCompletion } from './src/eval/evaluate.js';
import { decodeWav, encodeWavPcm16, toBase64, fromBase64 } from './src/kernel/wav.js';
import { buildFixtures, FIXTURE_DEFS } from './src/fixtures/generate.js';
import { buildTrustFixtures, TRUST_DEFS } from './src/trust/fixtures-trust.js';
import { runTrustVerification } from './src/trust/runner.js';
import { polluteKnownRegion, injectOverconfidence, injectWrongFill } from './src/trust/faults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 4173);

const fixtures = new Map();
for (const fx of buildFixtures()) {
  fixtures.set(fx.id, fx);
}
const trustFixtures = new Map();
for (const fx of buildTrustFixtures()) {
  trustFixtures.set(fx.id, fx);
}
console.log(`[bench] fixtures ready: ${[...fixtures.keys()].join(', ')}`);
console.log(`[bench] trust fixtures ready: ${[...trustFixtures.keys()].join(', ')}`);

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function downsampleDb(grid, frames, bins, maxFrames, maxBins, frameStart = 0, frameEnd = frames - 1) {
  // dB magnitude grid for display, with null (not -Infinity) for silence so the
  // client can render mask-only cells distinctly.
  const span = Math.max(1, frameEnd - frameStart + 1);
  const outFrames = Math.min(span, maxFrames);
  const outBins = Math.min(bins, maxBins);
  const df = span / outFrames;
  const db2 = bins / outBins;
  const data = new Array(outFrames);
  let peak = 0;
  for (let y = 0; y < outFrames; y++) {
    // Plain Array: null must survive as a mask-only marker; a Float32Array would
    // coerce the null floor marker to 0 and render silence as peak brightness.
    const row = new Array(outBins);
    const m0 = frameStart + Math.floor(y * df);
    const m1 = Math.max(m0 + 1, frameStart + Math.floor((y + 1) * df));
    for (let x = 0; x < outBins; x++) {
      const b0 = Math.floor(x * db2);
      const b1 = Math.max(b0 + 1, Math.floor((x + 1) * db2));
      let acc = 0; let n = 0;
      for (let m = m0; m < m1 && m < frames; m++) {
        const mag = grid[m];
        if (!mag) continue;
        for (let b = b0; b < b1 && b < bins; b++) { acc += mag[b] * mag[b]; n++; }
      }
      const rms = n ? Math.sqrt(acc / n) : 0;
      row[x] = rms > 0 ? 20 * Math.log10(rms) : -160;
      peak = Math.max(peak, row[x]);
    }
    data[y] = row;
  }
  const floorDb = -80;
  for (let y = 0; y < outFrames; y++) {
    const row = data[y];
    for (let x = 0; x < outBins; x++) {
      const v = row[x] - peak;
      row[x] = v < floorDb ? null : v;
    }
  }
  return {
    frames: outFrames, bins: outBins, floorDb, peakDb: Number(peak.toFixed(2)),
    frameStart, frameEnd, data,
  };
}

function contentFrameRange(spec) {
  // Restrict the display to frames whose analysis window lies fully inside the
  // recording. Frames at the edges use reflected padding, which shows up as a
  // broadband stripe that is not in the audio, and would compress the time axis.
  const half = spec.fftSize / 2 / spec.sampleRate;
  const duration = spec.length / spec.sampleRate;
  let start = 0;
  while (start < spec.frames - 1 && spec.frameTimes[start] - half < 0) start++;
  let end = spec.frames - 1;
  while (end > start && spec.frameTimes[end] + half > duration) end--;
  return { start, end };
}

function displaySpectrogram(spec, grid) {
  const range = contentFrameRange(spec);
  const out = downsampleDb(grid, spec.frames, spec.bins, 512, 320, range.start, range.end);
  // Exact time span the displayed columns cover, so the client maps selection
  // pixels to the same seconds the image shows.
  const times = [];
  for (let m = range.start; m <= range.end; m++) times.push(spec.frameTimes[m]);
  out.timeStart = times[0] ?? 0;
  out.timeEnd = times[times.length - 1] ?? spec.duration;
  out.timePerColumn = times.length > 1 ? (out.timeEnd - out.timeStart) / (times.length - 1) : 0;
  return out;
}

function magnitudeFromAudio(audio, sampleRate, fftSize = 1024, hop = 256) {
  // Decode-free magnitude grid sharing the kernel STFT so display aligns.
  return import('./src/kernel/stft.js').then(({ stft }) => {
    const spec = stft(audio, { fftSize, hop, sampleRate });
    const grid = new Array(spec.frames);
    for (let m = 0; m < spec.frames; m++) {
      const row = new Float64Array(spec.bins);
      for (let b = 0; b < spec.bins; b++) row[b] = Math.hypot(spec.re[m][b], spec.im[m][b]);
      grid[m] = row;
    }
    return { spec, grid };
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 40 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseRegions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('regions must be a non-empty array');
  return raw.map((r, i) => {
    const region = {
      startSec: Number(r.startSec),
      endSec: Number(r.endSec),
      lowHz: Number(r.lowHz),
      highHz: Number(r.highHz),
    };
    for (const key of Object.keys(region)) {
      if (!Number.isFinite(region[key])) throw new Error(`region ${i}: ${key} must be a finite number`);
    }
    return region;
  });
}

function parseWavBuffer(buf) {
  return decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/fixtures') {
      return json(res, 200, {
        fixtures: [...fixtures.values()].map((fx) => ({
          id: fx.id,
          title: fx.title,
          description: fx.description,
          expected: fx.expected,
          sampleRate: fx.sampleRate,
          durationSec: fx.truth.length / fx.sampleRate,
          regions: fx.regions.map(({ startSec, endSec, lowHz, highHz }) => ({ startSec, endSec, lowHz, highHz })),
        })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/fixture') {
      const id = url.searchParams.get('id');
      const fx = fixtures.get(id);
      if (!fx) return json(res, 404, { error: 'unknown fixture' });
      const defect = await magnitudeFromAudio(fx.defective, fx.sampleRate);
      return json(res, 200, {
        id: fx.id,
        title: fx.title,
        description: fx.description,
        sampleRate: fx.sampleRate,
        durationSec: fx.truth.length / fx.sampleRate,
        regions: fx.regions.map(({ startSec, endSec, lowHz, highHz }) => ({ startSec, endSec, lowHz, highHz })),
        defectiveWav: toBase64(fx.defectiveWav),
        truthWav: toBase64(fx.truthWav),
        spectrogram: displaySpectrogram(defect.spec, defect.grid),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!body.wavBase64) return json(res, 400, { error: 'wavBase64 required' });
      const decoded = parseWavBuffer(fromBase64(body.wavBase64));
      const grid = await magnitudeFromAudio(decoded.mono, decoded.sampleRate);
      return json(res, 200, {
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        durationSec: decoded.mono.length / decoded.sampleRate,
        spectrogram: displaySpectrogram(grid.spec, grid.grid),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/complete') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const { fixtureId, wavBase64, regions, options } = body;
      let audio;
      let sampleRate;
      let recognized = null;
      if (fixtureId) {
        const fx = fixtures.get(fixtureId);
        if (!fx) return json(res, 404, { error: 'unknown fixture' });
        audio = fx.defective;
        sampleRate = fx.sampleRate;
        recognized = { truthAvailable: true };
      } else if (wavBase64) {
        const decoded = parseWavBuffer(fromBase64(wavBase64));
        audio = decoded.mono;
        sampleRate = decoded.sampleRate;
      } else {
        return json(res, 400, { error: 'provide fixtureId or wavBase64' });
      }
      if (!Number.isFinite(sampleRate) || sampleRate < 4000) return json(res, 400, { error: 'unsupported sample rate' });
      const parsedRegions = parseRegions(regions);
      const includeCandidates = body.includePreviewAudio !== false;
      const result = completeBands({
        audio,
        sampleRate,
        regions: parsedRegions,
        includePreviewAudio: includeCandidates,
        options: options ?? {},
      });
      const outBytes = encodeWavPcm16(result.audio, sampleRate);
      const before = await magnitudeFromAudio(audio, sampleRate);
      const after = await magnitudeFromAudio(result.audio, sampleRate);
      // Materialize a real reconstructed WAV per candidate so the UI can do an
      // honest A/B: every candidate waveform comes from reconstructConstrained
      // with that candidate's own target grid, never from a shared fixed clip.
      const candidateWavs = [];
      if (includeCandidates) {
        const { spec } = analyzeAudio(audio, { sampleRate, fftSize: result.specMeta.fftSize, hop: result.specMeta.hop });
        for (const region of result.report.regions) {
          if (region.status !== 'completed') continue;
          const g = region.geometry;
          for (const cand of region.candidates) {
            const fullTarget = result.target.map((row) => Float64Array.from(row));
            if (cand.id !== region.selectedCandidate) {
              for (let y = 0; y < cand.grid.height; y++) {
                for (let x = 0; x < cand.grid.width; x++) {
                  fullTarget[g.frameStart + y][g.binStart + x] = cand.grid.target[y][x];
                }
              }
            }
            const recon = reconstructConstrained({
              spec, mask: result.mask, target: fullTarget, iterations: 24,
            });
            candidateWavs.push({
              regionIndex: result.report.regions.indexOf(region),
              candidateId: cand.id,
              wavBase64: toBase64(encodeWavPcm16(recon.audio, sampleRate)),
            });
          }
        }
      }
      const payload = {
        report: serializeReport(result.report, sampleRate),
        mask: serializeMask(result.mask),
        target: serializeGrid(result.target),
        confidence: serializeGrid(result.confidence),
        audioWav: toBase64(outBytes),
        candidateWavs,
        defectiveWav: toBase64(encodeWavPcm16(audio, sampleRate)),
        spectrograms: {
          before: displaySpectrogram(before.spec, before.grid),
          after: displaySpectrogram(after.spec, after.grid),
        },
        regions: parsedRegions,
        recognized,
      };
      if (recognized?.truthAvailable) {
        const fx = fixtures.get(fixtureId);
        payload.evaluation = evaluateCompletion({
          truth: fx.truth,
          defective: fx.defective,
          reconstructed: result.audio,
          result,
          sampleRate,
          regions: parsedRegions,
        });
      } else if (body.truthWavBase64) {
        // Only used for the explicit "synthetic truth check" upload path. The
        // kernel above never received this track.
        const truthDecoded = parseWavBuffer(fromBase64(body.truthWavBase64));
        if (truthDecoded.sampleRate === sampleRate && truthDecoded.frames === audio.length) {
          payload.evaluation = evaluateCompletion({
            truth: truthDecoded.mono,
            defective: audio,
            reconstructed: result.audio,
            result,
            sampleRate,
            regions: parsedRegions,
          });
        } else {
          payload.evaluationError = 'truth track must match the recording length and sample rate';
        }
      }
      return json(res, 200, payload);
    }
    if (req.method === 'GET' && url.pathname === '/api/trust/fixtures') {
      return json(res, 200, {
        fixtures: [...trustFixtures.values()].map((fx) => ({
          id: fx.id,
          title: fx.title,
          description: fx.description,
          pair: fx.pair,
          kind: fx.kind,
          identifiability: fx.identifiability,
          sampleRate: fx.sampleRate,
          region: fx.region,
        })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/trust/fixture') {
      const id = url.searchParams.get('id');
      const fx = trustFixtures.get(id);
      if (!fx) return json(res, 404, { error: 'unknown trust fixture' });
      const defect = await magnitudeFromAudio(fx.defective, fx.sampleRate);
      return json(res, 200, {
        id: fx.id,
        title: fx.title,
        description: fx.description,
        pair: fx.pair,
        kind: fx.kind,
        identifiability: fx.identifiability,
        sampleRate: fx.sampleRate,
        region: fx.region,
        defectiveWav: toBase64(fx.defectiveWav),
        spectrogram: displaySpectrogram(defect.spec, defect.grid),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/trust/verify') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const fx = trustFixtures.get(body.fixtureId);
      if (!fx) return json(res, 404, { error: 'unknown trust fixture' });
      const fault = body.fault ?? null;
      const allowed = [null, 'known-region-pollution', 'false-confidence', 'wrong-fill'];
      if (!allowed.includes(fault)) return json(res, 400, { error: 'unsupported fault' });
      let overrides = { withTruth: false };
      if (fault) {
        const result = completeBands({
          audio: fx.defective, sampleRate: fx.sampleRate, fftSize: fx.fftSize, hop: fx.hop,
          regions: [{ ...fx.region }], options: {},
        });
        if (fault === 'known-region-pollution') {
          overrides = {
            fault,
            polluted: polluteKnownRegion({
              reconstructed: result.audio, mask: result.mask, grid: fx.grid,
              fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
            }),
          };
        } else if (fault === 'false-confidence') {
          const mutated = injectOverconfidence(result.report);
          overrides = {
            fault,
            overconfidentReport: mutated.report,
            mask: result.mask,
            target: result.target,
            attributedFrames: result.attributedFrames,
          };
        } else {
          overrides = {
            fault,
            wrongFill: injectWrongFill({
              reconstructed: result.audio, mask: result.mask,
              fftSize: fx.fftSize, hop: fx.hop, sampleRate: fx.sampleRate,
            }),
          };
        }
      }
      const out = runTrustVerification(fx, overrides);
      return json(res, 200, sanitizeTrustResult(out));
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, fixtures: FIXTURE_DEFS.length, trustFixtures: TRUST_DEFS.length });
    }
    if (req.method === 'GET') {
      let safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      if (safePath === '/' || safePath === '\\') safePath = '/index.html';
      const filePath = path.join(PUBLIC, safePath);
      if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
      try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('not a file');
        const data = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(data);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error('[bench] request failed:', err);
    return json(res, 500, { error: err.message ?? 'internal error' });
  }
});

function serializeMask(mask) {
  // Run-length encode rows as [startBin, endBin+1] pairs to keep JSON small.
  const rows = [];
  for (const row of mask) {
    const runs = [];
    let start = -1;
    for (let b = 0; b <= row.length; b++) {
      const on = b < row.length && row[b] === 1;
      if (on && start < 0) start = b;
      if (!on && start >= 0) { runs.push([start, b]); start = -1; }
    }
    rows.push(runs);
  }
  return rows;
}

function serializeGrid(grid) {
  return grid.map((row) => {
    const out = new Array(row.length);
    for (let b = 0; b < row.length; b++) {
      const v = row[b];
      out[b] = Number.isFinite(v) && v > 0 ? Number(v.toFixed(6)) : 0;
    }
    return out;
  });
}

// Strip any truth-aware scope fields and audio buffers; the browser only needs
// verdict + independent evidence, never the withheld truth track.
function sanitizeTrustResult(out) {
  const clone = structuredClone(out);
  delete clone.scopeCheck;
  return clone;
}

function serializeReport(report, sampleRate) {
  return {
    ...report,
    sampleRate,
    regions: report.regions.map((region) => ({
      ...region,
      candidates: (region.candidates ?? []).map((cand) => ({
        ...cand,
        grid: {
          height: cand.grid.height,
          width: cand.grid.width,
          target: serializeGrid(cand.grid.target),
          conf: cand.grid.conf ? serializeGrid(cand.grid.conf) : null,
        },
        previewAudio: undefined,
      })),
    })),
  };
}

server.listen(PORT, () => {
  console.log(`[bench] http://localhost:${PORT}`);
});
