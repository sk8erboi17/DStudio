// Neutral briefs: no DStudio-specific tool names or private user data. This
// small development pilot is not a comprehensive or held-out quality ranking.
export const productQualityCases = [
  { id: 'agent-utc-summary', mode: 'agent', competitor: 'openwork', entry: 'summary.mjs',
    prompt: 'Fix summary.mjs so summarize(rows) groups event amounts by UTC calendar date, sums numeric amounts, ignores rows with invalid dates or non-finite amounts, and returns ascending dates as objects with date and total. Keep the exported API. Add and run a permanent Node regression test covering offsets that cross midnight, repeated dates, invalid records and empty input. Do not modify input.json. Use only local files, no network. Finish the actual file edit and tests, not just an explanation.',
    files: {
      'summary.mjs': 'export function summarize(rows) { return rows.map(r => ({date:r.timestamp.slice(0,10),total:Number(r.amount)})); }\n',
      'input.json': '[{"timestamp":"2026-05-01T23:30:00-02:00","amount":7},{"timestamp":"2026-05-02T10:00:00Z","amount":5}]\n',
    } },
  { id: 'cowork-current-plan', mode: 'cowork', competitor: 'openwork', entry: 'plan.md',
    prompt: 'Read all three local source files. Write plan.md as a concise, usable plan for the community workshop, not a finance report. Include a Markdown table with activity, current owner, current date and source filename; use the update over the older brief and retain unchanged activities. Compute the total registered participants from attendance.csv excluding canceled rows and explain the rule. Mark the room assignment as unresolved if it is not in the sources. Do not invent confirmations. Preserve all source files. Use only local tools; no network.',
    files: {
      'brief.md': '# Initial community workshop brief\nBookbinding: owner Maya; date 2026-10-12.\nBicycle care: owner Ivo; date 2026-10-13.\nRoom assignment is still undecided.\n',
      'update.md': '# Approved update, supersedes the brief where changed\nBookbinding moves to 2026-10-15; new owner Noor.\nBicycle care is unchanged.\nNo room has been assigned.\n',
      'attendance.csv': 'activity,participants,status\nBookbinding,12,confirmed\nBicycle care,9,confirmed\nBookbinding,4,canceled\nBicycle care,3,confirmed\n',
    } },
  { id: 'design-workshop-journey', mode: 'design', competitor: 'opendesign', entry: 'workshop.html', files: {},
    prompt: 'Build directly, without discovery questions. Create workshop.html for NEIGHBOURHOOD LAB, a welcoming general-purpose community workshop planner for first-time participants, primarily on a phone. Exact heading: Make room to learn. Implement a three-step journey: Choose a workshop, Choose a day, Review. Workshops: Bookbinding, Bicycle care, Urban sketching. Days: Tuesday, Thursday. Continue must be unavailable until the current step has a selection. Back preserves the choice. Review displays both choices. Final confirmation explicitly says No booking was made: this is a local demo, with clearly labelled sample data. Use readable typography, calm green, strong keyboard focus and clear field labels. On desktop place a human introduction beside one focused step panel; on mobile put the current action below the heading. No horizontal page scrolling, gradients, network dependencies or external assets. Use your available local design resources where appropriate. Save a finished offline HTML prototype with real controls, inspect its rendering and exercise the controls before claiming completion.',
  },
];
