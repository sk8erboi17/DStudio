export interface CaseContext {
  id: string;
  category: string;
  difficulty: string;
  reviewStream: string;
  localOnly: boolean;
}

export const caseContext: CaseContext = {
  "id": "web-impossible-11-ssrf-boundary-review",
  "category": "web",
  "difficulty": "impossible",
  "scenario": "ssrf-boundary-review",
  "reviewStream": "stream-web-impossible-11",
  "localOnly": true
};

export function caseLabel(): string {
  return caseContext.category + ':' + caseContext.difficulty + ':' + caseContext.id;
}
