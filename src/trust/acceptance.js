// Acceptance layer for trusted-region verification.
//
// Consumes ONLY independent-reference measurements (reference.js /
// projection-limit.js) plus the candidate/uncertainty payload the pipeline
// reports. It never imports the kernel and never reads pre-gap truth, so a run
// cannot pass by reusing the numbers it is being judged on.
//
// Named failure modes, exactly per the brief:
//   false-confidence   an unidentifiable gap is presented as one certain answer
//   known-pollution    observed cells/samples were moved
//   conservation-breach energy changed inside a reference subband
//   missing-uncertainty identifiable-limit material without a valid refusal
//
// Thresholds are physical tolerances on the STFT reconstruction (the same
// -30/-120 dB scale the kernel declares) plus divergence gates measured in
// normalized grid distance; each constant below is annotated with its basis.

export const ACCEPTANCE_THRESHOLDS = Object.freeze({
  // Observed cells inside mask-overlap frames must stay within the kernel's
  // declared observed-region tolerance.
  observedChangeDbMax: -30,
  // Frames whose analysis window never overlaps the mask must be untouched;
  // float reconstruction noise sits near -150 dB, so -120 dB is a loose gate.
  outsideWindowDbMax: -120,
  // Reference subband energy may not move by more than 1 part in 1000.
  subbandConservationDbMax: -30,
  // The output's masked-cell magnitude must follow the declared target grid;
  // phase retrieval converges below -10 dB on clean runs, so a residual above
  // this gate means the delivered waveform no longer matches the candidate
  // being shown.
  fillResidualDbMax: -8,
  // Normalized pairwise candidate distance above which hypotheses count as
  // genuinely divergent (shape cosine below ~0.9 at this distance).
  divergenceDbMin: -22,
  // Below this normalized distance two candidates are effectively identical,
  // i.e. the pipeline is only pretending to offer alternatives.
  divergenceDbCollapse: -40,
  // Projection disagreement large enough to certify real uncertainty.
  projectionDisagreementDbMin: -24,
  // A harmonic prior needs an autocorrelation periodicity clearly above chance.
  periodicityMin: 0.45,
});

const T = ACCEPTANCE_THRESHOLDS;

function add(failures, code, message, evidence) {
  failures.push({ code, message, evidence });
}

// `payload` fields:
//   status, regionStatus, confidenceLevel, candidateCount, conflict,
//   identifiability ('identifiable' | 'unidentifiable' | 'refused'),
//   known ({observedChangeDb, outsideWindowChangeDb, outsideWindowUntouched,
//           changedSamples}),
//   conservation ({worstConservationDb, compartments}),
//   divergence ({meanDb, maxDb, pairs}),
//   projection ({disagreementDb, lowerBoundDb, residuals, boundHolds}),
//   fault (optional injected fault label, echoed for traceability)
export function judgeAcceptance(payload) {
  const failures = [];
  const checks = [];
  const p = payload;

  // Refused gaps are honest only when the material actually lies outside the
  // model's declared support; refusal itself needs no fill verification.
  if (p.regionStatus === 'unsupported' || p.identifiability === 'refused') {
    if (p.regionStatus !== 'unsupported') {
      add(failures, 'missing-uncertainty',
        'out-of-support material was not refused', { regionStatus: p.regionStatus });
    }
    checks.push({ name: 'refusal-honest', pass: failures.length === 0 });
    return verdict(p, failures, checks);
  }

  // (1) Known-region preservation. Any observed change beyond tolerance is the
  // named "polluted known sample" failure.
  const k = p.known ?? {};
  const observedOk = (k.observedChangeDb ?? Infinity) <= T.observedChangeDbMax;
  const untouchedOk = (k.outsideWindowChangeDb ?? Infinity) <= T.outsideWindowDbMax
    && (k.outsideWindowUntouched !== false);
  checks.push({
    name: 'known-region-error',
    pass: observedOk && untouchedOk,
    evidence: {
      observedChangeDb: k.observedChangeDb,
      outsideWindowChangeDb: k.outsideWindowChangeDb,
      changedSamples: k.changedSamples,
      toleranceDb: T.observedChangeDbMax,
    },
  });
  if (!observedOk || !untouchedOk) {
    add(failures, 'known-pollution',
      `known region moved beyond tolerance (observed ${k.observedChangeDb} dB, outside-window ${k.outsideWindowChangeDb} dB)`,
      { observedChangeDb: k.observedChangeDb, outsideWindowChangeDb: k.outsideWindowChangeDb });
  }

  // (2) Trusted-subband conservation.
  const c = p.conservation ?? {};
  const conservationOk = (c.worstConservationDb ?? Infinity) <= T.subbandConservationDbMax;
  checks.push({
    name: 'subband-conservation',
    pass: conservationOk,
    evidence: {
      worstConservationDb: c.worstConservationDb,
      compartments: (c.compartments ?? []).map((x) => ({ name: x.name, conservationDb: x.conservationDb })),
      toleranceDb: T.subbandConservationDbMax,
    },
  });
  if (!conservationOk) {
    add(failures, 'conservation-breach',
      `reference subband energy moved ${c.worstConservationDb} dB (limit ${T.subbandConservationDbMax} dB)`,
      { worstConservationDb: c.worstConservationDb });
  }

  // (2b) The delivered masked-cell content must match the declared candidate.
  const f = p.fill ?? {};
  const fillOk = (f.fillResidualDb ?? Infinity) <= T.fillResidualDbMax;
  checks.push({
    name: 'fill-consistency',
    pass: fillOk,
    evidence: {
      fillResidualDb: f.fillResidualDb,
      toleranceDb: T.fillResidualDbMax,
      targetPeak: f.targetPeak,
    },
  });
  if (!fillOk) {
    add(failures, 'fill-inconsistency',
      `output gap content diverges from the declared candidate by ${f.fillResidualDb} dB`,
      { fillResidualDb: f.fillResidualDb });
  }

  // (3) Uncertainty marking for unidentifiable material.
  const unidentifiable = p.identifiability === 'unidentifiable';
  const d = p.divergence ?? {};
  const proj = p.projection ?? {};
  const collapsedAlternatives = (p.candidateCount ?? 0) >= 2
    && (d.meanDb ?? Infinity) <= T.divergenceDbCollapse;
  const projectionFlagsUncertainty = (proj.disagreementDb ?? -Infinity) >= T.projectionDisagreementDbMin;
  const markedUncertain = p.confidenceLevel === 'low' || p.conflict === true;

  if (unidentifiable) {
    const divergenceOk = (d.meanDb ?? -Infinity) >= T.divergenceDbMin || projectionFlagsUncertainty;
    checks.push({
      name: 'candidate-divergence',
      pass: divergenceOk && !collapsedAlternatives,
      evidence: {
        meanDivergenceDb: d.meanDb,
        maxDivergenceDb: d.maxDb,
        projectionDisagreementDb: proj.disagreementDb,
        projectionLowerBoundDb: proj.lowerBoundDb,
        candidateCount: p.candidateCount,
        divergenceGateDb: T.divergenceDbMin,
      },
    });
    if (!divergenceOk) {
      add(failures, 'false-confidence',
        `unidentifiable gap shows no candidate/projection disagreement (mean ${d.meanDb} dB, projection ${proj.disagreementDb} dB)`,
        { meanDivergenceDb: d.meanDb, projectionDisagreementDb: proj.disagreementDb });
    }
    if (collapsedAlternatives) {
      add(failures, 'false-confidence',
        'multiple candidates are near-identical; alternatives are nominal, not real',
        { meanDivergenceDb: d.meanDb });
    }
    if (!markedUncertain) {
      add(failures, 'false-confidence',
        `unidentifiable gap labelled ${p.confidenceLevel ?? 'n/a'} without an uncertainty marker`,
        { confidenceLevel: p.confidenceLevel, conflict: p.conflict });
    }
  } else {
    // Identifiable material: a high-confidence single answer is legitimate, but
    // the projection lower bound must not be violated (it is a lower bound on
    // at least one projection error and can only be small, never negative in
    // the inequality sense).
    const boundOk = proj.boundHolds !== false;
    checks.push({
      name: 'projection-lower-bound-scope',
      pass: boundOk,
      evidence: {
        disagreementDb: proj.disagreementDb,
        lowerBoundDb: proj.lowerBoundDb,
        residuals: proj.residuals,
        boundHolds: proj.boundHolds,
      },
    });
    if (!boundOk) {
      add(failures, 'false-confidence', 'triangle-inequality lower bound violated; evidence chain broken', proj);
    }
    checks.push({
      name: 'identifiable-consistency',
      pass: (p.candidateCount ?? 0) >= 1 && hasRealAlternativesOrSingle(p),
      evidence: { candidateCount: p.candidateCount, meanDivergenceDb: d.meanDb },
    });
  }

  return verdict(p, failures, checks);
}

function hasRealAlternativesOrSingle(p) {
  // A single well-supported candidate is fine on identifiable material.
  return (p.candidateCount ?? 0) >= 1;
}

function verdict(payload, failures, checks) {
  const passed = failures.length === 0;
  return {
    fixtureId: payload.fixtureId,
    identifiability: payload.identifiability,
    status: payload.status,
    passed,
    failureCodes: [...new Set(failures.map((f) => f.code))],
    failures,
    checks,
    injectedFault: payload.fault ?? null,
    evidenceBasis: 'independent reference (STFT-only); kernel confidence labels treated as untrusted input',
  };
}

// Roll-up helper for a whole suite; never downgrades a failure.
export function summarizeVerdicts(verdicts) {
  const total = verdicts.length;
  const passed = verdicts.filter((v) => v.passed).length;
  return {
    total,
    passed,
    failed: total - passed,
    failuresByCode: verdicts
      .filter((v) => !v.passed)
      .flatMap((v) => v.failures.map((f) => ({ fixtureId: v.fixtureId, code: f.code, message: f.message }))),
    allPassed: passed === total,
  };
}
