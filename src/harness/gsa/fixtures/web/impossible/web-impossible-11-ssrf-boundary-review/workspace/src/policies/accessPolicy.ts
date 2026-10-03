import type { BusinessRecord, UserContext } from '../types';

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

export function canReadRecord(user: UserContext, record: BusinessRecord | undefined): AccessDecision {
  if (!record) return { allowed: false, reason: 'missing-record' };
  if (record.tenantId !== user.tenantId) return { allowed: false, reason: 'tenant-boundary' };
  if (user.role === 'admin') return { allowed: true, reason: 'tenant-admin' };
  if (record.ownerId === user.id) return { allowed: true, reason: 'owner' };
  return { allowed: false, reason: 'owner-boundary' };
}

export function auditReason(decision: AccessDecision): string {
  return (decision.allowed ? 'allow:' : 'deny:') + decision.reason;
}
