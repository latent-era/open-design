import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

/**
 * Compaction continues a conversation in a fresh one seeded with a handoff, so
 * the context window resets without losing what the session learned.
 */
describe('conversation compaction route', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function project(): Promise<{ projectId: string; conversationId: string }> {
    const projectId = `compact-${randomUUID()}`;
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Compact project' }),
    });
    expect(resp.status).toBe(200);
    projectsToClean.push(projectId);
    const body = (await resp.json()) as { conversationId: string };
    return { projectId, conversationId: body.conversationId };
  }

  async function compact(projectId: string, conversationId: string, handoff: unknown) {
    return fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/compact`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handoff }),
      },
    );
  }

  it('continues in a new conversation seeded with the handoff', async () => {
    const { projectId, conversationId } = await project();
    const resp = await compact(projectId, conversationId, 'We fixed the flapping host.');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { conversation: { id: string } };
    expect(body.conversation.id).not.toBe(conversationId);

    const messages = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${body.conversation.id}/messages`,
    ).then((r) => r.json()) as { messages: Array<{ role: string; content: string }> };
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.role).toBe('user');
    expect(messages.messages[0]!.content).toContain('We fixed the flapping host.');
  });

  it('leaves the source conversation intact', async () => {
    // A bad handoff has to be recoverable. Destroying the original would make
    // compaction a one-way door.
    const { projectId, conversationId } = await project();
    await compact(projectId, conversationId, 'handoff body');

    const still = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`,
    );
    expect(still.status).toBe(200);
  });

  it('refuses an empty handoff', async () => {
    // Seeding with nothing silently discards the conversation being compacted.
    const { projectId, conversationId } = await project();
    const resp = await compact(projectId, conversationId, '   ');
    expect(resp.status).toBe(400);
  });

  it('404s for a conversation that does not exist', async () => {
    const { projectId } = await project();
    const resp = await compact(projectId, 'nope', 'handoff body');
    expect(resp.status).toBe(404);
  });
});
