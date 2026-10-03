import type { NextFunction, Request, Response } from 'express';
import type { UserContext } from '../types';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserContext;
  }
}

const users: Record<string, UserContext> = {
  'session-admin': { id: 'u-admin', tenantId: 'tenant-a', role: 'admin' },
  'session-viewer-a': { id: 'u-viewer-a', tenantId: 'tenant-a', role: 'viewer' },
  'session-viewer-b': { id: 'u-viewer-b', tenantId: 'tenant-b', role: 'viewer' },
};

export function loadSession(req: Request, res: Response, next: NextFunction) {
  const token = String(req.headers['x-session-id'] || '');
  const user = users[token];
  if (!user) return res.status(401).json({ error: 'authentication required' });
  req.user = user;
  next();
}

export function requireRole(role: UserContext['role']) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if (req.user.role !== role && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
