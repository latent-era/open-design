import type { Express, RequestHandler } from 'express';

import {
  cookieValue,
  createTalosSession,
  verifyTalosLaunchTicket,
  verifyTalosSession,
} from '../integrations/talos-embed-auth.js';

const TALOS_COOKIE_NAME = 'od_talos_session';

function frameAncestorsFromEnv(): string[] {
  return (process.env.OD_TALOS_FRAME_ANCESTORS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
}

export interface TalosEmbedAuth {
  apiSession: RequestHandler;
  configured: boolean;
}

export function registerTalosEmbedRoutes(app: Express): TalosEmbedAuth {
  const sessionSecret = (process.env.OD_TALOS_SESSION_SECRET ?? '').trim();
  const frameAncestors = frameAncestorsFromEnv();

  if (frameAncestors.length > 0) {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) {
        res.setHeader(
          'Content-Security-Policy',
          `frame-ancestors 'self' ${frameAncestors.join(' ')}`,
        );
        res.removeHeader('X-Frame-Options');
      }
      next();
    });
  }

  app.get('/talos/session', (req, res) => {
    if (!sessionSecret) {
      return res.status(503).send('Talos Studio sessions are not configured');
    }
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    const claims = verifyTalosLaunchTicket(ticket, sessionSecret);
    if (!claims) return res.status(401).send('Talos Studio launch link is invalid or expired');

    const session = createTalosSession(claims, sessionSecret);
    const secure = process.env.OD_TALOS_COOKIE_SECURE !== '0';
    const cookie = [
      `${TALOS_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.max(1, session.expiresAt - Math.floor(Date.now() / 1000))}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(
      303,
      `/projects/${encodeURIComponent(claims.open_design_project_id)}?talos=1`,
    );
  });

  const apiSession: RequestHandler = (req, res, next) => {
    if (!sessionSecret) return next();
    const sessionToken = cookieValue(req.get('cookie'), TALOS_COOKIE_NAME);
    const session = sessionToken ? verifyTalosSession(sessionToken, sessionSecret) : null;
    if (!session) return next();

    const projectPath = /^\/projects\/([^/]+)(?:\/|$)/u.exec(req.path);
    if (
      projectPath?.[1] &&
      decodeURIComponent(projectPath[1]) !== session.open_design_project_id
    ) {
      return res.status(403).json({
        error: { code: 'TALOS_PROJECT_SCOPE', message: 'Session is scoped to another project' },
      });
    }
    const bodyProjectId = req.body && typeof req.body === 'object'
      ? (req.body.projectId ?? req.body.project_id)
      : null;
    if (
      typeof bodyProjectId === 'string' &&
      bodyProjectId !== session.open_design_project_id
    ) {
      return res.status(403).json({
        error: { code: 'TALOS_PROJECT_SCOPE', message: 'Session is scoped to another project' },
      });
    }
    res.locals.talosSession = session;
    return next();
  };

  return { apiSession, configured: Boolean(sessionSecret) };
}
