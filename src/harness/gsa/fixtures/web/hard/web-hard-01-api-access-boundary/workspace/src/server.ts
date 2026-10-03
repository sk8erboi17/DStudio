import express from 'express';
import { router as caseRouter } from './routes/api_access_boundary';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', caseRouter);

export default app;
