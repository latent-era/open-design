import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  setPendingUndo,
  takePendingUndo,
  upsertMessage,
} from '../src/db.js';

/**
 * Undo is offered on a message, and the daemon's chat runs are in-memory
 * objects that do not survive a restart. The versions a run created therefore
 * have to live on the message row, or every deploy silently removes the undo
 * control from every past message.
 */
describe('run file versions persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-file-versions-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedConversation(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    return now;
  }

  const fileVersions = [
    { fileName: 'screens/a.css', versionId: 'v2', previousVersionId: 'v1' },
    { fileName: 'screens/b.html', versionId: 'v9', previousVersionId: null },
  ];

  it('round-trips fileVersions through upsert and listMessages', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'succeeded',
      startedAt: now,
      fileVersions,
    });

    const reloaded = listMessages(db, 'conv-1');
    expect(reloaded[0]!.fileVersions).toEqual(fileVersions);
  });

  it('preserves fileVersions across a later upsert that omits the field', () => {
    // The undo write marks the message undone. If that upsert dropped the
    // versions, the restore would itself become unundoable.
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'succeeded',
      startedAt: now,
      fileVersions,
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      runId: 'run-1',
      runStatus: 'succeeded',
      startedAt: now,
    });

    const reloaded = listMessages(db, 'conv-1');
    expect(reloaded[0]!.fileVersions).toEqual(fileVersions);
  });

  it('records when a message was undone', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'succeeded',
      startedAt: now,
      fileVersions,
      undoneAt: now,
    });

    const reloaded = listMessages(db, 'conv-1');
    expect(reloaded[0]!.undoneAt).toBe(now);
  });
});

describe('pending undo note', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-pending-undo-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
  }

  it('delivers the note exactly once', () => {
    // The agent is told on its next turn. Delivering it twice would have it
    // announce a rewind the user already saw, reading as a second undo.
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    setPendingUndo(db, 'conv-1', { restored: ['a.css'], deleted: [], discardedCount: 2 });

    expect(takePendingUndo(db, 'conv-1')).toEqual({
      restored: ['a.css'],
      deleted: [],
      discardedCount: 2,
    });
    expect(takePendingUndo(db, 'conv-1')).toBeNull();
  });

  it('returns null for a conversation with no pending undo', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seed(db);
    expect(takePendingUndo(db, 'conv-1')).toBeNull();
  });
});
