const state = {
  fixtures: [],
  current: null,          // { id, title, sampleRate, durationSec, regions, defectiveWav, truthWav, spectrogram }
  mode: 'fixture',        // 'fixture' | 'upload'
  upload: null,           // { wavBase64, sampleRate, durationSec, spectrogram, name }
  fftSize: 1024,
  hop: 256,
  selection: null,        // { startSec, endSec, lowHz, highHz }
  result: null,           // last /api/complete payload
  selectedCandidate: null,
  undoStack: [],
  abTimer: null,
  abFlip: false,
  drag: null,
  busy: false,
  trustFixtures: [],
};

const $ = (id) => document.getElementById(id);
const canvas = $('spec-canvas');
const ctx2d = canvas.getContext('2d');
const selRect = $('sel-rect');
const tooltip = $('tooltip');

const COLORMAP = (() => {
  // Perceptually ordered dark→teal→gold→white ramp.
  const stops = [
    [0.0, [8, 12, 20]],
    [0.18, [18, 40, 62]],
    [0.36, [22, 80, 104]],
    [0.55, [30, 132, 138]],
    [0.72, [120, 186, 128]],
    [0.86, [226, 198, 94]],
    [1.0, [255, 246, 224]],
  ];
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0]; let b = stops[stops.length - 1];
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) { a = stops[k - 1]; b = stops[k]; break; }
    }
    const span = b[0] - a[0] || 1;
    const f = (t - a[0]) / span;
    for (let c = 0; c < 3; c++) table[i * 3 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
  }
  return table;
})();

function colorFor(dbNorm) {
  const i = Math.max(0, Math.min(255, Math.round(dbNorm * 255)));
  return `rgb(${COLORMAP[i * 3]},${COLORMAP[i * 3 + 1]},${COLORMAP[i * 3 + 2]})`;
}

function setStatus(kind, text) {
  $('status-dot').className = `dot ${kind}`;
  $('status-text').textContent = text;
}

function fmtDb(v) { return v === null || v === undefined ? '—' : `${Number(v).toFixed(1)} dB`; }
function fmtPct(v) { return `${(v * 100).toFixed(0)}%`; }

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`bad JSON from ${path}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function loadFixtureList() {
  const data = await api('/api/fixtures');
  state.fixtures = data.fixtures;
  const sel = $('fixture-select');
  sel.innerHTML = '';
  for (const fx of data.fixtures) {
    const opt = document.createElement('option');
    opt.value = fx.id;
    opt.textContent = `${fx.title}（期望：${fx.expected === 'supported' ? '可补全' : fx.expected === 'refused' ? '应拒绝' : '相斥候选'}）`;
    sel.appendChild(opt);
  }
  if (data.fixtures.length) await loadFixture(data.fixtures[0].id);
}

async function loadFixture(id) {
  setStatus('busy', '载入素材…');
  const fx = await api(`/api/fixture?id=${encodeURIComponent(id)}`);
  state.current = { ...fx, id };
  state.mode = 'fixture';
  state.upload = null;
  $('fixture-desc').textContent = fx.description;
  $('audio-defect').src = wavDataUrl(fx.defectiveWav);
  state.result = null;
  state.selection = null;
  state.selectedCandidate = null;
  state.undoStack = [];
  $('undo-btn').disabled = true;
  $('complete-btn').disabled = true;
  $('clear-sel').disabled = true;
  $('sel-info').textContent = '在频谱上拖拽框选缺失区';
  resetResultPanels();
  updateSpectrogramSource(fx.spectrogram);
  draw();
  setStatus('ok', '素材就绪');
}

function wavDataUrl(base64) {
  // Browsers can read audio from a data URL; avoid object URLs so undo and A/B
  // toggling stay simple.
  return `data:audio/wav;base64,${base64}`;
}

function updateSpectrogramSource(spec) {
  state.spec = spec;
  const wrap = $('canvas-wrap');
  const targetW = Math.max(600, Math.floor(wrap.clientWidth));
  canvas.width = targetW;
  canvas.height = Math.round((targetW * 420) / 1024);
  $('axis-left').textContent = `${(spec?.timeStart ?? 0).toFixed(2)} s`;
  $('axis-right').textContent = `${(spec?.timeEnd ?? currentDuration()).toFixed(2)} s`;
  $('axis-note').textContent = `Nyquist ${(currentSampleRate() / 2).toFixed(0)} Hz`;
  drawFreqAxis();
}

function drawFreqAxis() {
  const el = $('freq-axis');
  if (!el) return;
  const nyquist = currentSampleRate() / 2;
  const H = canvas.clientHeight || canvas.height;
  const step = nyquist > 12000 ? 4000 : nyquist > 6000 ? 2000 : 1000;
  const parts = [];
  for (let f = 0; f <= nyquist + 1; f += step) {
    const y = (1 - f / nyquist) * H;
    parts.push(`<span class="freq-tick" style="top:${y.toFixed(1)}px">${f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : f}</span>`);
  }
  el.innerHTML = parts.join('');
}

// Time span actually covered by the displayed spectrogram columns.
function displayTimeRange() {
  const spec = activeSpectrogram();
  if (spec && Number.isFinite(spec.timeStart) && Number.isFinite(spec.timeEnd)) {
    return { start: spec.timeStart, end: spec.timeEnd };
  }
  return { start: 0, end: currentDuration() };
}

function currentDuration() {
  if (state.result?.regions?.length) return state.result.report.analysis.durationSec;
  return state.current?.durationSec ?? state.upload?.durationSec ?? 0;
}

function currentSampleRate() {
  return state.current?.sampleRate ?? state.upload?.sampleRate ?? 16000;
}

function activeSpectrogram() {
  if (state.result?.spectrograms?.after) return state.result.spectrograms.after;
  if (state.mode === 'upload') return state.upload.spectrogram;
  return state.current?.spectrogram;
}

function draw() {
  const spec = activeSpectrogram();
  if (!spec) return;
  const W = canvas.width;
  const H = canvas.height;
  const img = ctx2d.createImageData(W, H);
  const { frames, bins, data, floorDb } = spec;
  // X = time (frame), Y = frequency (bin), top = Nyquist, bottom = 0 Hz.
  for (let x = 0; x < W; x++) {
    const fx = Math.min(frames - 1, Math.floor((x / W) * frames));
    const row = data[fx];
    for (let y = 0; y < H; y++) {
      const fy = Math.min(bins - 1, Math.floor((1 - (y + 0.5) / H) * bins));
      const v = row[fy];
      const norm = v === null ? 0 : Math.max(0, Math.min(1, (v - floorDb) / -floorDb));
      const rgb = COLORMAP;
      const i = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      const p = (y * W + x) * 4;
      img.data[p] = rgb[i];
      img.data[p + 1] = rgb[i + 1];
      img.data[p + 2] = rgb[i + 2];
      img.data[p + 3] = 255;
    }
  }
  ctx2d.putImageData(img, 0, 0);
  drawFreqAxis();
  overlay();
}

function overlay() {
  const result = state.result;
  if (!result) { drawSelectionOverlay(); return; }
  const W = canvas.width; const H = canvas.height;
  const spec = activeSpectrogram();
  if (!spec) return;
  const frames = spec.frames; const bins = spec.bins;
  const showMask = $('show-mask').checked;
  const showFill = $('show-fill').checked;

  if (showMask) {
    const analysis = state.result.report.analysis;
    const stftBins = analysis.bins;
    const stftFrames = analysis.frames;
    const binScale = bins / stftBins;
    const dStart = spec.frameStart ?? 0;
    const dEnd = spec.frameEnd ?? (stftFrames - 1);
    const dSpan = Math.max(1, dEnd - dStart + 1);
    ctx2d.save();
    ctx2d.fillStyle = 'rgba(239,107,107,0.30)';
    for (let x = 0; x < W; x++) {
      const fx = Math.min(frames - 1, Math.floor((x / W) * frames));
      const sf = Math.min(stftFrames - 1, Math.floor(dStart + ((fx + 0.5) / frames) * dSpan));
      const runs = scaledMaskRuns(sf, stftBins);
      for (const [b0, b1] of runs) {
        const yTop = Math.floor((1 - (b1 * binScale) / bins) * H);
        const yBot = Math.ceil((1 - (b0 * binScale) / bins) * H);
        ctx2d.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
      }
    }
    ctx2d.restore();
  }
  if (showFill) {
    const chosen = chosenCandidate();
    if (chosen) {
      const grid = chosen.grid;
      const region = regionForCandidate(chosen);
      if (region) {
        const { start: t0, end: t1 } = displayTimeRange();
        const span = Math.max(1e-9, t1 - t0);
        const nyquist = currentSampleRate() / 2;
        const gx0 = ((region.startSec - t0) / span) * W;
        const gx1 = ((region.endSec - t0) / span) * W;
        const gyBot = (1 - region.lowHz / nyquist) * H;
        const gyTop = (1 - region.highHz / nyquist) * H;
        const gw = Math.max(1, gx1 - gx0);
        const gh = Math.max(1, gyBot - gyTop);
        const cellW = gw / grid.height;
        const cellH = gh / grid.width;
        ctx2d.save();
        ctx2d.globalAlpha = 0.65;
        for (let ry = 0; ry < grid.height; ry++) {
          const x0 = Math.floor(gx0 + ry * cellW);
          const xw = Math.max(1, Math.ceil(cellW));
          for (let rx = 0; rx < grid.width; rx++) {
            const v = grid.target[ry]?.[rx] ?? 0;
            if (v <= 0) continue;
            const conf = grid.conf?.[ry]?.[rx] ?? 1;
            const y0 = Math.floor(gyBot - (rx + 1) * cellH);
            const yh = Math.max(1, Math.ceil(cellH));
            const norm = Math.max(0, Math.min(1, Math.log10(1 + v * 1000) / 3));
            ctx2d.fillStyle = `rgba(${Math.round(90 + 80 * (1 - conf))},${Math.round(208 * conf + 20)},${Math.round(192 * norm)},${0.10 + 0.35 * norm})`;
            ctx2d.fillRect(x0, y0, xw, yh);
          }
        }
        ctx2d.restore();
      }
    }
  }
  drawSelectionOverlay();
}

function scaledMaskRuns(frameIndex, bins) {
  // The mask JSON is per STFT frame; the displayed spectrogram may be a
  // downsampled grid. Map proportionally.
  const runs = state.result.mask[frameIndex] ?? [];
  return runs;
}

function drawSelectionOverlay() {
  if (!state.selection) { selRect.classList.add('hidden'); return; }
  const spec = activeSpectrogram();
  if (!spec) return;
  const rect = selRectForSelection(state.selection, spec);
  const wrapRect = canvas.getBoundingClientRect();
  const wrapRect2 = $('canvas-wrap').getBoundingClientRect();
  const scaleX = wrapRect.width / canvas.width;
  const scaleY = wrapRect.height / canvas.height;
  selRect.style.left = `${canvas.offsetLeft + rect.x * scaleX}px`;
  selRect.style.top = `${canvas.offsetTop + rect.y * scaleY}px`;
  selRect.style.width = `${rect.w * scaleX}px`;
  selRect.style.height = `${rect.h * scaleY}px`;
  selRect.classList.remove('hidden');
  void wrapRect2;
}

function selRectForSelection(sel, spec) {
  const { start: t0, end: t1 } = displayTimeRange();
  const span = Math.max(1e-9, t1 - t0);
  const x = ((sel.startSec - t0) / span) * canvas.width;
  const w = ((sel.endSec - sel.startSec) / span) * canvas.width;
  // Frequency axis: bottom = 0 Hz, top = Nyquist. The display covers 0..Nyquist.
  const nyquist = currentSampleRate() / 2;
  const yFracHigh = 1 - sel.highHz / nyquist;
  const yFracLow = 1 - sel.lowHz / nyquist;
  const y = yFracHigh * canvas.height;
  const h = (yFracLow - yFracHigh) * canvas.height;
  void spec;
  return { x, y, w, h };
}

function pointToRegion(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) / rect.width;
  const py = (ev.clientY - rect.top) / rect.height;
  const { start: t0, end: t1 } = displayTimeRange();
  const nyquist = currentSampleRate() / 2;
  const t = t0 + Math.max(0, Math.min(1, px)) * (t1 - t0);
  const f = (1 - Math.max(0, Math.min(1, py))) * nyquist;
  return { t, f };
}

function beginDrag(ev) {
  if (!state.current && !state.upload) return;
  const p = pointToRegion(ev);
  state.drag = { start: p, current: p };
  updateSelectionFromDrag();
}

function moveDrag(ev) {
  if (!state.drag) return;
  state.drag.current = pointToRegion(ev);
  updateSelectionFromDrag();
  updateTooltip(ev, state.drag.current);
}

function endDrag() {
  if (!state.drag) return;
  const sel = state.selection;
  state.drag = null;
  tooltip.classList.add('hidden');
  if (!sel || (sel.endSec - sel.startSec) < 1e-3 || (sel.highHz - sel.lowHz) < 5) {
    state.selection = null;
    selRect.classList.add('hidden');
    $('complete-btn').disabled = true;
    $('clear-sel').disabled = true;
    $('sel-info').textContent = '选区过小，已忽略';
    return;
  }
  $('complete-btn').disabled = false;
  $('clear-sel').disabled = false;
  $('sel-info').textContent = `${sel.startSec.toFixed(3)}–${sel.endSec.toFixed(3)} s · ${sel.lowHz.toFixed(0)}–${sel.highHz.toFixed(0)} Hz`;
  drawSelectionOverlay();
}

function updateSelectionFromDrag() {
  const a = state.drag.start; const b = state.drag.current;
  state.selection = {
    startSec: Math.min(a.t, b.t),
    endSec: Math.max(a.t, b.t),
    lowHz: Math.min(a.f, b.f),
    highHz: Math.max(a.f, b.f),
  };
  drawSelectionOverlay();
}

function updateTooltip(ev, p) {
  const wrapRect = $('canvas-wrap').getBoundingClientRect();
  tooltip.textContent = `${p.t.toFixed(3)} s · ${p.f.toFixed(0)} Hz`;
  tooltip.style.left = `${Math.min(wrapRect.width - 120, ev.clientX - wrapRect.left + 12)}px`;
  tooltip.style.top = `${Math.max(4, ev.clientY - wrapRect.top - 26)}px`;
  tooltip.classList.remove('hidden');
}

function resetResultPanels() {
  $('report-badge').textContent = '未运行';
  $('report-badge').className = 'badge';
  $('report-summary').className = 'report-summary empty';
  $('report-summary').textContent = '运行补全后，这里会显示状态、候选假设、置信边界与一致性审计。';
  $('candidate-list').innerHTML = '';
  $('hypotheses').innerHTML = '';
  $('audit-block').innerHTML = '';
  $('eval-block').classList.add('hidden');
  $('download-result').disabled = true;
  $('ab-toggle').disabled = true;
  $('audio-result').removeAttribute('src');
}

function chosenCandidate() {
  const result = state.result;
  if (!result?.report?.regions?.length) return null;
  const region = result.report.regions[0];
  if (!region.candidates?.length) return null;
  const id = state.selectedCandidate ?? region.selectedCandidate;
  return region.candidates.find((c) => c.id === id) ?? region.candidates[0];
}

function regionForCandidate(candidate) {
  const region = state.result?.report?.regions?.[0];
  if (!region) return null;
  return { startSec: region.geometry.startSec, endSec: region.geometry.endSec };
}

async function runCompletion() {
  if (state.busy) return;
  if (!state.selection) return;
  state.busy = true;
  setStatus('busy', '运行内核…');
  $('complete-btn').disabled = true;
  try {
    const before = state.result;
    const snapshot = {
      result: before,
      selectedCandidate: state.selectedCandidate,
      defectSrc: $('audio-defect').getAttribute('src'),
    };
    const body = {
      regions: [state.selection],
      options: {
        maxGapSeconds: Number($('max-gap').value) / 1000,
        maxGapHz: Number($('max-hz').value),
        observedToleranceDb: Number($('tol-db').value),
      },
    };
    if (state.mode === 'fixture') body.fixtureId = state.current.id;
    else body.wavBase64 = state.upload.wavBase64;
    const result = await api('/api/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.undoStack.push(snapshot);
    state.result = result;
    state.selectedCandidate = result.report.regions[0]?.selectedCandidate ?? null;
    $('audio-defect').src = wavDataUrl(result.defectiveWav);
    $('audio-result').src = wavDataUrl(result.audioWav);
    $('download-result').disabled = false;
    $('ab-toggle').disabled = false;
    $('undo-btn').disabled = state.undoStack.length === 0;
    renderReport(result);
    draw();
    const status = result.report.status;
    if (status === 'refused') setStatus('warn', '内核拒绝：超出模型条件');
    else if (status === 'partial') setStatus('warn', '部分区域未处理');
    else if (status === 'inconsistent') setStatus('error', '一致性审计未通过');
    else setStatus('ok', '补全完成');
  } catch (err) {
    console.error(err);
    setStatus('error', `失败：${err.message}`);
    $('report-summary').className = 'report-summary';
    $('report-summary').textContent = `内核调用失败：${err.message}`;
  } finally {
    state.busy = false;
    $('complete-btn').disabled = !state.selection;
  }
}

function renderReport(result) {
  const report = result.report;
  const badge = $('report-badge');
  const statusMap = {
    ok: ['完成', 'ok'], partial: ['部分完成', 'warn'], refused: ['已拒绝', 'err'], inconsistent: ['审计未通过', 'err'],
  };
  const [label, kind] = statusMap[report.status] ?? [report.status, ''];
  badge.textContent = label;
  badge.className = `badge ${kind}`;

  const region = report.regions[0];
  const summary = $('report-summary');
  summary.className = 'report-summary';
  if (!region) {
    summary.innerHTML = `<div class="line">没有可显示的区域。</div>`;
    return;
  }
  if (region.status === 'unsupported') {
    summary.innerHTML = `
      <div class="line"><span class="k">状态：</span><strong style="color:var(--warn)">不支持补全</strong></div>
      ${region.reasons.map((r) => `<div class="line">· ${escapeHtml(r)}</div>`).join('')}
      <div class="line"><span class="k">处理方式：</span>保持原缺损录音不变；未复制邻近频带。</div>`;
    $('candidate-list').innerHTML = '';
    $('hypotheses').innerHTML = '';
    renderAudit(report.audit);
    $('eval-block').classList.add('hidden');
    return;
  }
  const conf = region.confidence;
  const confText = conf ? `${conf.level}（估计误差 ${conf.estimatedErrorDb} dB，区间 ${conf.band.lowerDb}–${conf.band.upperDb} dB）` : '—';
  summary.innerHTML = `
    <div class="line"><span class="k">选区：</span>${region.geometry.startSec.toFixed(3)}–${region.geometry.endSec.toFixed(3)} s · ${region.geometry.lowHz.toFixed(0)}–${region.geometry.highHz.toFixed(0)} Hz
      （${region.geometry.gapFrames} 帧 × ${region.geometry.gapBins} 频点）</div>
    <div class="line"><span class="k">选中假设：</span>${escapeHtml(region.selectedLabel)}</div>
    <div class="line"><span class="k">置信度：</span>${escapeHtml(confText)}</div>
    <div class="line"><span class="k">左右一致性：</span>相关 ${region.agreement.corr.toFixed(3)}，均方幅度差 ${region.agreement.rmsDiffDb.toFixed(1)} dB${region.conflict ? ' — <strong style="color:var(--warn)">相斥，结果仅为候选</strong>' : ''}</div>
    <div class="line"><span class="k">语义：</span>缺口内为算法估计；观测区被固定并在下方审计。</div>`;

  renderCandidates(region, result);
  renderHypotheses(region);
  renderAudit(report.audit);
  renderEvaluation(result.evaluation);
}

function renderCandidates(region, result) {
  const list = $('candidate-list');
  list.innerHTML = '';
  const wavById = new Map((result.candidateWavs ?? []).map((w) => [w.candidateId, w.wavBase64]));
  const confClass = region.confidence?.level === 'low' ? 'low' : region.confidence?.level === 'high' ? 'chosen' : 'warn';
  for (const cand of region.candidates) {
    const el = document.createElement('div');
    el.className = `candidate ${cand.id === (state.selectedCandidate ?? region.selectedCandidate) ? 'selected' : ''}`;
    el.innerHTML = `
      <div class="c-head">
        <span class="c-title">${escapeHtml(cand.label)}</span>
        <span class="chip ${cand.id === region.selectedCandidate ? 'chosen' : confClass}">${cand.id === region.selectedCandidate ? '默认选中' : '候选'}</span>
      </div>
      <div class="c-desc">${escapeHtml(cand.description)}</div>
      <canvas width="220" height="90"></canvas>
      <div class="c-desc">${cand.quality ? `匹配轨迹 ${cand.quality.matchedTracks} · 覆盖 ${fmtPct(cand.quality.frameCoverage)} · 频率残差 ${cand.quality.medianFrequencyResidualBins.toFixed(2)} bin` : ''}</div>
      <button class="ghost small cand-ab">对照播放该候选音频</button>
    `;
    el.addEventListener('click', () => {
      state.selectedCandidate = cand.id;
      state.result = { ...result, selectedOverride: cand };
      // The A/B audio must follow the selected candidate. Each candidate WAV is
      // a separate constrained reconstruction from that candidate's own target
      // grid; falling back to the default clip would be a fake comparison.
      const wav = wavById.get(cand.id);
      if (wav) $('audio-result').src = wavDataUrl(wav);
      else $('audio-result').src = wavDataUrl(result.audioWav);
      renderReport(result);
      draw();
    });
    el.querySelector('.cand-ab').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wav = wavById.get(cand.id);
      if (wav) {
        $('audio-result').src = wavDataUrl(wav);
        state.selectedCandidate = cand.id;
        renderReport(result);
      }
      playRegion('result');
    });
    list.appendChild(el);
    drawCandidatePreview(el.querySelector('canvas'), cand.grid);
  }
}

function drawCandidatePreview(cnv, grid) {
  const w = cnv.width; const h = cnv.height;
  const c = cnv.getContext('2d');
  c.fillStyle = '#0a0c11';
  c.fillRect(0, 0, w, h);
  let peak = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) peak = Math.max(peak, grid.target[y][x]);
  if (peak <= 0) return;
  for (let px = 0; px < w; px++) {
    const gy = Math.min(grid.height - 1, Math.floor((px / w) * grid.height));
    for (let py = 0; py < h; py++) {
      const gx = Math.min(grid.width - 1, Math.floor((1 - (py + 0.5) / h) * grid.width));
      const v = grid.target[gy][gx];
      const conf = grid.conf?.[gy]?.[gx] ?? 1;
      if (v <= 0) continue;
      const norm = Math.max(0, Math.min(1, Math.log10(1 + (v / peak) * 999) / 3));
      c.fillStyle = `rgba(${Math.round(90 + 120 * (1 - conf))},${Math.round(208 * conf)},${Math.round(192 * norm)},${0.25 + 0.75 * norm})`;
      c.fillRect(px, py, 1, 1);
    }
  }
}

function renderHypotheses(region) {
  const box = $('hypotheses');
  box.innerHTML = '';
  for (const h of region.hypotheses ?? []) {
    const el = document.createElement('div');
    el.className = 'hypothesis';
    el.textContent = h.statement;
    box.appendChild(el);
  }
}

function renderAudit(audit) {
  const box = $('audit-block');
  if (!audit) { box.innerHTML = ''; return; }
  const outsideOk = audit.outsideOverlapUntouched;
  const obsOk = audit.withinTolerance;
  box.innerHTML = `
    <div class="${outsideOk ? 'good' : 'bad'}">缺口窗外样本改动：${audit.outsideAffectedSpanNonZeroSamples} 个（最大 ${audit.outsideAffectedSpanMaxAbs.toExponential(2)}）— ${outsideOk ? '未触碰' : '违规'}</div>
    <div class="${obsOk ? 'good' : 'bad'}">观测区 STFT 改动：${audit.observedChangeDb.toFixed(1)} dB（声明容差 ${audit.declaredToleranceDb} dB）</div>
    <div>缺口窗内观测频点改动：${audit.adjacentObservedChangeDb.toFixed(1)} dB（窗口重叠允许的轻微变化）</div>
    <div>缺口内目标残差：${audit.targetResidualDb.toFixed(1)} dB（估计与追求的目标幅度差，非真值误差）</div>`;
}

function renderEvaluation(ev) {
  const block = $('eval-block');
  if (!ev) { block.classList.add('hidden'); return; }
  block.classList.remove('hidden');
  const content = $('eval-content');
  const rows = ev.regions.map((r) => `
    <tr class="${r.gap.improvementDb > 0 ? 'good' : 'bad'}">
      <td>${r.startSec.toFixed(3)}–${r.endSec.toFixed(3)} s<br><span class="small">${r.lowHz.toFixed(0)}–${r.highHz.toFixed(0)} Hz</span></td>
      <td class="num">${fmtDb(r.gap.bandSnrOutDb)}</td>
      <td class="num">${fmtDb(r.gap.bandSnrDefectDb)}</td>
      <td class="num">${r.gap.improvementDb > 0 ? '+' : ''}${r.gap.improvementDb.toFixed(2)} dB</td>
      <td class="num">${r.gap.correlation.toFixed(3)}</td>
      <td class="num">${fmtDb(r.gap.maskedMagnitudeErrorDb)}</td>
      <td class="num">${r.gap.copyNeighbourImprovementDb === null ? '—' : `${r.gap.copyNeighbourImprovementDb.toFixed(2)} dB`}</td>
      <td class="num">${r.knownRegion.outsideGapWindowSamplesChanged} / ${r.knownRegion.maxAbsChange.toExponential?.(2) ?? r.knownRegion.maxAbsChange}</td>
      <td class="num">${r.artifacts.crestIncrease === 0 ? '无异常' : `${r.artifacts.crestIncrease.toFixed(2)}`}</td>
    </tr>`).join('');
  content.innerHTML = `
    <table class="eval-table">
      <thead><tr>
        <th>区域</th><th>补全频带 SNR</th><th>缺损基线 SNR</th><th>提升</th><th>相关</th>
        <th>缺口幅度误差</th><th>复制邻近基线</th><th>已知区改动样本</th><th>峰值因数增量</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="eval-note">${escapeHtml(ev.summary.note)} 真值仅用于本评估（${escapeHtml(ev.truthUsedFor)}）。提升为负说明补全并不优于保持空洞，界面会如实显示。</p>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function uploadWav(file) {
  const buf = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  setStatus('busy', '分析上传音频…');
  try {
    const meta = await api('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wavBase64: base64 }),
    });
    state.mode = 'upload';
    state.current = null;
    state.upload = { wavBase64: base64, sampleRate: meta.sampleRate, durationSec: meta.durationSec, spectrogram: meta.spectrogram, name: file.name };
    state.result = null;
    state.selection = null;
    state.selectedCandidate = null;
    $('fixture-desc').textContent = `已载入 ${file.name} · ${meta.sampleRate} Hz · ${meta.durationSec.toFixed(2)} s。请框选缺失区。`;
    $('audio-defect').src = `data:audio/wav;base64,${base64}`;
    $('complete-btn').disabled = true;
    $('clear-sel').disabled = true;
    resetResultPanels();
    updateSpectrogramSource(meta.spectrogram);
    draw();
    setStatus('ok', '上传素材就绪');
  } catch (err) {
    setStatus('error', `载入失败：${err.message}`);
  }
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function undo() {
  const prev = state.undoStack.pop();
  if (!prev) return;
  state.result = prev.result;
  state.selectedCandidate = prev.selectedCandidate;
  $('undo-btn').disabled = state.undoStack.length === 0;
  if (prev.defectSrc) $('audio-defect').src = prev.defectSrc;
  if (prev.result) {
    $('audio-result').src = wavDataUrl(prev.result.audioWav);
    $('download-result').disabled = false;
    $('ab-toggle').disabled = false;
    renderReport(prev.result);
  } else {
    resetResultPanels();
    $('undo-btn').disabled = true;
  }
  draw();
  setStatus('ok', '已撤销到上一状态');
}

function clearSelection() {
  state.selection = null;
  state.drag = null;
  selRect.classList.add('hidden');
  $('complete-btn').disabled = true;
  $('clear-sel').disabled = true;
  $('sel-info').textContent = '在频谱上拖拽框选缺失区';
}

function playRegion(which) {
  const sel = state.selection;
  if (!sel) return;
  const audio = which === 'result' ? $('audio-result') : $('audio-defect');
  if (!audio.src) return;
  audio.currentTime = sel.startSec;
  audio.play();
  const stopAt = () => {
    if (audio.currentTime >= sel.endSec) {
      audio.pause();
      audio.removeEventListener('timeupdate', stopAt);
    }
  };
  audio.addEventListener('timeupdate', stopAt);
  audio._stopAt = stopAt;
}

function toggleAB() {
  if (state.abTimer) { stopAB(); return; }
  const sel = state.selection;
  if (!sel) return;
  const a = $('audio-defect');
  const b = $('audio-result');
  const span = sel.endSec - sel.startSec;
  const cycle = Math.max(0.3, span) + 0.25;
  state.abFlip = false;
  $('ab-state').textContent = 'A/B 循环中（原件 ↔ 补全）';
  const step = () => {
    const target = state.abFlip ? b : a;
    const other = state.abFlip ? a : b;
    other.pause();
    target.currentTime = sel.startSec;
    target.play();
    state.abFlip = !state.abFlip;
    clearTimeout(state.abTimer);
    state.abTimer = setTimeout(step, cycle * 1000);
  };
  step();
}

function stopAB() {
  clearTimeout(state.abTimer);
  state.abTimer = null;
  $('audio-defect').pause();
  $('audio-result').pause();
  $('ab-state').textContent = '';
}

async function runMatrix() {
  const out = $('matrix-output');
  out.innerHTML = '运行中…';
  setStatus('busy', '运行自检…');
  const rows = [];
  for (const fx of state.fixtures) {
    try {
      const meta = await api(`/api/fixture?id=${encodeURIComponent(fx.id)}`);
      const result = await api('/api/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixtureId: fx.id, regions: meta.regions, options: { observedToleranceDb: -30 } }),
      });
      const ev = result.evaluation;
      const region = result.report.regions[0];
      const statusLabel = result.report.status === 'refused' ? '拒绝（符合预期）' : result.report.status === 'ok' ? '完成' : result.report.status;
      let metrics = '';
      if (ev?.regions?.length) {
        const r = ev.regions[0];
        metrics = `提升 ${r.gap.improvementDb > 0 ? '+' : ''}${r.gap.improvementDb.toFixed(2)} dB · 相关 ${r.gap.correlation.toFixed(2)} · 已知区改动 ${r.knownRegion.outsideGapWindowSamplesChanged} 样本 · 复制邻近基线 ${r.gap.copyNeighbourImprovementDb?.toFixed(2) ?? '—'} dB`;
      } else {
        metrics = (region?.reasons ?? []).join('；') || '无评估';
      }
      rows.push({ title: fx.title, expected: fx.expected, status: result.report.status, metrics });
    } catch (err) {
      rows.push({ title: fx.title, expected: fx.expected, status: 'error', metrics: err.message });
    }
  }
  out.innerHTML = rows.map((r) => `
    <div class="matrix-row">
      <div class="m-title">${escapeHtml(r.title)}</div>
      <div class="m-status ${r.expected === 'supported' && r.status === 'ok' ? 'good' : r.status === 'refused' && r.expected === 'refused' ? 'good' : ''}">${escapeHtml(r.status)}</div>
      <div class="m-metrics">${escapeHtml(r.metrics)}</div>
    </div>`).join('');
  const refused = rows.filter((r) => r.status === 'refused').length;
  setStatus('ok', `自检完成：${rows.length} 条素材，${refused} 条按预期拒绝`);
}

// Event wiring -------------------------------------------------------------
canvas.addEventListener('pointerdown', (ev) => {
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* Firefox can reject synthetic ids */ }
  beginDrag(ev);
});
canvas.addEventListener('pointermove', moveDrag);
canvas.addEventListener('pointerup', (ev) => {
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  endDrag();
});
canvas.addEventListener('pointerleave', () => { if (!state.drag) tooltip.classList.add('hidden'); });

$('fixture-select').addEventListener('change', (e) => loadFixture(e.target.value));
$('wav-input').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) uploadWav(f); });
$('complete-btn').addEventListener('click', runCompletion);
$('clear-sel').addEventListener('click', clearSelection);
$('undo-btn').addEventListener('click', undo);
$('play-defect').addEventListener('click', () => playRegion('defect'));
$('play-result').addEventListener('click', () => playRegion('result'));
$('ab-toggle').addEventListener('click', toggleAB);
$('show-mask').addEventListener('change', draw);
$('show-fill').addEventListener('change', draw);
$('run-matrix').addEventListener('click', runMatrix);
$('download-result').addEventListener('click', () => {
  if (!state.result) return;
  const a = document.createElement('a');
  a.href = wavDataUrl(state.result.audioWav);
  a.download = 'completed.wav';
  a.click();
});
window.addEventListener('resize', () => { if (state.spec) { updateSpectrogramSource(state.spec); draw(); } });

// Trusted-region verification panel ----------------------------------------
async function loadTrustList() {
  const data = await api('/api/trust/fixtures');
  state.trustFixtures = data.fixtures;
  const sel = $('trust-select');
  sel.innerHTML = '';
  for (const fx of data.fixtures) {
    const opt = document.createElement('option');
    opt.value = fx.id;
    const label = fx.identifiability === 'refused' ? '应拒答'
      : fx.identifiability === 'unidentifiable' ? '不可辨' : '可辨';
    opt.textContent = `${fx.title}（${label}）`;
    sel.appendChild(opt);
  }
}

function trustEvidenceRows(out) {
  if (out.refused) {
    return `<div class="trust-check ${out.outputUntouched ? 'good' : 'bad'}">拒答后录音${out.outputUntouched ? '保持原样（零改动）' : '被改动（违规）'}</div>`;
  }
  const m = out.measurements ?? {};
  const checks = (out.verdict?.checks ?? []).map((c) => `
    <div class="trust-check ${c.pass ? 'good' : 'bad'}">
      <strong>${escapeHtml(c.name)}</strong>：${c.pass ? '通过' : '未通过'}
      <span class="small">${escapeHtml(JSON.stringify(c.evidence ?? {}))}</span>
    </div>`).join('');
  const k = m.known ?? {};
  const c = m.conservation ?? {};
  const d = m.divergence ?? {};
  const p = m.projection ?? {};
  const f = m.fill ?? {};
  return `
    <div class="trust-evidence">
      <div>已知区误差：池化 ${fmtDb(k.observedChangeDb)} · 窗外 ${fmtDb(k.outsideWindowChangeDb)} · 改动样本 ${k.changedSamples ?? '—'}</div>
      <div>子带守恒：最差 ${fmtDb(c.worstConservationDb)}（${(c.compartments ?? []).map((x) => `${x.name} ${x.conservationDb}dB`).join('，')}）</div>
      <div>补全一致性：残差 ${fmtDb(f.fillResidualDb)}</div>
      <div>候选分歧：均值 ${d.meanDb ?? '—'} dB · 最大 ${d.maxDb ?? '—'} dB</div>
      <div>投影下界：分歧 ${p.disagreementDb ?? '—'} dB · 下界 ${p.lowerBoundDb ?? '—'} dB · 不等式 ${p.boundHolds ? '成立' : '违反'}</div>
      <div>掩码正交拆分误差：${m.orthogonality?.splitRelativeError ?? '—'}</div>
    </div>
    ${checks}`;
}

function renderTrustResult(out) {
  const box = $('trust-output');
  const passed = out.verdict?.passed;
  const badge = passed ? '<span class="badge ok">验收通过</span>' : '<span class="badge err">验收失败</span>';
  const codes = (out.verdict?.failureCodes ?? []);
  box.innerHTML = `
    <div class="trust-head">${badge}
      <span class="hint">可辨性：${escapeHtml(out.identifiability)} · 内核状态：${escapeHtml(out.status)}${out.injectedFault ? ` · 注入故障：${escapeHtml(out.injectedFault)}` : ''}</span>
    </div>
    ${codes.length ? `<div class="bad">命名失败：${codes.map(escapeHtml).join('、')}</div>` : '<div class="good">无命名失败</div>'}
    ${(out.verdict?.failures ?? []).map((fail) => `<div class="trust-failure">· ${escapeHtml(fail.message)}</div>`).join('')}
    ${trustEvidenceRows(out)}
    <p class="eval-note">${escapeHtml(out.verdict?.evidenceBasis ?? '')}</p>`;
}

async function runTrustOne(fault) {
  const fixtureId = $('trust-select').value;
  setStatus('busy', '运行可信验证…');
  const out = await api('/api/trust/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId, fault: fault || null }),
  });
  renderTrustResult(out);
  setStatus('ok', `可信验证完成：${out.verdict?.passed ? '通过' : '失败'}`);
  return out;
}

async function runTrustAll() {
  const box = $('trust-output');
  box.innerHTML = '运行全部正反例与变异…';
  setStatus('busy', '运行可信验证套件…');
  const rows = [];
  for (const fx of state.trustFixtures ?? []) {
    const faults = fx.identifiability === 'refused' ? [null] : [null, 'known-region-pollution', 'false-confidence', 'wrong-fill'];
    for (const fault of faults) {
      try {
        const out = await api('/api/trust/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fixtureId: fx.id, fault }),
        });
        rows.push({ id: fx.id, fault: fault ?? 'clean', passed: out.verdict.passed, codes: out.verdict.failureCodes });
      } catch (err) {
        rows.push({ id: fx.id, fault: fault ?? 'clean', error: err.message });
      }
    }
  }
  box.innerHTML = rows.map((r) => `
    <div class="trust-row ${r.error ? 'bad' : r.passed ? 'good' : 'warn'}">
      <span>${escapeHtml(r.id)} / ${escapeHtml(r.fault)}</span>
      <strong>${r.error ? escapeHtml(r.error) : r.passed ? '通过' : `失败：${r.codes.join('、')}`}</strong>
    </div>`).join('');
  setStatus('ok', `可信验证套件完成：${rows.length} 条`);
}

$('trust-run')?.addEventListener('click', () => runTrustOne($('trust-fault').value).catch((err) => {
  setStatus('error', `可信验证失败：${err.message}`);
}));
$('trust-all')?.addEventListener('click', () => runTrustAll().catch((err) => {
  setStatus('error', `可信验证失败：${err.message}`);
}));

loadFixtureList().catch((err) => { console.error(err); setStatus('error', `初始化失败：${err.message}`); });
loadTrustList().catch((err) => { console.error(err); });
