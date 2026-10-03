import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordsStore } from '../src/data/records';

test('tenant-scoped listing returns local records', async () => {
  const rows = await recordsStore.listForTenant({ id: 'u-viewer-a', tenantId: 'tenant-a', role: 'viewer' });
  assert.equal(rows.length, 2);
});
