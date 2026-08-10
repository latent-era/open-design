import express from 'express';
import type http from 'node:http';
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cookieValue,
  createTalosSession,
  verifyTalosLaunchTicket,
  verifyTalosSession,
} from '../src/integrations/talos-embed-auth.js';
import { registerTalosEmbedRoutes } from '../src/routes/talos-embed.js';

const secret = 'a-secure-test-secret-that-is-long-enough';

function launchTicket(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'talos-vps',
    aud: 'talos-open-design',
    sub: 'user-1',
    talos_project_id: 'talos-project-1',
    open_design_project_id: 'od-project-1',
    workspace_id: 'workspace-1',
    iat: now,
    exp: now + 300,
    jti: 'ticket-1',
    ...overrides,
  })).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('Talos embed authentication', () => {
  it('exchanges a valid short launch ticket for a longer editor session', () => {
    const ticket = verifyTalosLaunchTicket(launchTicket(), secret);
    expect(ticket?.open_design_project_id).toBe('od-project-1');
    const session = createTalosSession(ticket!, secret);
    const claims = verifyTalosSession(session.token, secret);
    expect(claims?.kind).toBe('session');
    expect(claims?.open_design_project_id).toBe('od-project-1');
    expect(session.expiresAt - claims!.iat).toBe(12 * 60 * 60);
  });

  it('rejects expired, overlong, and incorrectly signed launch tickets', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyTalosLaunchTicket(launchTicket({ iat: now - 400, exp: now - 1 }), secret)).toBeNull();
    expect(verifyTalosLaunchTicket(launchTicket({ exp: now + 3600 }), secret)).toBeNull();
    expect(verifyTalosLaunchTicket(launchTicket(), `${secret}-wrong`)).toBeNull();
  });

  it('reads an encoded session cookie without accepting malformed encoding', () => {
    expect(cookieValue('one=x; od_talos_session=abc.def%2Eghi; two=y', 'od_talos_session'))
      .toBe('abc.def.ghi');
    expect(cookieValue('od_talos_session=%E0%A4%A', 'od_talos_session')).toBeNull();
  });
});

describe('Talos embed routes', () => {
  let server: http.Server;
  let baseUrl = '';
  let sessionCookie = '';
  const originalSecret = process.env.OD_TALOS_SESSION_SECRET;
  const originalSecure = process.env.OD_TALOS_COOKIE_SECURE;

  beforeAll(async () => {
    process.env.OD_TALOS_SESSION_SECRET = secret;
    process.env.OD_TALOS_COOKIE_SECURE = '0';
    const app = express();
    app.use(express.json());
    const talos = registerTalosEmbedRoutes(app);
    app.use('/api', talos.apiSession);
    app.all('/api/*splat', (req, res) => res.json({ project: res.locals.talosSession?.open_design_project_id ?? null }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing address');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const response = await fetch(`${baseUrl}/talos/session?ticket=${encodeURIComponent(launchTicket())}`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/projects/od-project-1?talos=1');
    sessionCookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSecret === undefined) delete process.env.OD_TALOS_SESSION_SECRET;
    else process.env.OD_TALOS_SESSION_SECRET = originalSecret;
    if (originalSecure === undefined) delete process.env.OD_TALOS_COOKIE_SECURE;
    else process.env.OD_TALOS_COOKIE_SECURE = originalSecure;
  });

  it('allows only the project encoded in the editor session', async () => {
    const allowed = await fetch(`${baseUrl}/api/projects/od-project-1/files`, {
      headers: { cookie: sessionCookie },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ project: 'od-project-1' });

    const denied = await fetch(`${baseUrl}/api/projects/another-project/files`, {
      headers: { cookie: sessionCookie },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'TALOS_PROJECT_SCOPE' } });
  });

  it('rejects a mismatched project id in request bodies', async () => {
    const response = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'another-project' }),
    });
    expect(response.status).toBe(403);
  });
});
