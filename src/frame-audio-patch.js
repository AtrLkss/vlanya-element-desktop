(() => {
  const IS_ELEMENT_CALL_FRAME = (() => {
    try {
      return location.hostname === "call.vlanya.ru" || location.pathname.includes("/widgets/element-call/");
    } catch (_) {
      return false;
    }
  })();
  if (!IS_ELEMENT_CALL_FRAME) return;

  if (window.__vlanyaFrameAudioPatch) return;
  Object.defineProperty(window, "__vlanyaFrameAudioPatch", { value: true });

  const ROUTE_TYPE = "vlanya-audio-route-state";
  const FRAME_ID = `injected-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const RNNOISE_PCM_SCALE = 32768;
  const ipcRenderer = (() => {
    try {
      return require("electron")?.ipcRenderer || null;
    } catch (_) {
      return null;
    }
  })();
  const IS_TOP_FRAME = (() => {
    try {
      return window.top === window;
    } catch (_) {
      return false;
    }
  })();
  const FRAME_LABEL = (() => {
    try {
      return `${location.hostname || "local"}${location.pathname || ""}`;
    } catch (_) {
      return "injected-frame";
    }
  })();
  const AUDIO_PROCESSING = {
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };

  const activePeerConnections = new Set();
  const processedTracks = new WeakMap();
  const stats = {
    peerConnections: 0,
    audioSenders: 0,
    processedSenders: 0,
    rawSenders: 0,
    placeholderSenders: 0,
    screenSenders: 0,
  };
  const state = {
    level: "ready",
    status: "INJECTED RNNOISE READY",
    detail: `${FRAME_LABEL} / RNNoise`,
    updatedAt: Date.now(),
  };

  const postState = () => {
    state.updatedAt = Date.now();
    const snapshot = {
      type: ROUTE_TYPE,
      frameId: FRAME_ID,
      frameLabel: FRAME_LABEL,
      isTopFrame: IS_TOP_FRAME,
      state: { ...state },
      stats: { ...stats },
      sentAt: Date.now(),
    };

    try {
      if (IS_TOP_FRAME) {
        window.postMessage(snapshot, "*");
      } else {
        window.top?.postMessage(snapshot, "*");
      }
    } catch (_) {
      // Keep processing even if route telemetry cannot cross frames.
    }
  };

  const setState = (level, status, detail) => {
    state.level = level;
    state.status = status;
    state.detail = detail || "";
    postState();
  };

  const formatTrack = (track) => {
    if (!track) return "no track";
    const label = track.label || "unlabeled";
    const id = track.id ? track.id.slice(0, 8) : "no-id";
    return `${label} / ${id} / ${track.readyState || "unknown"}`;
  };

  const shouldProcessAudio = (track) =>
    Boolean(track && track.kind === "audio" && !track.__vlanyaRnnoiseOnly && !track.__vlanyaDisplayAudio);

  const withAudioProcessing = (constraints = {}) => {
    if (!constraints || typeof constraints !== "object") return constraints;
    if (!("audio" in constraints) || constraints.audio === false) return constraints;
    const audio = constraints.audio && typeof constraints.audio === "object" ? { ...constraints.audio } : {};
    return {
      ...constraints,
      audio: {
        ...audio,
        ...AUDIO_PROCESSING,
      },
    };
  };

  const makeAudioContext = () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      return new AudioContextClass({ latencyHint: "interactive", sampleRate: 48000 });
    } catch (_) {
      return new AudioContextClass({ latencyHint: "interactive" });
    }
  };

  const clampAudioSample = (sample) => Math.max(-1, Math.min(1, sample || 0));

  const makeRnnoiseNode = async (context) => {
    const Rnnoise = window.__vlanyaRnnoiseClass;
    if (typeof Rnnoise !== "function") {
      throw new Error("RNNoise browser bundle is not available");
    }
    const rnnoise = await Rnnoise.load();
    const denoiseState = rnnoise.createDenoiseState();
    const frameSize = rnnoise.frameSize || 480;
    const node = context.createScriptProcessor(1024, 1, 1);
    const inputFrame = new Float32Array(frameSize);
    const outputFrames = [];
    let inputOffset = 0;
    let outputFrame = null;
    let outputOffset = 0;
    let destroyed = false;

    const nextOutputSample = () => {
      if (!outputFrame || outputOffset >= outputFrame.length) {
        outputFrame = outputFrames.shift() || null;
        outputOffset = 0;
      }
      if (!outputFrame) return 0;
      const sample = outputFrame[outputOffset] / RNNOISE_PCM_SCALE;
      outputOffset += 1;
      return clampAudioSample(sample);
    };

    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      for (let i = 0; i < output.length; i += 1) {
        output[i] = nextOutputSample();
        inputFrame[inputOffset] = clampAudioSample(input[i]) * RNNOISE_PCM_SCALE;
        inputOffset += 1;
        if (inputOffset >= frameSize) {
          const frame = new Float32Array(inputFrame);
          denoiseState.processFrame(frame);
          outputFrames.push(frame);
          inputOffset = 0;
        }
      }
    };

    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      denoiseState.destroy();
      node.onaudioprocess = null;
    };

    return { node, processor: { destroy } };
  };

  const createStableProcessedTrack = (track) => {
    if (!shouldProcessAudio(track)) return { track, ready: Promise.resolve(track) };
    const existing = processedTracks.get(track);
    if (existing) return existing;

    const context = makeAudioContext();
    if (!context) {
      setState("raw", "INJECTED RAW MIC: NO AUDIOCONTEXT", formatTrack(track));
      return { track, ready: Promise.resolve(track) };
    }

    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();
    const processed = destination.stream.getAudioTracks()[0];
    if (!processed) {
      context.close().catch(() => undefined);
      setState("raw", "INJECTED RAW MIC: NO PROCESSED TRACK", formatTrack(track));
      return { track, ready: Promise.resolve(track) };
    }

    Object.defineProperty(processed, "__vlanyaRnnoiseOnly", { value: true });
    Object.defineProperty(processed, "__vlanyaInjectedProcessed", { value: true });
    Object.defineProperty(processed, "__vlanyaNoiseSuppressed", { value: true });
    Object.defineProperty(processed, "__vlanyaSourceTrackId", { value: track.id || "" });

    let node = null;
    let processor = null;
    const cleanup = () => {
      try {
        source.disconnect();
        node?.disconnect?.();
        processor?.destroy?.();
      } catch (_) {
        // Ignore disconnect races.
      }
      context.close().catch(() => undefined);
    };
    track.addEventListener("ended", cleanup, { once: true });

    const ready = (async () => {
      try {
        if (context.state === "suspended") {
          await context.resume().catch(() => undefined);
        }

        setState("pending", "INJECTED RNNOISE LOADING BEFORE SEND", formatTrack(track));
        const rnnoise = await makeRnnoiseNode(context);
        node = rnnoise.node;
        processor = rnnoise.processor;
        source.connect(node);
        node.connect(destination);
        setState("processed", "INJECTED RNNOISE MIC READY BEFORE SEND", formatTrack(processed));
        return processed;
      } catch (error) {
        try {
          source.connect(destination);
        } catch (_) {
          // Keep the stable output track even if direct fallback cannot connect.
        }
        setState("raw", "INJECTED RAW MIC: RNNOISE FAILED STABLE FALLBACK", `${formatTrack(track)} / ${error?.message || error}`);
        return processed;
      }
    })();

    const entry = { track: processed, ready };
    processedTracks.set(track, entry);
    return entry;
  };

  const processTrack = async (track) => {
    const entry = createStableProcessedTrack(track);
    await entry.ready;
    return entry.track;
  };

  const replaceSenderTrack = (sender, track, route) => {
    if (!sender || !shouldProcessAudio(track)) return;
    setState("raw", "INJECTED RAW MIC FOUND: REJOIN FOR PROCESSED-FIRST", `${route}: ${formatTrack(track)}`);
  };

  const patchPeerConnection = () => {
    const NativePeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (NativePeerConnection && !NativePeerConnection.__vlanyaInjectedConstructorPatched) {
      const WrappedPeerConnection = function VlanyaInjectedRTCPeerConnection(...args) {
        const pc = new NativePeerConnection(...args);
        activePeerConnections.add(pc);
        setState("ready", "INJECTED PEER CONNECTION", `pc count ${activePeerConnections.size}`);
        return pc;
      };
      Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
      WrappedPeerConnection.prototype = NativePeerConnection.prototype;
      Object.defineProperty(WrappedPeerConnection, "__vlanyaInjectedConstructorPatched", { value: true });
      try {
        window.RTCPeerConnection = WrappedPeerConnection;
        if (window.webkitRTCPeerConnection === NativePeerConnection) {
          window.webkitRTCPeerConnection = WrappedPeerConnection;
        }
      } catch (_) {
        // Continue with prototype patch below.
      }
    }

    const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (PeerConnection?.prototype && !PeerConnection.prototype.__vlanyaInjectedSenderPatched) {
      const originalAddTrack = PeerConnection.prototype.addTrack;
      if (typeof originalAddTrack === "function") {
        PeerConnection.prototype.addTrack = function injectedAddTrack(track, ...streams) {
          activePeerConnections.add(this);
          if (!shouldProcessAudio(track)) return originalAddTrack.call(this, track, ...streams);
          const processedEntry = createStableProcessedTrack(track);
          const sender = originalAddTrack.call(this, processedEntry.track, ...streams);
          setState("pending", "INJECTED RNNOISE ADDTRACK PROCESSED-FIRST", formatTrack(processedEntry.track));
          processedEntry.ready.then(() => {
            setState("processed", "INJECTED RNNOISE ADDTRACK READY", formatTrack(sender.track || processedEntry.track));
          }).catch((error) => {
            setState("raw", "INJECTED RNNOISE ADDTRACK ERROR", `${formatTrack(processedEntry.track)} / ${error?.message || error}`);
          });
          return sender;
        };
      }

      const originalAddTransceiver = PeerConnection.prototype.addTransceiver;
      if (typeof originalAddTransceiver === "function") {
        PeerConnection.prototype.addTransceiver = function injectedAddTransceiver(trackOrKind, init) {
          activePeerConnections.add(this);
          if (!shouldProcessAudio(trackOrKind)) return originalAddTransceiver.call(this, trackOrKind, init);
          const processedEntry = createStableProcessedTrack(trackOrKind);
          const transceiver = originalAddTransceiver.call(this, processedEntry.track, init);
          setState("pending", "INJECTED RNNOISE TRANSCEIVER PROCESSED-FIRST", formatTrack(processedEntry.track));
          processedEntry.ready.then(() => {
            setState("processed", "INJECTED RNNOISE TRANSCEIVER READY", formatTrack(transceiver?.sender?.track || processedEntry.track));
          }).catch((error) => {
            setState("raw", "INJECTED RNNOISE TRANSCEIVER ERROR", `${formatTrack(processedEntry.track)} / ${error?.message || error}`);
          });
          return transceiver;
        };
      }

      Object.defineProperty(PeerConnection.prototype, "__vlanyaInjectedSenderPatched", { value: true });
    }

    const Sender = window.RTCRtpSender;
    if (Sender?.prototype && !Sender.prototype.__vlanyaInjectedReplaceTrackPatched) {
      const originalReplaceTrack = Sender.prototype.replaceTrack;
      if (typeof originalReplaceTrack === "function") {
        Sender.prototype.replaceTrack = function injectedReplaceTrack(track) {
          if (!shouldProcessAudio(track)) return originalReplaceTrack.call(this, track);
          setState("pending", "INJECTED RNNOISE REPLACETRACK", formatTrack(track));
          return processTrack(track).then((processed) =>
            originalReplaceTrack.call(this, processed || track).then((result) => {
              setState(processed === track ? "raw" : "processed", processed === track ? "INJECTED RAW MIC SENT" : "INJECTED RNNOISE MIC SENT", `replaceTrack: ${formatTrack(processed || track)}`);
              return result;
            }),
          );
        };
      }
      Object.defineProperty(Sender.prototype, "__vlanyaInjectedReplaceTrackPatched", { value: true });
    }
  };

  const markDisplayAudioTracks = (stream) => {
    if (!stream?.getAudioTracks) return stream;
    for (const track of stream.getAudioTracks()) {
      if (!track.__vlanyaDisplayAudio) {
        Object.defineProperty(track, "__vlanyaDisplayAudio", { value: true });
      }
    }
    return stream;
  };

  const createAudioContext = (sampleRate) => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
      return new Context({ sampleRate, latencyHint: "interactive" });
    } catch (_) {
      try {
        return new Context({ latencyHint: "interactive" });
      } catch (_) {
        return null;
      }
    }
  };

  const createWindowProcessAudioTrack = async () => {
    if (!ipcRenderer) return null;

    const session = await ipcRenderer.invoke("vlanya-window-audio:start").catch((error) => ({
      ok: false,
      error: error?.message || String(error),
    }));
    if (!session?.ok || !session.token) return null;

    const context = createAudioContext(session.sampleRate || 48000);
    if (!context) {
      ipcRenderer.invoke("vlanya-window-audio:stop", session.token).catch(() => {});
      return null;
    }

    const destination = context.createMediaStreamDestination();
    const processor = context.createScriptProcessor(2048, 0, 1);
    const queue = [];
    const maxQueuedSamples = Math.max(48000, (session.sampleRate || 48000) * 2);
    let queuedSamples = 0;
    let stopped = false;

    const trimQueue = () => {
      while (queuedSamples > maxQueuedSamples && queue.length > 1) {
        const item = queue.shift();
        queuedSamples -= Math.max(0, item.samples.length - item.offset);
      }
    };

    const onData = (_event, token, chunk) => {
      if (token !== session.token || stopped) return;
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (bytes.byteLength < 4) return;
      const usableBytes = bytes.byteLength - (bytes.byteLength % 4);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usableBytes);
      const samples = new Float32Array(copy);
      queue.push({ samples, offset: 0 });
      queuedSamples += samples.length;
      trimQueue();
    };

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      ipcRenderer.off("vlanya-window-audio:data", onData);
      ipcRenderer.off("vlanya-window-audio:stop", onStop);
      ipcRenderer.invoke("vlanya-window-audio:stop", session.token).catch(() => {});
      try {
        processor.disconnect();
      } catch (_) {
        // Already disconnected.
      }
      context.close().catch(() => {});
    };

    const onStop = (_event, token) => {
      if (token !== session.token) return;
      const track = destination.stream.getAudioTracks()[0];
      if (track?.readyState === "live") track.stop();
      cleanup();
    };

    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      let outputOffset = 0;

      while (outputOffset < output.length) {
        const current = queue[0];
        if (!current) {
          output.fill(0, outputOffset);
          break;
        }

        const available = current.samples.length - current.offset;
        const wanted = output.length - outputOffset;
        const count = Math.min(available, wanted);
        output.set(current.samples.subarray(current.offset, current.offset + count), outputOffset);
        current.offset += count;
        outputOffset += count;
        queuedSamples -= count;

        if (current.offset >= current.samples.length) queue.shift();
      }
    };

    ipcRenderer.on("vlanya-window-audio:data", onData);
    ipcRenderer.on("vlanya-window-audio:stop", onStop);

    processor.connect(destination);
    await context.resume().catch(() => {});

    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      cleanup();
      return null;
    }

    Object.defineProperty(track, "__vlanyaDisplayAudio", { value: true });
    Object.defineProperty(track, "__vlanyaWindowProcessAudio", { value: true });

    const originalStop = track.stop.bind(track);
    track.stop = () => {
      cleanup();
      originalStop();
    };

    setState("ready", "WINDOW AUDIO READY", `${session.sourceName || "window"} / process loopback`);
    return track;
  };

  const patchMediaDevices = () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || mediaDevices.__vlanyaInjectedMediaPatched) return;

    const originalUserMedia = mediaDevices.getUserMedia?.bind(mediaDevices);
    if (originalUserMedia) {
      mediaDevices.getUserMedia = async (constraints = {}) => {
        const stream = await originalUserMedia(withAudioProcessing(constraints));
        const wantsAudio = Boolean(
          constraints === undefined ||
          constraints === null ||
          constraints.audio === true ||
          (constraints.audio && typeof constraints.audio === "object"),
        );
        if (!wantsAudio) return stream;
        const processedAudio = await Promise.all(stream.getAudioTracks().map(processTrack));
        return new MediaStream([...stream.getVideoTracks(), ...processedAudio]);
      };
    }

    const originalDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    if (originalDisplayMedia) {
      mediaDevices.getDisplayMedia = async (constraints = {}) => {
        const stream = await originalDisplayMedia(constraints);
        if (!stream.getAudioTracks().length) {
          const windowAudioTrack = await createWindowProcessAudioTrack();
          if (windowAudioTrack) {
            stream.addTrack(windowAudioTrack);
            for (const videoTrack of stream.getVideoTracks()) {
              videoTrack.addEventListener("ended", () => windowAudioTrack.stop(), { once: true });
            }
          }
        }
        return markDisplayAudioTracks(stream);
      };
    }

    Object.defineProperty(mediaDevices, "__vlanyaInjectedMediaPatched", { value: true });
  };

  const scan = () => {
    let peerConnections = 0;
    let audioSenders = 0;
    let processedSenders = 0;
    let rawSenders = 0;
    let placeholderSenders = 0;
    let screenSenders = 0;

    for (const pc of Array.from(activePeerConnections)) {
      const pcState = pc.connectionState || pc.iceConnectionState || "unknown";
      if (pcState === "closed") {
        activePeerConnections.delete(pc);
        continue;
      }
      peerConnections += 1;
      const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
      for (const sender of senders) {
        const track = sender?.track;
        if (!track || track.kind !== "audio") continue;
        if (track.__vlanyaDisplayAudio) {
          screenSenders += 1;
          continue;
        }
        audioSenders += 1;
        if (track.__vlanyaSilentPlaceholder) placeholderSenders += 1;
        if (track.__vlanyaNoiseSuppressed || track.__vlanyaInjectedProcessed || track.__vlanyaRnnoiseOnly) processedSenders += 1;
        if (shouldProcessAudio(track)) {
          rawSenders += 1;
          replaceSenderTrack(sender, track, "scan");
        }
      }
    }

    stats.peerConnections = peerConnections;
    stats.audioSenders = audioSenders;
    stats.processedSenders = processedSenders;
    stats.rawSenders = rawSenders;
    stats.placeholderSenders = placeholderSenders;
    stats.screenSenders = screenSenders;
    postState();
  };

  patchPeerConnection();
  patchMediaDevices();
  window.setInterval(scan, 1000);
  scan();
})();
