// HTTP-level integration tests for the endpoints the browser depends on.
// Playwright covers pixel/click behaviour where a browser is available; these
// tests run headlessly against a real server so CI without system browsers
// still exercises the full request path, including per-candidate audio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 4297;
let server;
let base;

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  base = `http://localhost:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('server did not start');
});

test.after(async () => { server?.kill(); });

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

test('trust fixture list exposes the equal-width pair', async () => {
  const data = await fetch(`${base}/api/trust/fixtures`).then((r) => r.json());
  const ids = data.fixtures.map((f) => f.id);
  assert.ok(ids.includes('pairA-harmonic'));
  assert.ok(ids.includes('pairA-inharmonic'));
  const harmonic = data.fixtures.find((f) => f.id === 'pairA-harmonic');
  const inharmonic = data.fixtures.find((f) => f.id === 'pairA-inharmonic');
  assert.deepEqual(harmonic.region, inharmonic.region);
  assert.equal(harmonic.identifiability, 'identifiable');
  assert.equal(inharmonic.identifiability, 'unidentifiable');
});

test('clean harmonic verification passes with independent evidence', async () => {
  const out = await post('/api/trust/verify', { fixtureId: 'pairA-harmonic' });
  assert.equal(out.verdict.passed, true);
  assert.deepEqual(out.verdict.failureCodes, []);
  const m = out.measurements;
  assert.ok(m.known.observedChangeDb <= -30);
  assert.equal(m.known.outsideWindowUntouched, true);
  assert.ok(m.conservation.worstConservationDb <= -30);
  assert.equal(m.orthogonality.orthogonal, true);
  // The truth-aware scope mapping must never leave the server boundary.
  assert.equal(out.scopeCheck, undefined);
});

test('pollution, overconfidence and wrong-fill are all rejected with named codes', async () => {
  const polluted = await post('/api/trust/verify', { fixtureId: 'pairA-harmonic', fault: 'known-region-pollution' });
  assert.equal(polluted.verdict.passed, false);
  assert.ok(polluted.verdict.failureCodes.includes('known-pollution'));

  const overconf = await post('/api/trust/verify', { fixtureId: 'prior-mismatch-noise', fault: 'false-confidence' });
  assert.equal(overconf.verdict.passed, false);
  assert.ok(overconf.verdict.failureCodes.includes('false-confidence'));

  const wrong = await post('/api/trust/verify', { fixtureId: 'pairA-harmonic', fault: 'wrong-fill' });
  assert.equal(wrong.verdict.passed, false);
  assert.ok(wrong.verdict.failureCodes.includes('fill-inconsistency'));
  // Known region stays clean while the fill check independently fires.
  assert.ok(wrong.measurements.known.observedChangeDb <= -30);
});

test('refused trust fixtures return the untouched recording and a pass verdict', async () => {
  const out = await post('/api/trust/verify', { fixtureId: 'width-harmonic-wide' });
  assert.equal(out.refused, true);
  assert.equal(out.outputUntouched, true);
  assert.equal(out.verdict.passed, true);
});

test('/api/complete returns distinct reconstructed WAV per candidate', async () => {
  const payload = await post('/api/complete', {
    fixtureId: 'harmonic-short',
    regions: [{ startSec: 0.9, endSec: 0.95, lowHz: 520, highHz: 980 }],
  });
  assert.equal(payload.report.status, 'ok');
  const region = payload.report.regions[0];
  assert.ok(region.candidates.length >= 2);
  assert.equal(payload.candidateWavs.length, region.candidates.length);
  const wavs = payload.candidateWavs.map((w) => w.wavBase64);
  assert.equal(new Set(wavs).size, wavs.length, 'candidate WAVs must be distinct reconstructions');
  // The chosen candidate's WAV corresponds to the main output's reconstruction.
  const chosen = payload.candidateWavs.find((w) => w.candidateId === region.selectedCandidate);
  assert.ok(chosen.wavBase64.length > 0);
  // Every candidate WAV must be a real RIFF WAVE, not a placeholder.
  for (const w of payload.candidateWavs) {
    const head = Buffer.from(w.wavBase64, 'base64').subarray(0, 4).toString('ascii');
    assert.equal(head, 'RIFF');
  }
});

test('completion request can still opt out of candidate audio payloads', async () => {
  const payload = await post('/api/complete', {
    fixtureId: 'harmonic-short',
    includePreviewAudio: false,
    regions: [{ startSec: 0.9, endSec: 0.95, lowHz: 520, highHz: 980 }],
  });
  assert.deepEqual(payload.candidateWavs, []);
  assert.ok(payload.audioWav.length > 0);
});
