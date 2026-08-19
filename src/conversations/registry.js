export function createConversationRegistry({ providers = [] } = {}) {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));

  async function resolve(session) {
    for (const provider of providers) {
      const handle = await provider.detect(session);
      if (handle) return { provider, handle };
    }
    return undefined;
  }

  return {
    async status(session) {
      const resolved = await resolve(session);
      if (!resolved?.provider.status) return undefined;
      return resolved.provider.status(resolved.handle);
    },

    async read(session, options = {}) {
      const resolved = await resolve(session);
      if (!resolved) return undefined;
      const payload = await resolved.provider.read(resolved.handle, options);
      return {
        provider: { id: resolved.provider.id, label: resolved.provider.label },
        ...payload,
      };
    },

    async watch(session, options = {}, listener) {
      const resolved = await resolve(session);
      if (!resolved?.provider.watch) throw new Error('This conversation provider does not support streaming');
      return resolved.provider.watch(resolved.handle, options, (payload) => listener({
        conversation: {
          provider: { id: resolved.provider.id, label: resolved.provider.label },
          ...payload,
        },
      }));
    },

    encodeInput(providerId, text) {
      const provider = providerById.get(providerId);
      if (!provider?.encodeInput) throw new Error('Conversation provider does not accept input');
      return provider.encodeInput(text);
    },

    async encodeSessionInput(session, text) {
      const resolved = await resolve(session);
      if (!resolved?.provider.encodeInput) throw new Error('This session does not support conversation input');
      return resolved.provider.encodeInput(text);
    },

    async prepareSessionInput(session, text) {
      const resolved = await resolve(session);
      if (!resolved?.provider.encodeInput) throw new Error('This session does not support conversation input');
      return {
        data: resolved.provider.encodeInput(text),
        ...(resolved.provider.inputDeliveryOptions?.() || {}),
      };
    },

    async sendSessionInput(session, text, options = {}) {
      const resolved = await resolve(session);
      if (!resolved?.provider.sendInput) throw new Error('This session does not support conversation input');
      return resolved.provider.sendInput(resolved.handle, text, options);
    },

    async cancel(session) {
      const resolved = await resolve(session);
      if (!resolved?.provider.cancel) throw new Error('This session does not support cancellation');
      return resolved.provider.cancel(resolved.handle);
    },

    async setModel(session, modelId) {
      const resolved = await resolve(session);
      if (!resolved?.provider.setModel) throw new Error('This session does not support model selection');
      return resolved.provider.setModel(resolved.handle, modelId);
    },

    async setMode(session, modeId) {
      const resolved = await resolve(session);
      if (!resolved?.provider.setMode) throw new Error('This session does not support mode selection');
      return resolved.provider.setMode(resolved.handle, modeId);
    },

    async removeQueuedInput(session, queueId) {
      const resolved = await resolve(session);
      if (!resolved?.provider.removeQueuedInput) throw new Error('This session does not support queued input');
      return resolved.provider.removeQueuedInput(resolved.handle, queueId);
    },

    async steerQueuedInput(session, queueId) {
      const resolved = await resolve(session);
      if (!resolved?.provider.steerQueuedInput) throw new Error('This session does not support steering');
      return resolved.provider.steerQueuedInput(resolved.handle, queueId);
    },

    async respondPermission(session, input) {
      const resolved = await resolve(session);
      if (!resolved?.provider.respondPermission) throw new Error('This session does not support permission responses');
      return resolved.provider.respondPermission(resolved.handle, input);
    },

    async respondQuestion(session, input) {
      const resolved = await resolve(session);
      if (!resolved?.provider.respondQuestion) throw new Error('This session does not support question responses');
      return resolved.provider.respondQuestion(resolved.handle, input);
    },

    async close() {
      await Promise.all(providers.map((provider) => provider.close?.()));
    },
  };
}
