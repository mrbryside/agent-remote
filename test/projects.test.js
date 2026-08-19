import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProjectStore } from '../src/projects.js';

test('creates the SQLite database and persists projects and chats', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-projects-'));
  const file = join(root, '.agent-remote', 'agent-remote.db');
  try {
    const first = createProjectStore(file);
    assert.equal(existsSync(file), true);
    const project = first.create({ name: 'Example', cwd: '/tmp/example', agentId: 'grok' });
    const savedChat = first.saveChat({
      name: 'ar-example', projectId: project.id, title: 'New chat', autoTitle: true,
    });
    first.close();

    const second = createProjectStore(file);
    assert.deepEqual(second.get(project.id), project);
    assert.deepEqual(second.getChat('ar-example'), {
      name: 'ar-example',
      projectId: project.id,
      title: 'New chat',
      autoTitle: true,
      createdAt: second.getChat('ar-example').createdAt,
      lastActiveAt: savedChat.lastActiveAt,
    });
    const touchedAt = savedChat.lastActiveAt + 10_000;
    assert.equal(second.touchChat('ar-example', touchedAt), true);
    assert.equal(second.getChat('ar-example').lastActiveAt, touchedAt);
    assert.equal(second.renameChat('ar-example', 'Build the dashboard'), true);
    assert.equal(second.getChat('ar-example').autoTitle, false);
    assert.equal(second.remove(project.id), true);
    assert.equal(second.getChat('ar-example'), undefined);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adds chat activity tracking to databases created with the current project schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-projects-legacy-'));
  const directory = join(root, '.agent-remote');
  const file = join(directory, 'agent-remote.db');
  mkdirSync(directory);
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL,
        agent_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE chats (
        session_name TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, auto_title INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      INSERT INTO projects VALUES ('legacy', 'Legacy', '/tmp/legacy', 'grok', 100, 100);
      INSERT INTO chats VALUES ('legacy-chat', 'legacy', 'Old chat', 1, 123);
    `);
    legacy.close();

    const store = createProjectStore(file);
    assert.equal(store.getChat('legacy-chat').lastActiveAt, 123);
    assert.equal(store.touchChat('legacy-chat', 456), true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
