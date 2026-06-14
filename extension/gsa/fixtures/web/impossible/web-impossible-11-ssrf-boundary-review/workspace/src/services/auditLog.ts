export type AuditEvent = { route: string; actor: string; decision: string; requestId: string };

const events: AuditEvent[] = [];

export function recordAudit(event: AuditEvent) { events.push({ ...event }); }
export function recentAuditEvents(limit = 20): AuditEvent[] { return events.slice(-limit); }
