import type { BusinessRecord, UserContext } from '../types';

const records: BusinessRecord[] = [
  { id: 'rec-1001', tenantId: 'tenant-a', ownerId: 'u-viewer-a', status: 'active', amountCents: 129900 },
  { id: 'rec-1002', tenantId: 'tenant-a', ownerId: 'u-admin', status: 'archived', amountCents: 34900 },
  { id: 'rec-2001', tenantId: 'tenant-b', ownerId: 'u-viewer-b', status: 'active', amountCents: 9900 },
];

export const recordsStore = {
  async findById(id: string): Promise<BusinessRecord | undefined> {
    return records.find((record) => record.id === id);
  },

  async findForUser(id: string, user: UserContext): Promise<BusinessRecord | undefined> {
    const record = records.find((item) => item.id === id);
    if (!record) return undefined;
    if (user.role === 'admin' && record.tenantId === user.tenantId) return record;
    if (record.tenantId !== user.tenantId) return undefined;
    if (record.ownerId !== user.id) return undefined;
    return record;
  },

  async listForTenant(user: UserContext): Promise<BusinessRecord[]> {
    return records.filter((record) => record.tenantId === user.tenantId);
  },
};
