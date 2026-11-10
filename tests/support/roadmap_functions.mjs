// Execute the shipped inline Learn functions. Extraction is harness plumbing;
// tests assert runtime results and produced messages, never source wording.
import fs from 'node:fs';
import {extractFunction} from './real_harness.mjs';
export function loadRoadmapFunctions() {
  const html = fs.readFileSync('web/index.html', 'utf8');
  const between = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  return new Function(`
    const REASONING_TAGS = ['<think>', '<reasoning>', '<analysis>'];
    const TAG_NAMES = REASONING_TAGS.map(t => t.slice(1, -1));
    const ROADMAP_AUDIT_CONFIDENCE = .8;
    ${extractFunction(html, 'stripReasoningTagFragments')}
    ${between('    const ROADMAP_FACT_AUDIT_PROTOCOL =', '    const ROADMAP_CURRICULUM_JUDGE_PROTOCOL')}
    ${between('    function roadmapText(', '    function roadmapQualityReport(')}
    ${between('    async function roadmapAuditDigest(', '    function extractRoadmapFromAssistant(')}
    ${between('    function extractRoadmapFromAssistant(', '    function parseVideoGenerationDirective(')}
    ${between('    function roadmapForMessage(', '    /* ==================== UI: messages')}
    ${between('      const ROADMAP_OUTPUT_PROTOCOL =', '      function nativeModelImagesForHistory(')}
    ${between('    const ROADMAP_REPAIR_PROTOCOL =', '    function roadmapFence(')}
    ${extractFunction(html, 'roadmapFence')}
    ${extractFunction(html, 'roadmapQualityReport')}
    ${extractFunction(html, 'repairVerifiedRoadmap')}
    ${between('    function createContentHoldback(', '    /* ==================== LaTeX')}
    return {ROADMAP_FACT_AUDIT_PROTOCOL, roadmapAuditProtocol, roadmapAuditDigest, roadmapAuditJobs,
      roadmapAuditQuery, roadmapAuditPassages, roadmapAuditExcerpt,
      roadmapAuditSources, roadmapAuditEvidence, normalizeRoadmapCheckBatch, normalizeRoadmapCheckSubset,
      runRoadmapFactualChecks, createRoadmapRepetitionGuard, completeRoadmapPhase,
      normalizeRoadmapOutline, normalizeRoadmapStage, generateRoadmapInStages,
      roadmapDraftInputKey, findRoadmapDraft, roadmapEditPatch, roadmapForMessage, parseRoadmapBlockDirective,
      ROADMAP_NOTE_LIMITS, roadmapNotesFor, roadmapLearnerNotesRequest, normalizeRoadmapNoteReply, roadmapLearnerGuidance,
      normalizeRoadmapRevisedStage,
      reviseRoadmapStages, roadmapDraftPreview, ROADMAP_OUTPUT_PROTOCOL, parseRoadmapDirective,
      repairVerifiedRoadmap, roadmapQualityReport,
      roadmapAuditSummary, roadmapAuditLabel, roadmapHours, roadmapHoursText, roadmapStageDependencies,
      roadmapDependencyText, roadmapShortTitle, roadmapCheckpointParts};
  `)();
}
