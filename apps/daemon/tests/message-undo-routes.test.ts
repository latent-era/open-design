import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  insertConversation,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { startServer } from '../src/server.js';

/**
 * Timeline-rewind undo over the real HTTP surface.
 *
 * Versions are created through the production endpoints so the test exercises
 * the same version store the daemon writes at run finish. Only the message row
 * — which a real run would have written — is seeded directly, because driving
 * a genuine agent turn would require a model.
 */
describe('message undo routes', () => {
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

  function db() {
    const dataDir = process.env.OD_DATA_DIR;
    if (!dataDir) throw new Error('OD_DATA_DIR is required for daemon route tests');
    return openDatabase(dataDir, { dataDir });
  }

  async function createProject(): Promise<string> {
    const id = `undo-${randomUUID()}`;
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'Undo route project' }),
    });
    expect(response.status).toBe(200);
    projectsToClean.push(id);
    return id;
  }

  async function writeFile(projectId: string, name: string, content: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    if (response.status !== 200) throw new Error(`writeFile ${response.status}: ${await response.text()}`);
  }

  async function captureVersion(projectId: string, name: string): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/files/${name}/versions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'manual' }),
      },
    );
    if (response.status !== 200) throw new Error(`captureVersion ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { version: { id: string } };
    return body.version.id;
  }

  async function readFile(projectId: string, name: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/raw/${name}`);
    expect(response.status).toBe(200);
    return response.text();
  }

  function seedMessage(
    conversationId: string,
    projectId: string,
    messageId: string,
    fileVersions: Array<{ fileName: string; versionId: string; previousVersionId: string | null }>,
  ) {
    const now = Date.now();
    const handle = db();
    insertConversation(handle, {
      id: conversationId,
      projectId,
      title: 'Undo',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(handle, conversationId, {
      id: messageId,
      role: 'assistant',
      content: 'edited the stylesheet',
      runId: `run-${messageId}`,
      runStatus: 'succeeded',
      startedAt: now,
      fileVersions,
    });
  }

  it('restores a file to the version it was at before the message', async () => {
    const projectId = await createProject();
    await writeFile(projectId, 'a.css', '.fight { color: red; }');
    const before = await captureVersion(projectId, 'a.css');
    await writeFile(projectId, 'a.css', '.fight { color: blue; }');
    const after = await captureVersion(projectId, 'a.css');

    const conversationId = `conv-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    seedMessage(conversationId, projectId, messageId, [
      { fileName: 'a.css', versionId: after, previousVersionId: before },
    ]);

    const preview = await fetch(`${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      restores: [{ fileName: 'a.css', versionId: before }],
      deletes: [],
      discardedMessageIds: [],
    });

    const applied = await fetch(
      `${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`,
      { method: 'POST' },
    );
    expect(applied.status).toBe(200);

    expect(await readFile(projectId, 'a.css')).toBe('.fight { color: red; }');
  });

  it('leaves the restore itself undoable by writing a new version', async () => {
    // Non-destructive: the rewind must not erase the version it replaced, or
    // the user has no way back from an undo they did not want.
    const projectId = await createProject();
    await writeFile(projectId, 'b.css', 'one');
    const before = await captureVersion(projectId, 'b.css');
    await writeFile(projectId, 'b.css', 'two');
    const after = await captureVersion(projectId, 'b.css');

    const conversationId = `conv-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    seedMessage(conversationId, projectId, messageId, [
      { fileName: 'b.css', versionId: after, previousVersionId: before },
    ]);

    await fetch(`${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`, {
      method: 'POST',
    });

    const listed = await fetch(`${baseUrl}/api/projects/${projectId}/files/b.css/versions`);
    const body = (await listed.json()) as { versions: Array<{ id: string }> };
    const ids = body.versions.map((version) => version.id);
    expect(ids).toContain(after);
    expect(ids.length).toBeGreaterThan(2);
  });

  it('refuses a second undo of a message already rewound', async () => {
    const projectId = await createProject();
    await writeFile(projectId, 'c.css', 'one');
    const before = await captureVersion(projectId, 'c.css');
    await writeFile(projectId, 'c.css', 'two');
    const after = await captureVersion(projectId, 'c.css');

    const conversationId = `conv-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    seedMessage(conversationId, projectId, messageId, [
      { fileName: 'c.css', versionId: after, previousVersionId: before },
    ]);

    const first = await fetch(
      `${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`,
      { method: 'POST' },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`,
      { method: 'POST' },
    );
    expect(second.status).toBe(409);
  });

  it('serializes the undo state to the client that renders the control', async () => {
    // The seam between the daemon recording versions and the web control
    // rendering: the message payload has to actually carry fileVersions. Each
    // side was covered in isolation; without this, the field could silently
    // fail to serialize and the button would simply never appear while every
    // other test still passed.
    const projectId = await createProject();
    await writeFile(projectId, 'd.css', 'one');
    const before = await captureVersion(projectId, 'd.css');
    await writeFile(projectId, 'd.css', 'two');
    const after = await captureVersion(projectId, 'd.css');

    const conversationId = `conv-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    seedMessage(conversationId, projectId, messageId, [
      { fileName: 'd.css', versionId: after, previousVersionId: before },
    ]);

    const resp = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      messages: Array<{ id: string; fileVersions?: unknown[]; undoneAt?: number }>;
    };
    const seeded = body.messages.find((m) => m.id === messageId);
    expect(seeded?.fileVersions).toEqual([
      { fileName: 'd.css', versionId: after, previousVersionId: before },
    ]);
    expect(seeded?.undoneAt).toBeUndefined();

    // And after a rewind the same payload marks it spent.
    await fetch(`${baseUrl}/api/projects/${projectId}/messages/${messageId}/undo`, {
      method: 'POST',
    });
    const after2 = await fetch(
      `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`,
    );
    const body2 = (await after2.json()) as {
      messages: Array<{ id: string; undoneAt?: number }>;
    };
    expect(body2.messages.find((m) => m.id === messageId)?.undoneAt).toBeGreaterThan(0);
  });

  it('404s for a message that does not exist', async () => {
    const projectId = await createProject();
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/messages/nope/undo`,
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
  });
});
