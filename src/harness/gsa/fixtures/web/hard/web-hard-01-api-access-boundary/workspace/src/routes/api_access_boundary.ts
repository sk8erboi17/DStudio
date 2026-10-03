import { Router } from 'express';
import { loadSession, requireRole } from '../auth/session';
import { recordsStore as records } from '../data/records';

export const router = Router();

router.use(loadSession);

router.get('/api-access-boundary/summary', async (req, res) => {
  const rows = await records.listForTenant(req.user!);
  res.json({ count: rows.length, active: rows.filter((row) => row.status === 'active').length });
});

router.get('/api-access-boundary/records/:id', async (req, res) => {
  const record = await records.findById(req.params.id);
  if (!record) return res.status(404).json({ error: 'not found' });
  return res.json(record);
});

router.post('/api-access-boundary/export', requireRole('admin'), async (_req, res) => {
  res.json({ queued: true, format: 'csv' });
});
