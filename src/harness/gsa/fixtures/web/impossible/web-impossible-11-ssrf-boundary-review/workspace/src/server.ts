import express from 'express';
import { router as caseRouter } from './routes/ssrf_boundary_review';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', caseRouter);

export default app;
