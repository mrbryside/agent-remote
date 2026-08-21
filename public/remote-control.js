import { api } from './api-client.js';

const POLL_MS = 3_000;
const HOSTNAME_DELAY_MS = 350;
const MASKED_TOKEN = '••••••••••••';

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

function errorMessage(error) {
  return error?.message || 'Remote access could not be updated. Please try again.';
}

function setText(element, value) {
  element.textContent = value || '';
}

/** Bootstrap only after the local runtime explicitly identifies itself. */
export async function bootstrapRemoteControl() {
  const button = document.querySelector('#remote-button');
  const buttonLabel = button?.querySelector('.remote-fab-label');
  const dialog = document.querySelector('#remote-dialog');
  if (!button || !dialog) return;

  let runtime;
  try {
    runtime = await api('/api/runtime');
  } catch {
    return;
  }
  if (runtime.surface !== 'local') return;

  button.hidden = false;
  const state = {
    status: undefined,
    zones: [],
    step: 1,
    connectionChoice: 'quick',
    busy: false,
    poll: undefined,
    hostnameTimer: undefined,
    countdownTimer: undefined,
    expiresAt: undefined,
    previousFocus: undefined,
    deviceCount: 0,
    managingDevices: false,
    loading: false,
  };
  const $ = (selector) => dialog.querySelector(selector);
  const alert = $('#remote-alert');
  const loading = $('#remote-loading');
  const stateLabel = $('#remote-state');
  const url = $('#remote-public-url');
  const cloudflared = $('#remote-cloudflared');
  const tokenForm = $('#remote-token-form');
  const tokenInput = $('#remote-token');
  const tokenSubmit = tokenForm.querySelector('button[type="submit"]');
  const clearToken = $('#remote-clear-token');
  const tokenGuideOpen = $('#remote-token-guide-open');
  const tokenGuideDialog = document.querySelector('#cloudflare-token-guide-dialog');
  const zoneInput = $('#remote-zone');
  const zoneOptions = $('#remote-zone-options');
  const subdomain = $('#remote-subdomain');
  const subdomainOptions = $('#remote-subdomain-options');
  const availability = $('#remote-hostname-availability');
  const suggestions = $('#remote-hostname-suggestions');
  const qr = $('#remote-qr');
  const countdown = $('#remote-pairing-countdown');
  const pairButton = $('#remote-pair');
  const devices = $('#remote-devices');
  const clearDevices = $('#remote-clear-devices');
  const manageDevices = $('#remote-manage-devices');
  const devicesPanel = $('#remote-devices-panel');
  const stepper = dialog.querySelector('.remote-stepper');
  const connectionInputs = [...dialog.querySelectorAll('input[name="remote-connection-type"]')];

  function selectedZone() {
    const value = zoneInput.value.trim().toLowerCase();
    return state.zones.find((zone) => zone.id === value || zone.name.toLowerCase() === value);
  }

  function preferredNamedValues() {
    const named = state.status?.named;
    if (!named?.zoneName || !named?.hostname) return;
    if (!zoneInput.value) zoneInput.value = named.zoneName;
    const suffix = `.${named.zoneName}`;
    if (!subdomain.value && named.hostname.endsWith(suffix)) {
      subdomain.value = named.hostname.slice(0, -suffix.length);
    }
  }

  function renderWizard() {
    for (const panel of dialog.querySelectorAll('[data-remote-step]')) {
      panel.hidden = state.managingDevices || Number(panel.dataset.remoteStep) !== state.step;
    }
    devicesPanel.hidden = !state.managingDevices;
    stepper.hidden = state.managingDevices;
    manageDevices.textContent = state.managingDevices ? 'Setup' : 'Manage devices';
    manageDevices.setAttribute('aria-pressed', String(state.managingDevices));
    const tunnel = state.status?.tunnel || { mode: 'none', state: 'stopped' };
    const activeChoice = tunnel.state === 'running'
      ? (tunnel.mode === 'named' ? 'named' : tunnel.mode === 'quick' ? 'quick' : '')
      : '';
    for (const input of connectionInputs) {
      const label = input.closest('.remote-connection-choice');
      const active = input.value === activeChoice;
      label.dataset.active = String(active);
      label.title = active ? `${input.value === 'named' ? 'Custom Domain' : 'Random URL'} is active` : '';
    }
    for (const stepButton of dialog.querySelectorAll('[data-remote-step-target]')) {
      const target = Number(stepButton.dataset.remoteStepTarget);
      if (!state.managingDevices && target === state.step) stepButton.setAttribute('aria-current', 'step');
      else stepButton.removeAttribute('aria-current');
      const complete = target === 1
        ? state.step > 1 || tunnel.state === 'running' || Boolean(state.status?.named?.hostname)
        : target === 2
          ? (state.connectionChoice === 'quick' && tunnel.state === 'running') || Boolean(state.status?.named?.hostname)
          : state.deviceCount > 0;
      stepButton.dataset.complete = String(complete);
      stepButton.dataset.repeatable = String(target === 3 && complete);
      if (target === 3) stepButton.title = complete
        ? `${state.deviceCount} device${state.deviceCount === 1 ? '' : 's'} paired — add another`
        : 'Pair one or more devices';
    }
    pairButton.textContent = state.deviceCount > 0 ? 'Create QR for another device' : 'Create QR code';
    const next = $('#remote-next');
    const flowComplete = state.deviceCount > 0
      && tunnel.state === 'running'
      && activeChoice === state.connectionChoice;
    next.hidden = state.managingDevices || state.step === 3 || flowComplete;
    if (state.managingDevices) {
      setText($('#remote-step-caption'), 'Manage paired devices');
      return;
    }
    if (state.step === 1) {
      for (const input of connectionInputs) {
        input.checked = input.value === state.connectionChoice;
        input.disabled = state.busy;
      }
      if (state.connectionChoice === 'named') {
        next.textContent = 'Next: Custom Domain';
        next.disabled = state.busy;
      } else {
        const runningQuick = tunnel.mode === 'quick' && tunnel.state === 'running';
        next.textContent = runningQuick ? 'Next: Pair device' : 'Connect Random URL';
        next.disabled = state.busy
          || (!runningQuick && (!state.status?.supported || !state.status?.cloudflared?.available || ['starting', 'stopping'].includes(tunnel.state)));
      }
    } else if (state.step === 2) {
      next.textContent = 'Next: Pair device';
      next.disabled = state.busy || tunnel.state !== 'running';
    } else if (state.step === 3) {
      next.textContent = 'Done';
      next.disabled = state.busy;
    }
    setText($('#remote-step-caption'), `Step ${state.step} of 3`);
  }

  async function ensureZones() {
    if (!state.status?.tokenConfigured || state.zones.length) return;
    try {
      state.zones = (await api('/api/remote/zones')).zones || [];
      renderZones();
    } catch (error) {
      showAlert(errorMessage(error));
    }
  }

  async function setStep(step) {
    state.managingDevices = false;
    state.step = Math.max(1, Math.min(3, Number(step) || 1));
    if (state.step === 2) await ensureZones();
    renderWizard();
    dialog.querySelector(`[data-remote-step="${state.step}"]`)?.focus?.();
  }

  function showAlert(message = '', kind = 'error') {
    alert.dataset.kind = kind;
    alert.hidden = !message;
    setText(alert, message);
  }

  function setDialogLoading(next) {
    state.loading = Boolean(next);
    dialog.dataset.loading = String(state.loading);
    dialog.setAttribute('aria-busy', String(state.loading || state.busy));
    loading.hidden = !state.loading;
    manageDevices.disabled = state.loading;
  }

  function setBusy(busy) {
    state.busy = busy;
    dialog.setAttribute('aria-busy', String(busy || state.loading));
    for (const control of dialog.querySelectorAll('button, input, select')) {
      if (control.matches('[data-remote-close]')) continue;
      control.disabled = busy;
    }
    if (!busy) {
      renderZones();
      renderStatus();
    }
    clearDevices.disabled = busy || state.deviceCount === 0;
    renderWizard();
    schedulePolling();
  }

  function renderZones() {
    const selected = zoneInput.value;
    zoneOptions.replaceChildren();
    for (const zone of state.zones) {
      const option = document.createElement('option');
      option.value = zone.name;
      option.label = zone.name;
      zoneOptions.append(option);
    }
    preferredNamedValues();
    if (!zoneInput.value && state.zones.length === 1) zoneInput.value = state.zones[0].name;
    else if (selected && state.zones.some((zone) => zone.name === selected || zone.id === selected)) zoneInput.value = selected;
    zoneInput.disabled = state.busy || state.zones.length === 0;
  }

  function renderTokenState() {
    const configured = Boolean(state.status?.tokenConfigured);
    tokenInput.dataset.configured = String(configured);
    tokenInput.readOnly = configured;
    tokenInput.disabled = state.busy || configured;
    tokenInput.type = configured ? 'text' : 'password';
    if (configured) tokenInput.value = MASKED_TOKEN;
    else if (tokenInput.value === MASKED_TOKEN) tokenInput.value = '';
    tokenSubmit.hidden = configured;
    tokenSubmit.disabled = state.busy || configured;
    clearToken.disabled = state.busy || !configured;
  }

  function renderStatus() {
    const status = state.status;
    if (!status) return;
    renderTokenState();
    const tunnel = status.tunnel || { mode: 'none', state: 'stopped' };
    const tunnelState = tunnel.state || 'stopped';
    const reconnectNeedsAttention = tunnelState === 'stopped' && status.named?.desiredState === 'running';
    const buttonState = status.supported ? (reconnectNeedsAttention ? 'error' : tunnelState) : 'unavailable';
    const buttonLabels = {
      running: 'Remote On',
      starting: 'Remote Connecting',
      stopping: 'Remote Stopping',
      stopped: 'Remote Off',
      error: 'Remote Error',
      unavailable: 'Remote Unavailable',
    };
    button.dataset.state = buttonState;
    button.title = buttonLabels[buttonState] || 'Remote';
    button.setAttribute('aria-label', `Remote access: ${buttonState}`);
    setText(buttonLabel, buttonLabels[buttonState] || 'Remote');
    setText(stateLabel, status.supported
      ? `${tunnel.mode === 'none' ? 'Remote access' : tunnel.mode === 'quick' ? 'Quick Tunnel' : 'Custom Domain'}: ${tunnelState}`
      : 'Remote access is unavailable on this Mac.');
    url.value = tunnel.publicUrl || tunnel.hostname || '';
    url.closest('.remote-url-row').hidden = !url.value;
    const inspector = status.cloudflared || {};
    if (!status.supported) setText(cloudflared, inspector.error || 'Remote access is supported only on macOS.');
    else if (!inspector.available) {
      const outdated = /outdated|2025\.4\.0|newer is required/i.test(inspector.error || '');
      setText(cloudflared, `${inspector.error || 'cloudflared is not installed.'} ${outdated ? 'Run brew upgrade cloudflared.' : 'Run brew install cloudflared.'}`);
    } else setText(cloudflared, `cloudflared ${inspector.version || 'is ready'}.`);
    cloudflared.dataset.state = !status.supported || !inspector.available ? 'error' : 'ready';

    const canConnect = Boolean(status.supported && inspector.available && !state.busy);
    $('#remote-connect-domain').disabled = !canConnect || !selectedZone() || !subdomain.value.trim();
    const stop = $('#remote-stop');
    stop.hidden = !['starting', 'running', 'stopping', 'error'].includes(tunnelState)
      && status.named?.desiredState !== 'running';
    stop.disabled = state.busy || stop.hidden;
    // Stop intentionally leaves an owned named tunnel and DNS record in place;
    // removal remains available from persisted named metadata after the child
    // has stopped.
    $('#remote-remove').disabled = state.busy || !(tunnel.mode === 'named' || status.named?.hostname);
    pairButton.disabled = state.busy || tunnelState !== 'running' || !tunnel.publicUrl;
    renderWizard();
  }

  function renderDevices(payload, error) {
    state.deviceCount = payload?.devices?.length || 0;
    renderWizard();
    clearDevices.hidden = state.deviceCount === 0;
    clearDevices.disabled = state.busy || state.deviceCount === 0;
    devices.replaceChildren();
    if (error) {
      devices.innerHTML = '<p class="remote-empty">Devices could not be loaded.</p>';
      return;
    }
    if (!payload?.devices?.length) {
      devices.innerHTML = '<p class="remote-empty">No paired devices yet.</p>';
      return;
    }
    for (const device of payload.devices) {
        const row = document.createElement('li');
        row.className = 'remote-device';
        const detail = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = device.name;
        const meta = document.createElement('span');
        meta.textContent = `Paired ${formatDate(device.createdAt)} · Last used ${formatDate(device.lastUsedAt)}`;
        detail.append(name, meta);
        row.append(detail);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'danger-button';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async () => {
          if (!confirm(`Revoke ${device.name}? This removes it from paired devices and closes its access immediately.`)) return;
          await run(async () => {
            await reconcileDeviceMutation(
              () => api(`/api/remote/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }),
              (latestDevices) => !latestDevices.some(({ id }) => id === device.id),
            );
            showAlert(`${device.name} was removed.`, 'success');
          });
        });
        row.append(revoke);
      devices.append(row);
    }
  }

  async function refreshDevices() {
    try {
      renderDevices(await api('/api/remote/devices'));
    } catch (error) {
      renderDevices(undefined, error);
      showAlert(errorMessage(error));
    }
  }

  async function loadRemoteSetup() {
    const [statusResult, devicesResult] = await Promise.allSettled([
      api('/api/remote/status'), api('/api/remote/devices'),
    ]);
    if (statusResult.status === 'fulfilled') state.status = statusResult.value;
    else showAlert(errorMessage(statusResult.reason));
    if (devicesResult.status === 'fulfilled') renderDevices(devicesResult.value);
    else {
      renderDevices(undefined, devicesResult.reason);
      if (statusResult.status === 'fulfilled') showAlert(errorMessage(devicesResult.reason));
    }
    state.connectionChoice = state.status?.tunnel?.mode === 'named' || state.status?.named?.hostname ? 'named' : 'quick';
    if (state.status?.tokenConfigured) await ensureZones();
    preferredNamedValues();
    renderStatus();
    renderWizard();
  }

  async function reconcileDeviceMutation(mutate, isComplete) {
    let result;
    let mutationError;
    try {
      result = await mutate();
    } catch (error) {
      mutationError = error;
    }

    // The device list is authoritative. A second local controller can win the
    // delete race and make a revoke respond 404 even though the requested end
    // state has already been reached. Reconcile immediately instead of leaving
    // a stale row visible until the next poll.
    const payload = await api('/api/remote/devices');
    renderDevices(payload);
    if (mutationError && !isComplete(payload.devices || [])) throw mutationError;
    return { result, devices: payload.devices || [] };
  }

  function stopCountdown() {
    clearInterval(state.countdownTimer);
    state.countdownTimer = undefined;
  }

  function renderCountdown() {
    if (!state.expiresAt) { setText(countdown, 'Create a QR code when you are ready to pair a device.'); return; }
    const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1_000));
    setText(countdown, seconds ? `QR code expires in ${seconds}s.` : 'This QR code has expired. Create a new one.');
    if (!seconds) stopCountdown();
  }

  function setPairing(pairing) {
    state.expiresAt = Number(pairing.expiresAt);
    qr.src = pairing.qrDataUrl;
    qr.hidden = false;
    renderCountdown();
    stopCountdown();
    state.countdownTimer = setInterval(renderCountdown, 1_000);
  }

  async function refreshStatus({ devices: includeDevices = false } = {}) {
    try {
      state.status = await api('/api/remote/status');
      renderStatus();
      if (includeDevices) await refreshDevices();
    } catch (error) {
      showAlert(errorMessage(error));
    }
  }

  async function refreshTunnelStatus() {
    if (!state.status) return refreshStatus();
    try {
      const payload = await api('/api/remote/tunnel-status');
      state.status = { ...state.status, tunnel: payload.tunnel || { mode: 'none', state: 'stopped' } };
      renderStatus();
    } catch {
      // Keep the last known state; opening the dialog performs a full refresh
      // and exposes any actionable error there.
    }
  }

  function schedulePolling() {
    clearInterval(state.poll);
    state.poll = undefined;
    if (state.busy || document.visibilityState === 'hidden') return;
    state.poll = setInterval(() => {
      const refresh = dialog.open ? refreshStatus({ devices: true }) : refreshTunnelStatus();
      refresh.catch(() => {});
    }, POLL_MS);
  }

  async function run(action) {
    setBusy(true);
    showAlert();
    try {
      await action();
      await refreshStatus({ devices: dialog.open });
    } catch (error) {
      showAlert(errorMessage(error));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function checkAvailability() {
    const zone = selectedZone();
    const zoneId = zone?.id;
    const value = subdomain.value.trim().toLowerCase();
    suggestions.replaceChildren();
    subdomainOptions.replaceChildren();
    if (!zoneId || !value) { setText(availability, 'Choose a zone and subdomain to check availability.'); return undefined; }
    setText(availability, 'Checking hostname…');
    try {
      const result = await api(`/api/remote/hostname-availability?zoneId=${encodeURIComponent(zoneId)}&subdomain=${encodeURIComponent(value)}`);
      availability.dataset.state = result.status;
      setText(availability, result.status === 'conflict'
        ? `${result.hostname} is already in use. agent-remote will not overwrite it.`
        : `${result.hostname} is ${result.status === 'reusable' ? 'already owned by this installation and can be reused' : 'available'}.`);
      for (const suggestion of result.suggestions || []) {
        const label = suggestion.split('.')[0];
        const option = document.createElement('option');
        option.value = label;
        subdomainOptions.append(option);
        const suggestionButton = document.createElement('button');
        suggestionButton.type = 'button';
        suggestionButton.className = 'quiet-button remote-suggestion';
        suggestionButton.textContent = `Use ${suggestion}`;
        suggestionButton.addEventListener('click', () => { subdomain.value = label; void checkAvailability(); });
        suggestions.append(suggestionButton);
      }
      return result;
    } catch (error) {
      setText(availability, errorMessage(error));
      availability.dataset.state = 'error';
      return undefined;
    }
  }

  function queueAvailability() {
    clearTimeout(state.hostnameTimer);
    state.hostnameTimer = setTimeout(() => { void checkAvailability(); }, HOSTNAME_DELAY_MS);
    renderStatus();
  }

  setDialogLoading(true);
  const setupPromise = loadRemoteSetup().finally(() => {
    setDialogLoading(false);
    schedulePolling();
  });

  button.addEventListener('click', () => {
    state.previousFocus = document.activeElement;
    state.step = 1;
    state.managingDevices = false;
    showAlert();
    dialog.showModal();
    dialog.querySelector('[data-remote-close]').focus();
    renderStatus();
    renderWizard();
  });
  dialog.addEventListener('close', () => {
    if (tokenGuideDialog?.open) tokenGuideDialog.close();
    clearTimeout(state.hostnameTimer);
    stopCountdown();
    schedulePolling();
    state.previousFocus?.focus?.();
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close(); });
  dialog.querySelector('[data-remote-close]').addEventListener('click', () => dialog.close());
  tokenGuideOpen?.addEventListener('click', () => {
    if (!tokenGuideDialog?.open) tokenGuideDialog?.showModal();
    tokenGuideDialog?.querySelector('[aria-label="Close token guide"]')?.focus();
  });
  tokenGuideDialog?.addEventListener('close', () => {
    if (dialog.open) tokenGuideOpen?.focus();
  });
  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = tokenInput.value;
    void run(async () => {
      const response = await api('/api/remote/cloudflare-token', { method: 'PUT', body: JSON.stringify({ token: value }) });
      state.zones = response.zones || [];
      renderZones();
      if (state.zones.length === 1) queueAvailability();
      showAlert('Cloudflare token validated and stored in Keychain.', 'success');
    }).finally(renderTokenState);
  });
  clearToken.addEventListener('click', () => void run(async () => {
    await api('/api/remote/cloudflare-token', { method: 'DELETE' });
    state.zones = [];
    zoneInput.value = '';
    renderZones();
    showAlert('Cloudflare token removed from Keychain.', 'success');
  }));
  zoneInput.addEventListener('input', queueAvailability);
  zoneInput.addEventListener('change', queueAvailability);
  subdomain.addEventListener('input', queueAvailability);
  for (const input of connectionInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.connectionChoice = input.value;
      renderWizard();
    });
  }
  $('#remote-connect-domain').addEventListener('click', () => void run(async () => {
    const result = await checkAvailability();
    if (!result || result.status === 'conflict') throw new Error('Choose an available hostname; agent-remote never overwrites an existing DNS record.');
    const zone = selectedZone();
    await api('/api/remote/tunnels/named', {
      method: 'POST', body: JSON.stringify({ zoneId: zone.id, subdomain: subdomain.value.trim().toLowerCase() }),
    });
  }));
  $('#remote-stop').addEventListener('click', () => void run(async () => { await api('/api/remote/tunnels/stop', { method: 'POST' }); }));
  $('#remote-remove').addEventListener('click', () => {
    if (!confirm('Remove this Custom Domain? This deletes only resources agent-remote still proves it owns.')) return;
    void run(async () => {
      const result = await api('/api/remote/tunnels/named', { method: 'DELETE' });
      showAlert(result.warnings?.length ? result.warnings.join(' ') : 'Custom Domain removed.', result.warnings?.length ? 'warning' : 'success');
    });
  });
  $('#remote-copy-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url.value); showAlert('Public URL copied.', 'success'); }
    catch { url.select(); document.execCommand('copy'); showAlert('Public URL copied.', 'success'); }
  });
  $('#remote-open-url').addEventListener('click', () => window.open(url.value, '_blank', 'noopener,noreferrer'));
  pairButton.addEventListener('click', () => void run(async () => { setPairing(await api('/api/remote/pairing-sessions', { method: 'POST' })); }));
  clearDevices.addEventListener('click', () => {
    if (!confirm('Revoke every paired device? This removes the entire list and closes all remote access immediately.')) return;
    void run(async () => {
      const previousCount = state.deviceCount;
      const { result, devices: latestDevices } = await reconcileDeviceMutation(
        () => api('/api/remote/devices', { method: 'DELETE' }),
        (devicesAfterDelete) => devicesAfterDelete.length === 0,
      );
      const removed = result?.removed ?? Math.max(0, previousCount - latestDevices.length);
      showAlert(`${removed} paired device${removed === 1 ? '' : 's'} removed.`, 'success');
    });
  });
  for (const stepButton of dialog.querySelectorAll('[data-remote-step-target]')) {
    stepButton.addEventListener('click', () => void setStep(stepButton.dataset.remoteStepTarget));
  }
  manageDevices.addEventListener('click', () => {
    void (async () => {
      state.managingDevices = !state.managingDevices;
      if (state.managingDevices) await refreshDevices();
      renderWizard();
      (state.managingDevices ? devicesPanel : dialog.querySelector(`[data-remote-step="${state.step}"]`))?.focus?.();
    })();
  });
  $('#remote-next').addEventListener('click', () => {
    void (async () => {
      if (state.step === 3) { dialog.close(); return; }
      if (state.step === 1) {
        if (state.connectionChoice === 'named') { await setStep(2); return; }
        if (state.status?.tunnel?.mode !== 'quick' || state.status?.tunnel?.state !== 'running') {
          await run(async () => { await api('/api/remote/tunnels/quick', { method: 'POST' }); });
        }
        if (state.status?.tunnel?.mode === 'quick' && state.status?.tunnel?.state === 'running') await setStep(3);
        return;
      }
      await setStep(state.step + 1);
    })();
  });
  document.addEventListener('visibilitychange', () => {
    schedulePolling();
    if (document.visibilityState === 'visible') {
      const refresh = dialog.open ? refreshStatus({ devices: true }) : refreshTunnelStatus();
      void refresh;
    }
  });
  await setupPromise;
}
