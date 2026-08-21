import { basename } from 'node:path';
import { resolveAllowedDirectory } from '../directories.js';
import { renameManagedSession, startManagedSession, stopManagedSession } from '../sessions.js';
import { json, readJson } from './http.js';

function validProjectName(value, { required = false } = {}) {
  if (value === undefined && !required) return true;
  return typeof value === 'string' && (!required || Boolean(value.trim())) &&
    value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
}

export function createProjectRouteHandler({
  config,
  agentCatalog,
  projectStore,
  getLocalPort,
  publishWorkspaceChange,
  stopProjectSessions,
  closeRenderer,
  conversationStreams,
}) {
  const sessionLaunchOptions = (overrides) => ({
    tmuxCommand: config.tmuxCommand,
    agentRemoteUrl: `http://127.0.0.1:${getLocalPort()}`,
    agentRemoteToken: config.token,
    grokLeaderSocket: config.grokLeaderSocket,
    ...overrides,
  });

  return async function handleProjectRoute({ request, response, pathname }) {
    if (request.method === 'POST' && pathname === '/api/sessions') {
      const body = await readJson(request);
      if (typeof body.commandLine !== 'string' || body.commandLine.trim().length > 4096) {
        json(response, 400, { error: 'commandLine must be a non-empty string under 4096 characters' });
        return true;
      }
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 64)) {
        json(response, 400, { error: 'name must be a string under 64 characters' });
        return true;
      }
      const selected = await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots);
      const session = await startManagedSession(sessionLaunchOptions({
        rawCommand: body.commandLine,
        requestedName: body.name?.trim() || undefined,
        cwd: selected.path,
      }));
      publishWorkspaceChange({ type: 'session-created' });
      json(response, 201, { session });
      return true;
    }

    if (request.method === 'POST' && pathname === '/api/projects') {
      const body = await readJson(request);
      if (typeof body.agentId !== 'string' || !agentCatalog.get(body.agentId)) {
        json(response, 400, { error: 'agentId must identify an available agent' });
        return true;
      }
      if (!validProjectName(body.name)) {
        json(response, 400, { error: 'name must be a string under 80 characters' });
        return true;
      }
      const selected = await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots);
      const project = await projectStore.create({
        name: body.name?.trim() || basename(selected.path) || 'Project',
        cwd: selected.path,
        agentId: body.agentId,
      });
      publishWorkspaceChange({ type: 'project-created' });
      json(response, 201, { project });
      return true;
    }

    const projectSessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (projectSessionsMatch) {
      const project = await projectStore.get(decodeURIComponent(projectSessionsMatch[1]));
      if (!project) {
        json(response, 404, { error: 'Project not found' });
        return true;
      }
      if (request.method === 'POST') {
        const agent = agentCatalog.get(project.agentId);
        if (!agent) {
          json(response, 409, { error: 'The project agent is no longer available' });
          return true;
        }
        const session = await startManagedSession(sessionLaunchOptions({
          rawCommand: agent.command,
          requestedName: 'New chat',
          cwd: project.cwd,
          projectId: project.id,
          autoTitle: true,
        }));
        try {
          projectStore.saveChat({
            name: session.name,
            projectId: project.id,
            title: session.label,
            autoTitle: true,
          });
        } catch (error) {
          await stopManagedSession(config.tmuxCommand, session.name).catch(() => {});
          throw error;
        }
        publishWorkspaceChange({ type: 'session-created' });
        json(response, 201, { session });
        return true;
      }
      if (request.method === 'DELETE') {
        json(response, 200, { cleared: await stopProjectSessions(project.id) });
        return true;
      }
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      const current = await projectStore.get(projectId);
      if (!current) {
        json(response, 404, { error: 'Project not found' });
        return true;
      }
      if (request.method === 'PATCH') {
        const body = await readJson(request);
        const changes = {};
        if (body.name !== undefined) {
          if (!validProjectName(body.name, { required: true })) {
            json(response, 400, { error: 'name must be a non-empty string under 80 characters' });
            return true;
          }
          changes.name = body.name.trim();
        }
        if (body.agentId !== undefined) {
          if (typeof body.agentId !== 'string' || !agentCatalog.get(body.agentId)) {
            json(response, 400, { error: 'agentId must identify an available agent' });
            return true;
          }
          changes.agentId = body.agentId;
        }
        if (body.cwd !== undefined) {
          changes.cwd = (await resolveAllowedDirectory(body.cwd, config.allowedCwdRoots)).path;
        }
        const project = await projectStore.update(projectId, changes);
        publishWorkspaceChange({ type: 'project-updated' });
        json(response, 200, { project });
        return true;
      }
      if (request.method === 'DELETE') {
        const cleared = await stopProjectSessions(projectId);
        await projectStore.remove(projectId);
        publishWorkspaceChange({ type: 'project-deleted' });
        json(response, 200, { deleted: true, cleared });
        return true;
      }
    }

    const activityMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
    if (request.method === 'POST' && activityMatch) {
      const name = decodeURIComponent(activityMatch[1]);
      const lastActiveAt = Date.now();
      const touched = projectStore.touchChat(name, lastActiveAt);
      json(response, touched ? 200 : 404,
        touched ? { lastActiveAt } : { error: 'Project chat not found' });
      return true;
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === 'PATCH' && sessionMatch) {
      const name = decodeURIComponent(sessionMatch[1]);
      const body = await readJson(request);
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 200) {
        json(response, 400, { error: 'label must be a non-empty string' });
        return true;
      }
      const label = await renameManagedSession(config.tmuxCommand, name, body.label);
      if (label) projectStore.renameChat(name, label);
      if (label) publishWorkspaceChange({ type: 'session-updated' });
      json(response, label ? 200 : 404, label ? { label } : { error: 'Managed session not found' });
      return true;
    }

    if (request.method === 'DELETE' && sessionMatch) {
      const name = decodeURIComponent(sessionMatch[1]);
      const stopped = await stopManagedSession(config.tmuxCommand, name);
      closeRenderer(`session:${name}`);
      if (stopped) {
        projectStore.removeChat(name);
        await Promise.all([...conversationStreams]
          .filter((stream) => stream.sessionName === name)
          .map((stream) => stream(true)));
        publishWorkspaceChange({ type: 'sessions-deleted', deleted: [name] });
      }
      json(response, stopped ? 200 : 404, stopped
        ? { stopped: true }
        : { error: 'Managed session not found' });
      return true;
    }

    return false;
  };
}
