const defaultAgentDefinitions = [
  {
    id: 'grok',
    label: 'Grok',
    command: 'grok',
    providerId: 'grok',
    interactive: true,
  },
];

function normalizeAgent(agent) {
  if (!agent || typeof agent !== 'object') throw new TypeError('Agent definitions must be objects');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(agent.id || '')) {
    throw new TypeError('Agent id must use lowercase letters, numbers, and hyphens');
  }
  if (typeof agent.label !== 'string' || !agent.label.trim()) {
    throw new TypeError(`Agent ${agent.id} must have a label`);
  }
  if (typeof agent.command !== 'string' || !agent.command.trim()) {
    throw new TypeError(`Agent ${agent.id} must have a command`);
  }
  return Object.freeze({
    id: agent.id,
    label: agent.label.trim(),
    command: agent.command.trim(),
    providerId: agent.providerId || undefined,
    interactive: agent.interactive !== false,
  });
}

export function createAgentCatalog(definitions = defaultAgentDefinitions) {
  const agents = definitions.map(normalizeAgent);
  const byId = new Map();
  for (const agent of agents) {
    if (byId.has(agent.id)) throw new TypeError(`Duplicate agent id: ${agent.id}`);
    byId.set(agent.id, agent);
  }
  if (!agents.length) throw new TypeError('At least one agent must be configured');

  return Object.freeze({
    list() {
      return agents.map(({ id, label, providerId, interactive }) => ({ id, label, providerId, interactive }));
    },
    get(id) {
      return byId.get(id);
    },
    defaultId: agents[0].id,
  });
}

export const defaultAgents = Object.freeze(defaultAgentDefinitions.map((agent) => Object.freeze({ ...agent })));
