const frameHeaderBytes = 28;

export function browserPointerPosition(canvas, event, remoteViewport) {
  const bounds = canvas.getBoundingClientRect();
  const relativeX = event.clientX - bounds.left;
  const relativeY = event.clientY - bounds.top;
  const viewportWidth = remoteViewport?.width || bounds.width;
  const viewportHeight = remoteViewport?.height || bounds.height;
  return {
    x: Math.max(0, Math.min(viewportWidth, (relativeX / bounds.width) * viewportWidth)),
    y: Math.max(0, Math.min(viewportHeight, (relativeY / bounds.height) * viewportHeight)),
    inside: relativeX >= 0 && relativeY >= 0 && relativeX <= bounds.width && relativeY <= bounds.height,
  };
}

export function parseBrowserFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= frameHeaderBytes) return undefined;
  const view = new DataView(buffer);
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'OTF1') {
    return undefined;
  }
  return {
    sequence: view.getUint32(4),
    viewportGeneration: view.getUint32(8),
    width: view.getUint32(12),
    height: view.getUint32(16),
    pixelWidth: view.getUint32(20),
    pixelHeight: view.getUint32(24),
    data: buffer.slice(frameHeaderBytes),
  };
}

function legacyFrameData(data) {
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

async function decodeFrame(data) {
  const blob = new Blob([data], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); }
    catch {
      // Safari intermittently rejects WebSocket JPEG blobs through this path.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function frameInvalidatesViewport(candidate, displayed) {
  if (!candidate) return false;
  return (Number(candidate.viewportGeneration) || 0) > (Number(displayed.viewportGeneration) || 0);
}

function recordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export function createBrowserMediaController({ setLoading, onFirstFrame }) {
  function updateRecordButton(pane) {
    if (!pane.recordButton) return;
    const recording = pane.recording;
    pane.recordButton.dataset.active = String(Boolean(recording));
    pane.recordButton.setAttribute('aria-pressed', String(Boolean(recording)));
    if (!recording) {
      pane.recordButton.textContent = '● Record';
      pane.recordButton.title = 'Record this browser pane';
      return;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - recording.startedAt) / 1000));
    pane.recordButton.textContent = `■ ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    pane.recordButton.title = 'Stop and download recording';
  }

  function drawRecordingFrame(pane, source) {
    const recording = pane.recording;
    if (!recording) return;
    const width = source.width || source.naturalWidth || pane.frame.width;
    const height = source.height || source.naturalHeight || pane.frame.height;
    if (!width || !height) return;
    if (!recording.canvas.width || !recording.canvas.height) {
      recording.canvas.width = width;
      recording.canvas.height = height;
    }
    recording.context.drawImage(source, 0, 0, recording.canvas.width, recording.canvas.height);
  }

  function queueFrame(pane, incoming) {
    const message = typeof incoming.data === 'string'
      ? { ...incoming, data: legacyFrameData(incoming.data) }
      : incoming;
    const sequence = Number(message.sequence) || 0;
    const viewportGeneration = Number(message.viewportGeneration) || 0;
    if (viewportGeneration < pane.frameViewportGeneration ||
        (sequence && sequence <= pane.displayedFrameSequence)) return;
    pane.pendingFrame = message;
    if (pane.decodingFrame) return;
    pane.decodingFrame = true;
    const decodeNext = async () => {
      while (pane.pendingFrame && !pane.disposed) {
        const next = pane.pendingFrame;
        pane.pendingFrame = undefined;
        let decoded;
        try { decoded = await decodeFrame(next.data); }
        catch {
          pane.frameDecodeFailures += 1;
          if (pane.frameDecodeFailures >= 3) setLoading(pane, 'error', 'This browser could not decode the live frame.');
          else {
            setTimeout(() => {
              if (!pane.disposed && pane.socket?.readyState === WebSocket.OPEN) {
                pane.socket.send(JSON.stringify({ type: 'frame-request' }));
              }
            }, pane.frameDecodeFailures * 150);
          }
          continue;
        }
        pane.frameDecodeFailures = 0;
        if (pane.disposed || frameInvalidatesViewport(pane.pendingFrame, next)) {
          decoded.close?.();
          continue;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (pane.disposed || frameInvalidatesViewport(pane.pendingFrame, next)) {
          decoded.close?.();
          continue;
        }
        const decodedWidth = decoded.width || decoded.naturalWidth;
        const decodedHeight = decoded.height || decoded.naturalHeight;
        const firstFrame = pane.surface.dataset.ready !== 'true';
        if (pane.frame.width !== decodedWidth || pane.frame.height !== decodedHeight) {
          pane.frame.width = decodedWidth;
          pane.frame.height = decodedHeight;
          pane.frameContext.imageSmoothingEnabled = true;
          pane.frameContext.imageSmoothingQuality = 'high';
        }
        pane.frameContext.drawImage(decoded, 0, 0, pane.frame.width, pane.frame.height);
        pane.frameViewport = { width: Number(next.width) || decodedWidth, height: Number(next.height) || decodedHeight };
        pane.frameViewportGeneration = Number(next.viewportGeneration) || pane.frameViewportGeneration;
        pane.host.dataset.frameViewportGeneration = String(pane.frameViewportGeneration);
        pane.displayedFrameSequence = Number(next.sequence) || pane.displayedFrameSequence + 1;
        pane.host.dataset.frameSequence = String(pane.displayedFrameSequence);
        pane.host.dataset.frameViewport = `${pane.frameViewport.width}x${pane.frameViewport.height}`;
        pane.frameVersion += 1;
        pane.host.dataset.frameVersion = String(pane.frameVersion);
        pane.host.dataset.frameScale = String(decodedWidth / pane.frameViewport.width);
        drawRecordingFrame(pane, pane.frame);
        decoded.close?.();
        pane.surface.dataset.ready = 'true';
        pane.surfaceReady = true;
        pane.loading.hidden = true;
        pane.terminalLayer.dataset.surface = 'hidden';
        if (firstFrame) {
          pane.revealed = true;
          onFirstFrame(pane);
        }
      }
      pane.decodingFrame = false;
    };
    void decodeNext();
  }

  function startRecording(pane) {
    if (pane.recording) return;
    const mimeType = recordingMimeType();
    if (!mimeType || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      pane.recordButton.title = 'Recording is not supported by this browser';
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = pane.frame.width || Math.max(1, pane.viewport.clientWidth);
    canvas.height = pane.frame.height || Math.max(1, pane.viewport.clientHeight);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    if (pane.surfaceReady && pane.frame.width) context.drawImage(pane.frame, 0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    const recording = {
      canvas, context, stream, recorder, chunks: [], startedAt: Date.now(), download: true,
      timer: undefined, frameTimer: undefined,
    };
    pane.recording = recording;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      clearInterval(recording.timer);
      clearInterval(recording.frameTimer);
      for (const track of stream.getTracks()) track.stop();
      if (pane.recording === recording) pane.recording = undefined;
      updateRecordButton(pane);
      if (!recording.download || recording.chunks.length === 0) return;
      const blob = new Blob(recording.chunks, { type: mimeType });
      const link = document.createElement('a');
      const safeTitle = (pane.surface.getAttribute('aria-label') || 'browser')
        .replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'browser';
      const stamp = new Date(recording.startedAt).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = `${safeTitle}-${stamp}.webm`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    });
    recorder.start(250);
    recording.timer = setInterval(() => updateRecordButton(pane), 500);
    recording.frameTimer = setInterval(() => {
      if (pane.surfaceReady && pane.frame.width) drawRecordingFrame(pane, pane.frame);
    }, 100);
    updateRecordButton(pane);
  }

  function stopRecording(pane, { download = true } = {}) {
    const recording = pane?.recording;
    if (!recording) return;
    recording.download = download;
    clearInterval(recording.timer);
    clearInterval(recording.frameTimer);
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
  }

  return { queueFrame, startRecording, stopRecording, updateRecordButton };
}
