export interface CaseContext {
  id: string;
  category: string;
  difficulty: string;
  reviewStream: string;
  localOnly: boolean;
}

export const caseContext: CaseContext = {
  "id": "web-hard-01-api-access-boundary",
  "category": "web",
  "difficulty": "hard",
  "scenario": "api-access-boundary",
  "reviewStream": "stream-web-hard-1",
  "localOnly": true
};

export function caseLabel(): string {
  return caseContext.category + ':' + caseContext.difficulty + ':' + caseContext.id;
}
