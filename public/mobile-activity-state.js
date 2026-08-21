const planPrefix = 'agent-remote:mobile-plan-dismissed:';
const activityPrefix = 'agent-remote:mobile-activity-dismissed:';

function storageKey(prefix, sessionName) {
  return sessionName ? `${prefix}${encodeURIComponent(sessionName)}` : undefined;
}

function validActivitySnapshot(snapshot) {
  return snapshot?.version === 1 && Array.isArray(snapshot.subagents);
}

export function createMobileActivityStore(storage) {
  function loadPlan(sessionName) {
    const key = storageKey(planPrefix, sessionName);
    if (!key) return '';
    try { return storage.getItem(key) || ''; }
    catch { return ''; }
  }

  function savePlan(sessionName, revision) {
    const key = storageKey(planPrefix, sessionName);
    if (!key) return;
    try {
      if (revision) storage.setItem(key, revision);
      else storage.removeItem(key);
    } catch {
      // In-memory view state remains usable in private/hardened browsers.
    }
  }

  function loadActivity(sessionName) {
    const key = storageKey(activityPrefix, sessionName);
    if (!key) return undefined;
    try {
      const snapshot = JSON.parse(storage.getItem(key) || 'null');
      return validActivitySnapshot(snapshot) ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  function saveActivity(sessionName, snapshot) {
    const key = storageKey(activityPrefix, sessionName);
    if (!key || !validActivitySnapshot(snapshot)) return;
    try { storage.setItem(key, JSON.stringify(snapshot)); }
    catch {
      // The caller still owns the current in-memory snapshot.
    }
  }

  function clearActivity(sessionName) {
    const key = storageKey(activityPrefix, sessionName);
    if (!key) return;
    try { storage.removeItem(key); }
    catch {
      // The caller still clears its current in-memory snapshot.
    }
  }

  return { loadPlan, savePlan, loadActivity, saveActivity, clearActivity };
}

export function hasActivityAfterDismissal({ dismissed, current, subagentAliases = [] }) {
  if (!dismissed) return false;
  if (current.browser && !dismissed.browser) return true;
  if (current.plan && current.plan !== dismissed.plan) return true;
  const dismissedAliases = new Set(dismissed.subagents);
  return subagentAliases.some((aliases) =>
    aliases.length > 0 && !aliases.some((id) => dismissedAliases.has(id)));
}
