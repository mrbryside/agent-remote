import { api } from './api-client.js';
import { installDialogBackdropDismiss } from './ui-components.js';

const POLL_MS = 3_000;
const HOSTNAME_DELAY_MS = 350;
const MASKED_TOKEN = '••••••••••••';
const DEFAULT_LOADING_TITLE = 'Loading remote setup…';
const DEFAULT_LOADING_COPY = 'Checking the active connection and paired devices.';

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
  if (matchMedia('(max-width: 760px)').matches) return;
  const button = document.querySelector('#remote-button');
  const buttonLabel = button?.querySelector('.remote-fab-label');
  const dialog = document.querySelector('#remote-dialog');
  if (!button || !dialog) return;

  function removeLocalRemoteControls() {
    button.closest('.sidebar-footer')?.remove();
    dialog.remove();
    document.querySelector('#cloudflare-token-guide-dialog')?.remove();
  }

  let runtime;
  try {
    runtime = await api('/api/runtime');
  } catch {
    removeLocalRemoteControls();
    return;
  }
  if (runtime.surface !== 'local') {
    removeLocalRemoteControls();
    return;
  }

  const buttonLabels = {
    loading: 'Remote',
    running: 'Remote On',
    starting: 'Remote Connecting',
    stopping: 'Remote Stopping',
    stopped: 'Remote Off',
    error: 'Remote Error',
    unavailable: 'Remote Unavailable',
  };
  function setRemoteButtonState(buttonState) {
    button.dataset.state = buttonState;
    button.title = buttonLabels[buttonState] || 'Remote';
    button.setAttribute('aria-label', `Remote access: ${buttonState}`);
    button.toggleAttribute('aria-busy', buttonState === 'loading');
    setText(buttonLabel, buttonLabels[buttonState] || 'Remote');
  }
  setRemoteButtonState('loading');
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
    operation: undefined,
    hostnameCheck: undefined,
  };
  const $ = (selector) => dialog.querySelector(selector);
  const alert = $('#remote-alert');
  const loading = $('#remote-loading');
  const loadingTitle = $('#remote-loading-title');
  const loadingCopy = $('#remote-loading-copy');
  const runtimeStatus = $('#remote-runtime-status');
  const stateLabel = $('#remote-state');
  const stateDetail = $('#remote-state-detail');
  const url = $('#remote-public-url');
  const cloudflared = $('#remote-cloudflared');
  const tokenForm = $('#remote-token-form');
  const tokenInput = $('#remote-token');
  const tokenSubmit = tokenForm.querySelector('button[type="submit"]');
  const clearToken = $('#remote-clear-token');
  const tokenGuideOpen = $('#remote-token-guide-open');
  const tokenGuideDialog = document.querySelector('#cloudflare-token-guide-dialog');
  installDialogBackdropDismiss(dialog);
  installDialogBackdropDismiss(tokenGuideDialog);
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
  const powerButton = $('#remote-power');
  const powerHint = $('#remote-power-hint');
  const devicesPanel = $('#remote-devices-panel');
  const stepper = dialog.querySelector('.remote-stepper');
  const devicesStepNumber = $('#remote-devices-step-number');
  const devicesStepHint = $('#remote-devices-step-hint');
  const nextHint = $('#remote-next-hint');
  const pairKicker = $('#remote-pair-kicker');
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

  function currentTunnel() {
    return state.status?.tunnel || { mode: 'none', state: 'stopped' };
  }

  function remoteIsRunning() {
    return currentTunnel().state === 'running';
  }

  function savedConnectionChoice() {
    const tunnel = currentTunnel();
    if (tunnel.mode === 'named' || tunnel.mode === 'quick') return tunnel.mode;
    return state.status?.named?.hostname ? 'named' : 'quick';
  }

  function savedNamedValues() {
    const named = state.status?.named;
    if (!named?.zoneName || !named?.hostname) return { zone: '', subdomain: '' };
    const suffix = `.${named.zoneName}`;
    return {
      zone: named.zoneName,
      subdomain: named.hostname.endsWith(suffix)
        ? named.hostname.slice(0, -suffix.length)
        : '',
    };
  }

  function resetDraftFromStatus() {
    const named = savedNamedValues();
    state.connectionChoice = savedConnectionChoice();
    zoneInput.value = named.zone;
    subdomain.value = named.subdomain;
    state.hostnameCheck = undefined;
    suggestions.replaceChildren();
    subdomainOptions.replaceChildren();
    availability.removeAttribute('data-state');
    setText(availability, named.zone && named.subdomain
      ? 'Checking hostname…'
      : 'Choose a zone and subdomain to check availability.');
  }

  function wizardSteps() {
    return state.connectionChoice === 'named' ? [1, 2, 3] : [1, 3];
  }

  function hostnameKey() {
    const zone = selectedZone();
    const value = subdomain.value.trim().toLowerCase();
    return zone && value ? `${zone.id}:${value}` : '';
  }

  function namedConfigurationReason() {
    if (!state.status?.tokenConfigured) return 'Validate a Cloudflare API token in Domain first.';
    if (!state.zones.length) return 'Load at least one Cloudflare zone in Domain first.';
    if (!selectedZone()) return 'Choose a Cloudflare zone in Domain first.';
    if (!subdomain.value.trim()) return 'Enter a subdomain in Domain first.';
    if (!subdomain.checkValidity()) return 'Enter a valid lowercase subdomain in Domain first.';
    const key = hostnameKey();
    if (!state.hostnameCheck || state.hostnameCheck.key !== key) return 'Wait for the domain availability check to finish.';
    if (state.hostnameCheck.state === 'checking') return 'Checking whether the Custom Domain is available.';
    if (state.hostnameCheck.state === 'error') return 'Resolve the domain availability error before starting.';
    if (state.hostnameCheck.result?.status === 'conflict') return 'Choose an available Custom Domain before starting.';
    if (!['available', 'reusable'].includes(state.hostnameCheck.result?.status)) return 'Check the Custom Domain before starting.';
    return '';
  }

  function startDisabledReason() {
    if (state.loading || !state.status) return 'Remote setup is still loading.';
    if (state.busy || state.operation) return 'A Remote action is already in progress.';
    if (!state.status.supported) return state.status.cloudflared?.error || 'Remote access is unavailable on this Mac.';
    if (!state.status.cloudflared?.available) return state.status.cloudflared?.error || 'Install or update cloudflared before starting.';
    return state.connectionChoice === 'named' ? namedConfigurationReason() : '';
  }

  function shouldStopRemote() {
    const tunnel = currentTunnel();
    return ['starting', 'running', 'stopping'].includes(tunnel.state)
      || (state.status?.named?.desiredState === 'running' && tunnel.mode === 'named');
  }

  function hasRestartRelevantChanges() {
    const tunnel = currentTunnel();
    if (!shouldStopRemote()) return false;
    if (state.connectionChoice !== tunnel.mode) return true;
    if (state.connectionChoice !== 'named') return false;
    const zone = selectedZone();
    const draftedHostname = zone && subdomain.value.trim()
      ? `${subdomain.value.trim().toLowerCase()}.${zone.name.toLowerCase()}`
      : '';
    const savedHostname = (tunnel.hostname || state.status?.named?.hostname || '').toLowerCase();
    const savedZone = (state.status?.named?.zoneName || '').toLowerCase();
    return !zone
      || zone.name.toLowerCase() !== savedZone
      || draftedHostname !== savedHostname;
  }

  function updateDisabledReason() {
    if (state.loading || state.busy || state.operation) return 'A Remote action is already in progress.';
    return state.connectionChoice === 'named' ? namedConfigurationReason() : '';
  }

  function renderPowerButton() {
    const tunnel = currentTunnel();
    let label = 'Start Remote';
    let reason = '';
    let disabled = false;
    if (state.operation === 'updating') {
      label = 'Updating & Restarting…';
      reason = 'Applying the new Remote configuration.';
      disabled = true;
    } else if (state.operation === 'starting' || tunnel.state === 'starting') {
      label = 'Starting…';
      reason = 'Remote access is starting.';
      disabled = true;
    } else if (state.operation === 'stopping' || tunnel.state === 'stopping') {
      label = 'Stopping…';
      reason = 'Remote access is stopping.';
      disabled = true;
    } else if (shouldStopRemote()) {
      const updating = hasRestartRelevantChanges();
      label = updating ? 'Update & Restart' : 'Stop Remote';
      reason = updating
        ? updateDisabledReason()
        : state.busy || state.loading ? 'A Remote action is already in progress.' : '';
      disabled = Boolean(reason);
    } else {
      reason = startDisabledReason();
      disabled = Boolean(reason);
    }
    powerButton.textContent = label;
    powerButton.disabled = disabled;
    powerButton.dataset.action = label === 'Update & Restart'
      ? 'update'
      : label === 'Updating & Restarting…'
        ? 'updating'
        : label === 'Stop Remote'
      ? 'stop'
      : label === 'Stopping…'
        ? 'stopping'
        : label === 'Starting…' ? 'starting' : 'start';
    powerHint.title = reason || (label === 'Stop Remote'
      ? 'Stop the active Remote connection.'
      : label === 'Update & Restart'
        ? 'Apply the changed configuration and restart Remote access.'
        : `Start Remote using ${state.connectionChoice === 'named' ? 'the Custom Domain' : 'a Random URL'}.`);
    powerHint.tabIndex = disabled ? 0 : -1;
    if (disabled) {
      powerHint.setAttribute('aria-label', 'Start Remote unavailable');
      powerHint.setAttribute('aria-description', reason);
    } else {
      powerHint.removeAttribute('aria-label');
      powerHint.removeAttribute('aria-description');
    }
  }

  function renderWizard() {
    const steps = wizardSteps();
    if (!steps.includes(state.step)) state.step = 1;
    const remoteRunning = remoteIsRunning();
    if (!remoteRunning && state.step === 3) state.step = steps.at(-2) || 1;
    for (const panel of dialog.querySelectorAll('[data-remote-step]')) {
      panel.hidden = state.managingDevices || Number(panel.dataset.remoteStep) !== state.step;
    }
    devicesPanel.hidden = !state.managingDevices;
    stepper.hidden = state.managingDevices;
    stepper.dataset.connection = state.connectionChoice;
    for (const element of dialog.querySelectorAll('[data-remote-domain-only]')) {
      element.hidden = state.connectionChoice !== 'named';
    }
    devicesStepNumber.textContent = state.connectionChoice === 'named' ? '3' : '2';
    setText(pairKicker, `${state.connectionChoice === 'named' ? 3 : 2} · Pair devices`);
    manageDevices.textContent = state.managingDevices ? 'Setup' : 'Manage devices';
    manageDevices.setAttribute('aria-pressed', String(state.managingDevices));
    const tunnel = currentTunnel();
    const activeChoice = tunnel.state === 'running'
      ? (tunnel.mode === 'named' ? 'named' : tunnel.mode === 'quick' ? 'quick' : '')
      : '';
    for (const input of connectionInputs) {
      input.checked = input.value === state.connectionChoice;
      input.disabled = state.busy;
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
        ? true
        : target === 2
          ? !namedConfigurationReason()
          : state.deviceCount > 0;
      stepButton.dataset.complete = String(complete);
      stepButton.dataset.repeatable = String(target === 3 && complete);
      if (target === 3) {
        const reason = remoteRunning
          ? complete
            ? `${state.deviceCount} device${state.deviceCount === 1 ? '' : 's'} paired — add another`
            : 'Pair one or more devices'
          : 'Start Remote before continuing to Devices.';
        stepButton.disabled = !remoteRunning;
        stepButton.removeAttribute('title');
        devicesStepHint.dataset.disabled = String(!remoteRunning);
        devicesStepHint.title = reason;
        devicesStepHint.tabIndex = remoteRunning ? -1 : 0;
        if (!remoteRunning) {
          devicesStepHint.setAttribute('aria-label', 'Devices step unavailable');
          devicesStepHint.setAttribute('aria-description', reason);
        } else {
          devicesStepHint.removeAttribute('aria-label');
          devicesStepHint.removeAttribute('aria-description');
        }
      }
    }
    pairButton.textContent = state.deviceCount > 0 ? 'Create QR for another device' : 'Create QR code';
    const next = $('#remote-next');
    next.hidden = state.managingDevices || state.step === steps.at(-1);
    nextHint.hidden = next.hidden;
    if (state.managingDevices) {
      setText($('#remote-step-caption'), 'Manage paired devices');
      return;
    }
    if (state.step === 1) {
      if (state.connectionChoice === 'named') {
        next.textContent = 'Next: Custom Domain';
        next.disabled = state.busy;
      } else {
        next.textContent = 'Next: Pair devices';
        next.disabled = state.busy;
      }
    } else if (state.step === 2) {
      next.textContent = 'Next: Pair devices';
      next.disabled = state.busy;
    } else if (state.step === 3) {
      next.textContent = 'Done';
      next.disabled = state.busy;
    }
    const nextStep = steps[steps.indexOf(state.step) + 1];
    const nextReason = nextStep === 3 && !remoteRunning
      ? 'Start Remote before continuing to Devices.'
      : state.busy ? 'A Remote action is already in progress.' : '';
    if (nextReason) next.disabled = true;
    nextHint.dataset.disabled = String(next.disabled);
    nextHint.title = nextReason;
    nextHint.tabIndex = nextReason ? 0 : -1;
    if (nextReason) {
      nextHint.setAttribute('aria-label', `${next.textContent} unavailable`);
      nextHint.setAttribute('aria-description', nextReason);
    } else {
      nextHint.removeAttribute('aria-label');
      nextHint.removeAttribute('aria-description');
    }
    setText($('#remote-step-caption'), `Step ${steps.indexOf(state.step) + 1} of ${steps.length}`);
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
    const target = Number(step) || 1;
    if (target === 3 && !remoteIsRunning()) return;
    state.step = wizardSteps().includes(target) ? target : 1;
    if (state.step === 2) await ensureZones();
    if (state.step === 2 && hostnameKey() && state.hostnameCheck?.key !== hostnameKey()) void checkAvailability();
    renderWizard();
    dialog.querySelector(`[data-remote-step="${state.step}"]`)?.focus?.();
  }

  function showAlert(message = '', kind = 'error') {
    alert.dataset.kind = kind;
    alert.hidden = !message;
    setText(alert, message);
  }

  function setDialogLoading(next, {
    title = DEFAULT_LOADING_TITLE,
    copy = DEFAULT_LOADING_COPY,
  } = {}) {
    state.loading = Boolean(next);
    dialog.dataset.loading = String(state.loading);
    dialog.setAttribute('aria-busy', String(state.loading || state.busy));
    setText(loadingTitle, title);
    setText(loadingCopy, copy);
    loading.hidden = !state.loading;
    powerHint.hidden = state.loading;
    manageDevices.hidden = state.loading;
    manageDevices.disabled = state.loading;
    if (state.status) renderStatus();
    else renderPowerButton();
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
    } else {
      renderPowerButton();
      renderWizard();
    }
    clearDevices.disabled = busy || state.deviceCount === 0;
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
    renderPowerButton();
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
    setRemoteButtonState(buttonState);
    runtimeStatus.dataset.state = buttonState;
    if (!status.supported) {
      setText(stateLabel, 'Remote unavailable');
      setText(stateDetail, status.cloudflared?.error || 'Remote access is unavailable on this Mac.');
    } else if (tunnelState === 'running') {
      setText(stateLabel, 'Remote connected');
      setText(stateDetail, tunnel.mode === 'named'
        ? `Custom Domain ${tunnel.hostname || tunnel.publicUrl || ''} is live.`
        : 'Random URL is live.');
    } else if (tunnelState === 'starting') {
      setText(stateLabel, 'Remote starting');
      setText(stateDetail, `Opening ${tunnel.mode === 'named' ? 'the Custom Domain' : 'a Random URL'}.`);
    } else if (tunnelState === 'stopping') {
      setText(stateLabel, 'Remote stopping');
      setText(stateDetail, 'Closing the public tunnel.');
    } else if (buttonState === 'error' || tunnelState === 'error') {
      setText(stateLabel, 'Remote needs attention');
      setText(stateDetail, tunnel.error?.message || 'The saved Remote connection could not be started.');
    } else {
      const reason = startDisabledReason();
      setText(stateLabel, 'Remote is off');
      setText(stateDetail, reason
        ? `Setup incomplete: ${reason}`
        : `${state.connectionChoice === 'named' ? 'Custom Domain' : 'Random URL'} is configured and ready to start.`);
    }
    url.value = tunnel.publicUrl || tunnel.hostname || '';
    url.closest('.remote-url-row').hidden = !url.value;
    const inspector = status.cloudflared || {};
    if (!status.supported) setText(cloudflared, inspector.error || 'Remote access is supported only on macOS.');
    else if (!inspector.available) {
      const outdated = /outdated|2025\.4\.0|newer is required/i.test(inspector.error || '');
      setText(cloudflared, `${inspector.error || 'cloudflared is not installed.'} ${outdated ? 'Run brew upgrade cloudflared.' : 'Run brew install cloudflared.'}`);
    } else setText(cloudflared, `cloudflared ${inspector.version || 'is ready'}.`);
    cloudflared.dataset.state = !status.supported || !inspector.available ? 'error' : 'ready';

    pairButton.disabled = state.busy || tunnelState !== 'running' || !tunnel.publicUrl;
    pairButton.title = pairButton.disabled && tunnelState !== 'running'
      ? 'Start Remote before creating a pairing QR code.'
      : '';
    renderPowerButton();
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
    else {
      setRemoteButtonState('error');
      showAlert(errorMessage(statusResult.reason));
    }
    if (devicesResult.status === 'fulfilled') renderDevices(devicesResult.value);
    else {
      renderDevices(undefined, devicesResult.reason);
      if (statusResult.status === 'fulfilled') showAlert(errorMessage(devicesResult.reason));
    }
    state.connectionChoice = state.status?.tunnel?.mode === 'named' || state.status?.named?.hostname ? 'named' : 'quick';
    state.step = currentTunnel().state === 'running' ? wizardSteps().at(-1) : 1;
    if (state.status?.tokenConfigured) await ensureZones();
    preferredNamedValues();
    if (state.connectionChoice === 'named' && hostnameKey()) await checkAvailability();
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

  function resetPairingAfterStop() {
    clearTimeout(state.hostnameTimer);
    state.hostnameTimer = undefined;
    stopCountdown();
    state.expiresAt = undefined;
    qr.hidden = true;
    qr.removeAttribute('src');
    renderCountdown();
    renderWizard();
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

  async function runWithDialogLoading(action, {
    title = 'Opening Remote access…',
    copy = 'Starting the public tunnel. Keep this window open.',
  } = {}) {
    setDialogLoading(true, { title, copy });
    try {
      await run(action);
    } finally {
      setDialogLoading(false);
    }
  }

  async function startRemote({ restart = false } = {}) {
    const reason = restart ? updateDisabledReason() : startDisabledReason();
    if (reason) return;
    state.operation = restart ? 'updating' : 'starting';
    renderPowerButton();
    try {
      await runWithDialogLoading(async () => {
        if (state.connectionChoice === 'quick') {
          await api('/api/remote/tunnels/quick', { method: 'POST' });
        } else {
          const result = await checkAvailability();
          if (!result || result.status === 'conflict') {
            throw new Error('Choose an available hostname; agent-remote never overwrites an existing DNS record.');
          }
          const zone = selectedZone();
          await api('/api/remote/tunnels/named', {
            method: 'POST', body: JSON.stringify({ zoneId: zone.id, subdomain: subdomain.value.trim().toLowerCase() }),
          });
        }
        state.step = wizardSteps().at(-1);
        state.managingDevices = false;
        showAlert(restart ? 'Remote configuration updated and restarted.' : 'Remote access started.', 'success');
      }, restart ? {
        title: 'Updating Remote access…',
        copy: 'Applying the changed configuration and restarting the public tunnel.',
      } : {});
    } finally {
      state.operation = undefined;
      renderStatus();
    }
  }

  async function stopRemote() {
    state.operation = 'stopping';
    setBusy(true);
    setDialogLoading(true, {
      title: 'Stopping Remote access…',
      copy: 'Closing the public tunnel. Your selected setup will be kept.',
    });
    showAlert();
    try {
      await api('/api/remote/tunnels/stop', { method: 'POST' });
      await refreshStatus({ devices: dialog.open });
      resetPairingAfterStop();
      showAlert('Remote access stopped. Your setup is ready to start again.', 'success');
    } catch (error) {
      showAlert(errorMessage(error));
      await refreshStatus();
    } finally {
      state.operation = undefined;
      setDialogLoading(false);
      setBusy(false);
    }
  }

  async function checkAvailability() {
    const zone = selectedZone();
    const zoneId = zone?.id;
    const value = subdomain.value.trim().toLowerCase();
    const key = zoneId && value ? `${zoneId}:${value}` : '';
    suggestions.replaceChildren();
    subdomainOptions.replaceChildren();
    if (!key) {
      state.hostnameCheck = undefined;
      availability.removeAttribute('data-state');
      setText(availability, 'Choose a zone and subdomain to check availability.');
      renderPowerButton();
      return undefined;
    }
    state.hostnameCheck = { key, state: 'checking', result: undefined };
    availability.dataset.state = 'checking';
    setText(availability, 'Checking hostname…');
    renderPowerButton();
    try {
      const result = await api(`/api/remote/hostname-availability?zoneId=${encodeURIComponent(zoneId)}&subdomain=${encodeURIComponent(value)}`);
      if (hostnameKey() !== key) return undefined;
      state.hostnameCheck = { key, state: 'ready', result };
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
        suggestionButton.addEventListener('click', () => {
          subdomain.value = label;
          state.hostnameCheck = undefined;
          void checkAvailability();
        });
        suggestions.append(suggestionButton);
      }
      renderStatus();
      return result;
    } catch (error) {
      if (hostnameKey() !== key) return undefined;
      state.hostnameCheck = { key, state: 'error', result: undefined };
      setText(availability, errorMessage(error));
      availability.dataset.state = 'error';
      renderStatus();
      return undefined;
    }
  }

  function queueAvailability() {
    clearTimeout(state.hostnameTimer);
    state.hostnameCheck = undefined;
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
    resetDraftFromStatus();
    state.step = currentTunnel().state === 'running' ? wizardSteps().at(-1) : 1;
    state.managingDevices = false;
    showAlert();
    dialog.showModal();
    dialog.querySelector('[data-remote-close]').focus();
    renderStatus();
    renderWizard();
    if (state.connectionChoice === 'named' && hostnameKey()) void checkAvailability();
  });
  dialog.addEventListener('close', () => {
    if (tokenGuideDialog?.open) tokenGuideDialog.close();
    clearTimeout(state.hostnameTimer);
    resetDraftFromStatus();
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
    state.hostnameCheck = undefined;
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
      if (state.connectionChoice === 'quick' && state.step === 2) state.step = 1;
      renderStatus();
    });
  }
  powerButton.addEventListener('click', () => {
    void (hasRestartRelevantChanges()
      ? startRemote({ restart: true })
      : shouldStopRemote() ? stopRemote() : startRemote());
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
      const steps = wizardSteps();
      const nextStep = steps[steps.indexOf(state.step) + 1];
      if (nextStep) await setStep(nextStep);
    })();
  });
  document.addEventListener('visibilitychange', () => {
    schedulePolling();
    if (document.visibilityState === 'visible') {
      const refresh = state.loading
        ? setupPromise
        : dialog.open ? refreshStatus({ devices: true }) : refreshTunnelStatus();
      void refresh;
    }
  });
  window.addEventListener('agent-remote-resume', () => {
    schedulePolling();
    const refresh = state.loading
      ? setupPromise
      : dialog.open ? refreshStatus({ devices: true }) : refreshTunnelStatus();
    void refresh;
  });
  await setupPromise;
}
