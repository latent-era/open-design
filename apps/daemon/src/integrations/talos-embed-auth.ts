import { createHmac, timingSafeEqual } from 'node:crypto';

const TALOS_ISSUER = 'talos-vps';
const TALOS_AUDIENCE = 'talos-open-design';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface TalosSessionClaims {
  sub: string;
  talos_project_id: string;
  open_design_project_id: string;
  workspace_id: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  kind?: 'session';
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signatureFor(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function decodeClaims(token: string, secret: string): TalosSessionClaims | null {
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length) return null;
  let header: Record<string, unknown>;
  let claims: TalosSessionClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TalosSessionClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  const actual = Buffer.from(encodedSignature, 'base64url');
  const expected = signatureFor(`${encodedHeader}.${encodedPayload}`, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== TALOS_ISSUER ||
    claims.aud !== TALOS_AUDIENCE ||
    !claims.sub ||
    !claims.talos_project_id ||
    !claims.open_design_project_id ||
    !claims.workspace_id ||
    !claims.jti ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > now + 60 ||
    claims.exp <= now
  ) return null;
  return claims;
}

export function verifyTalosLaunchTicket(token: string, secret: string): TalosSessionClaims | null {
  const claims = decodeClaims(token, secret);
  if (!claims || claims.kind !== undefined || claims.exp - claims.iat > 10 * 60) return null;
  return claims;
}

export function createTalosSession(ticket: TalosSessionClaims, secret: string): {
  token: string;
  expiresAt: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({
    ...ticket,
    kind: 'session',
    iat: now,
    exp: expiresAt,
  });
  const signature = signatureFor(`${header}.${payload}`, secret).toString('base64url');
  return { token: `${header}.${payload}.${signature}`, expiresAt };
}

export function verifyTalosSession(token: string, secret: string): TalosSessionClaims | null {
  const claims = decodeClaims(token, secret);
  return claims?.kind === 'session' ? claims : null;
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
