// Execute the shipped inline Learn functions. Extraction is harness plumbing;
// tests assert runtime results and produced messages, never source wording.
import fs from 'node:fs';
export function loadRoadmapFunctions() {
  const html = fs.readFileSync('web/index.html', 'utf8');
  const between = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  return new Function(`
    const REASONING_TAGS = ['<think>', '<reasoning>', '<analysis>'];
    const TAG_NAMES = REASONING_TAGS.map(t => t.slice(1, -1));
    const ROADMAP_AUDIT_CONFIDENCE = .8;
    ${between('    const ROADMAP_FACT_AUDIT_PROTOCOL =', '    const ROADMAP_CURRICULUM_JUDGE_PROTOCOL')}
    ${between('    function roadmapText(', '    function roadmapQualityReport(')}
    ${between('    async function roadmapAuditDigest(', '    function extractRoadmapFromAssistant(')}
    ${between('    function createContentHoldback(', '    /* ==================== LaTeX')}
    return {ROADMAP_FACT_AUDIT_PROTOCOL, roadmapAuditDigest, roadmapAuditJobs,
      roadmapAuditSources, roadmapAuditEvidence, normalizeRoadmapCheckBatch, normalizeRoadmapCheckSubset,
      runRoadmapFactualChecks, createRoadmapRepetitionGuard, completeRoadmapPhase,
      normalizeRoadmapOutline, normalizeRoadmapStage, generateRoadmapInStages,
      roadmapDraftInputKey, findRoadmapDraft};
  `)();
}
