import assert from 'node:assert/strict';

const BASE_URL = String(process.env.DSTUDIO_AUDIT_BASE_URL || 'http://127.0.0.1:28000').replace(/\/$/, '');
const MIN_CONFIDENCE = 0.8;

const AUDITOR = String.raw`You are DStudio roadmap factual auditor.
You have exactly one job: find factual, mathematical, scientific, technical, historical, or logical errors. Assume subtle errors exist. Ignore prose quality, curriculum completeness, pedagogy, formatting, and visual design; a separate judge owns those concerns.
Inspect every claim, definition, theorem statement, hypothesis, example, exercise, expected result, and assessment independently. Try to falsify each one with definitions, missing hypotheses, counterexamples, known results, or internal implications. When scope is global, also search for contradictions between stages and between the roadmap and its capstone.
Report a finding only when confidence is at least 0.80. Do not report style preferences or merely optional refinements. A correction must be precise enough for another model to apply without guessing.
Return strict JSON only, with this exact shape:
{"scope":"stage-id-or-global","pass":true,"findings":[{"location":"stage/topic/field","claim":"exact problematic claim","verdict":"incorrect|contradiction|missing_hypothesis|unsupported|ambiguous","justification":"why it fails","correction":"precise replacement","confidence":0.95}]}
Set pass true only when findings is empty. Never include correct claims. Never wrap JSON in markdown and never add prose.`;

const stageSpecs = [
  {
    id: 'mathematics-foundations',
    title: 'Mathematics foundations',
    errors: [
      ['mx-01', 'Every subgroup of every group is normal.'],
      ['mx-02', 'For any subgroup H of a group G, the coset set G/H is automatically a group under coset multiplication.'],
      ['mx-03', 'Z/6Z is a field because it is finite.'],
      ['mx-04', 'Every prime ideal in every commutative ring with identity is maximal.'],
      ['mx-05', 'The splitting field of x^3 - 2 over Q is not a Galois extension of Q.'],
      ['mx-06', 'A finite integral domain can contain nonzero nonunits and therefore need not be a field.'],
      ['mx-07', 'For square matrices A and B of the same size, det(AB) = det(A) + det(B).'],
      ['mx-08', 'Every real square matrix has at least one real eigenvalue.'],
      ['mx-09', 'Every function continuous at a point is differentiable at that point.'],
      ['mx-10', 'The series sum from n=1 to infinity of 1/n^2 diverges.'],
    ],
    controls: [
      ['ok-01', 'In a finite group, the order of a subgroup divides the order of the group.'],
      ['ok-02', 'For prime p, Z/pZ is a field.'],
      ['ok-03', 'For square matrices A and B, det(AB) = det(A)det(B).'],
      ['ok-04', 'Differentiability at a point implies continuity at that point.'],
      ['ok-05', 'The series sum from n=1 to infinity of 1/n^2 converges.'],
    ],
  },
  {
    id: 'probability-and-physics',
    title: 'Probability and physics',
    errors: [
      ['mx-11', 'For any random variables X and Y with finite variance, Var(X+Y) = Var(X) + Var(Y).'],
      ['mx-12', 'A p-value of 0.03 means there is a 3% probability that the null hypothesis is true.'],
      ['mx-13', 'Any two uncorrelated random variables are independent.'],
      ['mx-14', 'The central limit theorem says that every sample mean has an exactly normal distribution for every finite sample size.'],
      ['mx-15', 'A maximum-likelihood estimator is always unique and unbiased.'],
      ['mx-16', 'The entropy of an isolated system spontaneously decreases in every natural process.'],
      ['mx-17', 'A particle with nonzero rest mass can be accelerated to the speed of light using a finite amount of energy.'],
      ['mx-18', 'Whether two spatially separated events are simultaneous is absolute and identical for all inertial observers.'],
      ['mx-19', 'In the Standard Model, a photon has a positive nonzero rest mass.'],
      ['mx-20', 'The kinetic energy of a massive particle is exactly (1/2)mv^2 at every speed below light.'],
    ],
    controls: [
      ['ok-06', 'Expectation is linear whenever the expectations involved exist; independence is not required.'],
      ['ok-07', 'Independent random variables with finite second moments have zero covariance.'],
      ['ok-08', 'The entropy of an isolated system does not decrease according to the statistical form of the second law.'],
      ['ok-09', 'All inertial observers measure the same vacuum speed of light.'],
      ['ok-10', 'Special relativity gives E^2 = (pc)^2 + (mc^2)^2 for a free particle.'],
    ],
  },
  {
    id: 'computer-science-systems',
    title: 'Computer science and systems',
    errors: [
      ['mx-21', 'Dijkstra’s algorithm always returns correct shortest paths on graphs with negative edge weights as long as there is no negative cycle.'],
      ['mx-22', 'Breadth-first search returns minimum-total-weight paths for every graph whose edge weights are positive but unequal.'],
      ['mx-23', 'TCP preserves application message boundaries: one send call corresponds to exactly one receive call.'],
      ['mx-24', 'UDP guarantees reliable, duplicate-free, in-order delivery.'],
      ['mx-25', 'SHA-256 is reversible encryption, so the original plaintext can be recovered with the secret key.'],
      ['mx-26', 'The security of textbook RSA is based on the difficulty of discrete logarithms in prime fields.'],
      ['mx-27', 'The C standard guarantees that signed integer overflow wraps modulo 2^N.'],
      ['mx-28', 'The CPython GIL prevents all data races, so shared mutable program state never needs synchronization.'],
      ['mx-29', 'Promise.then callbacks are macrotasks and therefore run only after already-scheduled timer callbacks.'],
      ['mx-30', 'In SQL, the expression NULL = NULL evaluates to TRUE.'],
      ['mx-31', 'During a network partition, a distributed system can simultaneously guarantee consistency, availability, and partition tolerance for every request.'],
      ['mx-32', 'Each ordinary container inside the same Kubernetes Pod has a separate network namespace and a separate Pod IP address.'],
    ],
    controls: [
      ['ok-11', 'Dijkstra’s algorithm is correct for graphs with nonnegative edge weights.'],
      ['ok-12', 'TCP provides an ordered byte stream and does not expose application message boundaries.'],
      ['ok-13', 'SHA-256 is a cryptographic hash function, not a reversible encryption scheme.'],
      ['ok-14', 'Unsigned integer arithmetic in C wraps modulo 2^N for an N-bit unsigned type.'],
      ['ok-15', 'In the usual JavaScript event-loop model, Promise reaction jobs run as microtasks before the next timer task.'],
    ],
  },
];

function makeTopic([id, claim]) {
  return {
    id,
    title: `Claim ${id}`,
    summary: claim,
    outcome: `Explain and apply the claim stated in ${id}.`,
    assessment: `Defend the claim in ${id} with a proof or counterexample.`,
  };
}

const stages = stageSpecs.map((stage) => ({
  id: stage.id,
  title: stage.title,
  topics: [...stage.errors, ...stage.controls].map(makeTopic),
}));
const roadmap = {
  version: 2,
  title: 'Adversarial factual-audit benchmark',
  goal: 'Audit claims across independent technical domains.',
  audience: 'Advanced learner',
  assumptions: ['Standard mathematical and technical terminology.'],
  stages,
  capstone: {
    title: 'Cross-domain review',
    description: 'Use every supplied claim exactly as stated.',
    deliverables: ['Proof dossier'],
    successCriteria: ['Every stated claim is defended.'],
  },
};

const goldIds = new Set(stageSpecs.flatMap((stage) => stage.errors.map(([id]) => id)));
const controlIds = new Set(stageSpecs.flatMap((stage) => stage.controls.map(([id]) => id)));

function stripFence(text) {
  return String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
}

function decodeSseEvent(frame) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

async function streamCompletion(messages) {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      think: true,
      reasoning_effort: 'max',
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningChars = 0;
  let finishReason = '';
  let usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const chunk = decodeSseEvent(frame);
      if (!chunk) continue;
      const choice = chunk.choices?.[0];
      content += choice?.delta?.content || '';
      reasoningChars += String(choice?.delta?.reasoning_content || '').length;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    if (done) break;
  }
  return { content, reasoningChars, finishReason, usage };
}

function normalizeAudit(value, scope) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.findings)) {
    throw new Error('missing findings array');
  }
  return {
    scope,
    findings: value.findings.filter((finding) => Number(finding?.confidence) >= MIN_CONFIDENCE),
  };
}

async function audit(scope, payload) {
  const instruction = scope === 'global'
    ? `Audit scope: global. Independently inspect the complete roadmap and search especially for cross-stage contradictions.\n\nComplete roadmap:\n${JSON.stringify(payload)}`
    : `Audit scope: stage ${scope}. Audit every factual claim in the complete stage object.\n\nComplete stage:\n${JSON.stringify(payload)}`;
  const baseMessages = [
    { role: 'system', content: AUDITOR },
    { role: 'user', content: instruction },
  ];
  let messages = baseMessages;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    console.log(JSON.stringify({ event: 'audit-start', scope, attempt, at: new Date().toISOString() }));
    const result = await streamCompletion(messages);
    try {
      const auditResult = normalizeAudit(JSON.parse(stripFence(result.content)), scope);
      console.log(JSON.stringify({
        event: 'audit-finish', scope, attempt,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        findings: auditResult.findings.length,
        reasoningChars: result.reasoningChars,
        finishReason: result.finishReason,
      }));
      return auditResult;
    } catch (error) {
      console.log(JSON.stringify({ event: 'audit-retry', scope, attempt, error: error.message }));
      messages = [
        ...baseMessages,
        { role: 'assistant', content: result.content },
        { role: 'user', content: `Output invalid: ${error.message}. Return the complete strict JSON object again without shortening it.` },
      ];
    }
  }
}

function idsForFinding(finding) {
  const text = `${finding.location || ''} ${finding.claim || ''}`;
  return [...text.matchAll(/(?:mx|ok)-\d{2}/gi)].map((match) => match[0].toLowerCase());
}

function score(audits) {
  const detected = new Set();
  const falsePositiveIds = new Set();
  let unknownFindings = 0;
  let totalFindings = 0;
  for (const auditResult of audits) {
    for (const finding of auditResult.findings) {
      totalFindings += 1;
      const ids = idsForFinding(finding);
      const matchedGold = ids.filter((id) => goldIds.has(id));
      const matchedControls = ids.filter((id) => controlIds.has(id));
      matchedGold.forEach((id) => detected.add(id));
      matchedControls.forEach((id) => falsePositiveIds.add(id));
      if (!matchedGold.length && !matchedControls.length) unknownFindings += 1;
    }
  }
  const missed = [...goldIds].filter((id) => !detected.has(id));
  const falsePositives = falsePositiveIds.size + unknownFindings;
  const precision = detected.size + falsePositives
    ? detected.size / (detected.size + falsePositives)
    : 0;
  return {
    totalFindings,
    truePositives: detected.size,
    falsePositives,
    falsePositiveIds: [...falsePositiveIds],
    unknownFindings,
    falseNegatives: missed.length,
    missed,
    precision,
    recall: detected.size / goldIds.size,
  };
}

function compactFindings(result) {
  return result.findings.map((finding) => ({
    ids: idsForFinding(finding),
    location: finding.location,
    verdict: finding.verdict,
    confidence: finding.confidence,
    claim: finding.claim,
    correction: finding.correction,
  }));
}

const globalAudit = await audit('global', roadmap);
const globalScore = score([globalAudit]);
const supplementalStageAudits = [];
const missedSet = new Set(globalScore.missed);
for (const stage of stages) {
  if (!stage.topics.some((entry) => missedSet.has(entry.id))) continue;
  supplementalStageAudits.push(await audit(stage.id, stage));
}
const combinedScore = score([globalAudit, ...supplementalStageAudits]);

const report = {
  model: 'deepseek-v4-flash',
  context: Number(process.env.DSTUDIO_AUDIT_CONTEXT || 131072),
  reasoningEffort: 'max',
  minimumConfidence: MIN_CONFIDENCE,
  seededErrors: goldIds.size,
  correctControls: controlIds.size,
  globalScore,
  supplementalStages: supplementalStageAudits.map((result) => result.scope),
  combinedScore,
  findings: {
    global: compactFindings(globalAudit),
    supplementalStages: supplementalStageAudits.flatMap(compactFindings),
  },
};

assert.equal(report.seededErrors, 32);
assert.equal(report.correctControls, 15);
console.log(`STRESS_TEST_RESULT ${JSON.stringify(report, null, 2)}`);
