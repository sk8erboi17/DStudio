export type Role = 'viewer' | 'operator' | 'admin';

export interface UserContext {
  id: string;
  tenantId: string;
  role: Role;
}

export interface BusinessRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  status: 'draft' | 'active' | 'archived';
  amountCents: number;
}
