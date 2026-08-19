import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function projectSlug(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'project';
}

function projectRow(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatRow(row) {
  if (!row) return undefined;
  return {
    name: row.session_name,
    projectId: row.project_id,
    title: row.title,
    autoTitle: row.auto_title === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at ?? row.created_at,
  };
}

export function createProjectStore(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      session_name TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      auto_title INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS chats_project_id ON chats(project_id);
  `);
  const chatColumns = new Set(database.prepare('PRAGMA table_info(chats)').all().map((column) => column.name));
  if (!chatColumns.has('last_active_at')) database.exec('ALTER TABLE chats ADD COLUMN last_active_at INTEGER');
  database.exec(`
    UPDATE chats SET last_active_at = created_at WHERE last_active_at IS NULL;
    CREATE INDEX IF NOT EXISTS chats_project_activity ON chats(project_id, last_active_at DESC);
  `);

  const statements = {
    listProjects: database.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    getProject: database.prepare('SELECT * FROM projects WHERE id = ?'),
    insertProject: database.prepare('INSERT INTO projects (id, name, cwd, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    updateProject: database.prepare('UPDATE projects SET name = ?, cwd = ?, agent_id = ?, updated_at = ? WHERE id = ?'),
    deleteProject: database.prepare('DELETE FROM projects WHERE id = ?'),
    listChats: database.prepare('SELECT * FROM chats ORDER BY last_active_at DESC, created_at DESC'),
    getChat: database.prepare('SELECT * FROM chats WHERE session_name = ?'),
    insertChat: database.prepare('INSERT OR REPLACE INTO chats (session_name, project_id, title, auto_title, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)'),
    renameChat: database.prepare('UPDATE chats SET title = ?, auto_title = 0 WHERE session_name = ?'),
    touchChat: database.prepare('UPDATE chats SET last_active_at = ? WHERE session_name = ?'),
    deleteChat: database.prepare('DELETE FROM chats WHERE session_name = ?'),
    deleteProjectChats: database.prepare('DELETE FROM chats WHERE project_id = ?'),
  };

  return {
    list() {
      return statements.listProjects.all().map(projectRow);
    },

    get(id) {
      return projectRow(statements.getProject.get(id));
    },

    create({ name, cwd, agentId }) {
      const now = Date.now();
      const project = {
        id: `${projectSlug(name)}-${randomBytes(3).toString('hex')}`,
        name,
        cwd,
        agentId,
        createdAt: now,
        updatedAt: now,
      };
      statements.insertProject.run(project.id, name, cwd, agentId, now, now);
      return project;
    },

    update(id, changes) {
      const project = this.get(id);
      if (!project) return undefined;
      const updated = {
        ...project,
        ...changes,
        updatedAt: Date.now(),
      };
      statements.updateProject.run(updated.name, updated.cwd, updated.agentId, updated.updatedAt, id);
      return updated;
    },

    remove(id) {
      return statements.deleteProject.run(id).changes > 0;
    },

    listChats() {
      return statements.listChats.all().map(chatRow);
    },

    getChat(name) {
      return chatRow(statements.getChat.get(name));
    },

    saveChat({
      name,
      projectId,
      title = 'New chat',
      autoTitle = true,
      createdAt = Date.now(),
      lastActiveAt = createdAt,
    }) {
      statements.insertChat.run(name, projectId, title, autoTitle ? 1 : 0, createdAt, lastActiveAt);
      return this.getChat(name);
    },

    renameChat(name, title) {
      return statements.renameChat.run(title, name).changes > 0;
    },

    touchChat(name, lastActiveAt = Date.now()) {
      return statements.touchChat.run(lastActiveAt, name).changes > 0;
    },

    removeChat(name) {
      return statements.deleteChat.run(name).changes > 0;
    },

    removeProjectChats(projectId) {
      return statements.deleteProjectChats.run(projectId).changes;
    },

    close() {
      database.close();
    },
  };
}
