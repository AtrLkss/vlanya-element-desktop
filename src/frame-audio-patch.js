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
  const WINDOW_AUDIO_RELAY_TYPE = "vlanya-window-audio-relay";
  const MEDIA_SETTINGS_RELAY_TYPE = "vlanya-media-settings-relay";
  const FRAME_ID = `injected-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const RNNOISE_PCM_SCALE = 32768;
  const SCREEN_SHARE_PROFILES = {
    economy: { width: 1280, height: 720 },
    balanced: { width: 1920, height: 1080 },
    sharp: { width: 2560, height: 1440 },
    source: { width: null, height: null },
  };
  const SCREEN_SHARE_FPS_OPTIONS = [15, 30, 60];
  const DEFAULT_MEDIA_SETTINGS = {
    noiseMode: "rnnoise",
    screenShare: {
      profile: "balanced",
      fps: 30,
      width: 1920,
      height: 1080,
    },
  };
  const createWindowAudioRelayBridge = () => {
    let target = null;
    try {
      if (window.top === window) return null;
      target = window.top;
    } catch (_) {
      return null;
    }
    if (!target) return null;

    const pending = new Map();
    const dataHandlers = new Set();
    const stopHandlers = new Set();
    const statusHandlers = new Set();
    let requestCounter = 0;

    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.type !== WINDOW_AUDIO_RELAY_TYPE) return;

      if (data.action === "response" && data.requestId) {
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId);
        clearTimeout(entry.timer);
        entry.resolve(data.result || { ok: false, error: "empty-relay-response" });
        return;
      }

      if (data.action === "data" && data.token) {
        for (const handler of dataHandlers) handler(data.token, data.chunk);
        return;
      }

      if (data.action === "stopped" && data.token) {
        for (const handler of stopHandlers) handler(data.token, data.reason || null);
        return;
      }

      if (data.action === "status" && data.token) {
        for (const handler of statusHandlers) handler(data.token, data.message || "");
      }
    });

    const request = (action, payload = {}) => new Promise((resolve) => {
      const requestId = `${FRAME_ID}-${++requestCounter}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: "relay-timeout" });
      }, 5000);
      pending.set(requestId, { resolve, timer });

      try {
        target.postMessage({
          type: WINDOW_AUDIO_RELAY_TYPE,
          action,
          requestId,
          ...payload,
        }, "*");
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({ ok: false, error: error?.message || "relay-post-failed" });
      }
    });

    return {
      start: () => request("start"),
      stop: (token) => request("stop", { token }),
      onData: (callback) => {
        dataHandlers.add(callback);
        return () => dataHandlers.delete(callback);
      },
      onStop: (callback) => {
        stopHandlers.add(callback);
        return () => stopHandlers.delete(callback);
      },
      onStatus: (callback) => {
        statusHandlers.add(callback);
        return () => statusHandlers.delete(callback);
      },
    };
  };
  const windowAudioIpc = (() => {
    if (window.vlanyaWindowAudio) return window.vlanyaWindowAudio;
    try {
      const ipcRenderer = require("electron")?.ipcRenderer;
      if (!ipcRenderer) return createWindowAudioRelayBridge();
      return {
        start: () => ipcRenderer.invoke("vlanya-window-audio:start"),
        stop: (token) => ipcRenderer.invoke("vlanya-window-audio:stop", token),
        onData: (callback) => {
          const listener = (_event, token, chunk) => callback(token, chunk);
          ipcRenderer.on("vlanya-window-audio:data", listener);
          return () => ipcRenderer.off("vlanya-window-audio:data", listener);
        },
        onStop: (callback) => {
          const listener = (_event, token, reason) => callback(token, reason);
          ipcRenderer.on("vlanya-window-audio:stop", listener);
          return () => ipcRenderer.off("vlanya-window-audio:stop", listener);
        },
        onStatus: (callback) => {
          const listener = (_event, token, message) => callback(token, message);
          ipcRenderer.on("vlanya-window-audio:status", listener);
          return () => ipcRenderer.off("vlanya-window-audio:status", listener);
        },
      };
    } catch (_) {
      return createWindowAudioRelayBridge();
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
  let mediaSettings = { ...DEFAULT_MEDIA_SETTINGS, screenShare: { ...DEFAULT_MEDIA_SETTINGS.screenShare } };
  let mediaSettingsRequestCounter = 0;

  const normalizeMediaSettings = (settings = {}) => {
    const noiseMode = settings.noiseMode === "rnnoise" ? "rnnoise" : "normal";
    const incomingScreenShare = settings.screenShare || {};
    const profile = SCREEN_SHARE_PROFILES[incomingScreenShare.profile]
      ? incomingScreenShare.profile
      : DEFAULT_MEDIA_SETTINGS.screenShare.profile;
    const fps = SCREEN_SHARE_FPS_OPTIONS.includes(Number(incomingScreenShare.fps))
      ? Number(incomingScreenShare.fps)
      : DEFAULT_MEDIA_SETTINGS.screenShare.fps;
    const profileDefinition = SCREEN_SHARE_PROFILES[profile] || SCREEN_SHARE_PROFILES.balanced;

    return {
      noiseMode,
      screenShare: {
        profile,
        fps,
        width: profileDefinition.width,
        height: profileDefinition.height,
      },
    };
  };

  const setMediaSettings = (settings) => {
    mediaSettings = normalizeMediaSettings(settings);
    return mediaSettings;
  };

  const requestMediaSettingsFromTop = (timeoutMs = 450) => {
    if (IS_TOP_FRAME) return Promise.resolve(mediaSettings);

    return new Promise((resolve) => {
      const requestId = `${FRAME_ID}-media-${++mediaSettingsRequestCounter}`;
      const onMessage = (event) => {
        const data = event?.data;
        if (!data || data.type !== MEDIA_SETTINGS_RELAY_TYPE || data.action !== "settings") return;
        if (data.requestId && data.requestId !== requestId) return;
        window.removeEventListener("message", onMessage, true);
        clearTimeout(timer);
        resolve(setMediaSettings(data.settings));
      };
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage, true);
        resolve(mediaSettings);
      }, timeoutMs);

      window.addEventListener("message", onMessage, true);
      try {
        window.top?.postMessage(
          {
            type: MEDIA_SETTINGS_RELAY_TYPE,
            action: "requestSettings",
            requestId,
            frameId: FRAME_ID,
          },
          "*",
        );
      } catch (_) {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage, true);
        resolve(mediaSettings);
      }
    });
  };

  window.addEventListener("message", (event) => {
    const data = event?.data;
    if (!data || data.type !== MEDIA_SETTINGS_RELAY_TYPE || data.action !== "settings") return;
    setMediaSettings(data.settings);
  });

  void requestMediaSettingsFromTop(900);

  const activePeerConnections = new Set();
  const displayAudioByVideoTrack = new WeakMap();
  const displayAudioSendersByPeerConnection = new WeakMap();
  const displayAudioEntriesByPeerConnection = new WeakMap();
  const peerConnectionBySender = new WeakMap();
  const processedTracks = new WeakMap();
  let addDisplayAudioForVideoTrackToPeer = null;
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
    Boolean(
      mediaSettings.noiseMode === "rnnoise" &&
        track &&
        track.kind === "audio" &&
        !track.__vlanyaRnnoiseOnly &&
        !track.__vlanyaDisplayAudio,
    );

  const withAudioProcessing = (constraints = {}) => {
    if (!constraints || typeof constraints !== "object") return constraints;
    if (!("audio" in constraints) || constraints.audio === false) return constraints;
    if (mediaSettings.noiseMode !== "rnnoise") return constraints;
    const audio = constraints.audio && typeof constraints.audio === "object" ? { ...constraints.audio } : {};
    return {
      ...constraints,
      audio: {
        ...audio,
        ...AUDIO_PROCESSING,
      },
    };
  };

  const getScreenShareVideoConstraints = () => {
    const screenShare = mediaSettings.screenShare || DEFAULT_MEDIA_SETTINGS.screenShare;
    const constraints = {
      frameRate: {
        ideal: screenShare.fps,
        max: screenShare.fps,
      },
    };

    if (screenShare.width && screenShare.height) {
      constraints.width = {
        ideal: screenShare.width,
        max: screenShare.width,
      };
      constraints.height = {
        ideal: screenShare.height,
        max: screenShare.height,
      };
      constraints.resizeMode = "crop-and-scale";
    }

    return constraints;
  };

  const withScreenShareVideoSettings = (constraints = {}) => {
    const next = constraints && typeof constraints === "object" ? constraints : {};
    const video = next.video;
    if (video === false) return next;

    return {
      ...next,
      video: {
        ...(video && typeof video === "object" ? video : {}),
        ...getScreenShareVideoConstraints(),
      },
    };
  };

  const applyScreenShareTrackSettings = async (stream) => {
    const constraints = getScreenShareVideoConstraints();
    await Promise.all(
      Array.from(stream?.getVideoTracks?.() || []).map((track) =>
        track.applyConstraints?.(constraints).catch((error) => {
          console.warn("[Vlanya Chat] injected screen share quality constraints were ignored.", error?.message || error);
        }),
      ),
    );
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
    const nativePeerConnectionPrototype = NativePeerConnection?.prototype || null;
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

    const peerConnectionPrototype =
      nativePeerConnectionPrototype || (window.RTCPeerConnection || window.webkitRTCPeerConnection)?.prototype;
    if (peerConnectionPrototype && !peerConnectionPrototype.__vlanyaInjectedSenderPatched) {
      const originalAddTrack = peerConnectionPrototype.addTrack;
      const originalRemoveTrack = peerConnectionPrototype.removeTrack;
      const originalClose = peerConnectionPrototype.close;
      const getDisplayAudioSenderMap = (pc) => {
        let senderMap = displayAudioSendersByPeerConnection.get(pc);
        if (!senderMap) {
          senderMap = new WeakMap();
          displayAudioSendersByPeerConnection.set(pc, senderMap);
        }
        return senderMap;
      };
      const getDisplayAudioEntries = (pc) => {
        let entries = displayAudioEntriesByPeerConnection.get(pc);
        if (!entries) {
          entries = new Set();
          displayAudioEntriesByPeerConnection.set(pc, entries);
        }
        return entries;
      };
      const cleanupDisplayAudioEntry = (pc, entry, reason = "cleanup") => {
        if (!pc || !entry) return;
        const entries = displayAudioEntriesByPeerConnection.get(pc);
        entries?.delete(entry);
        displayAudioSendersByPeerConnection.get(pc)?.delete(entry.audioTrack);

        try {
          pc.removeTrack?.(entry.sender);
        } catch (_) {
          // The sender may already be removed or the peer connection may be closing.
        }
        try {
          entry.sender?.replaceTrack?.(null);
        } catch (_) {
          // Best effort: some senders reject replaceTrack(null) after removeTrack().
        }
        try {
          if (entry.audioTrack?.readyState === "live") entry.audioTrack.stop();
        } catch (_) {
          // The track may already be stopped.
        }
        setState("screen", "WINDOW AUDIO PEER DETACHED", reason);
      };
      const cleanupDisplayAudioForPeer = (pc, videoTrack = null, reason = "cleanup") => {
        const entries = displayAudioEntriesByPeerConnection.get(pc);
        if (!entries) return;
        for (const entry of Array.from(entries)) {
          if (videoTrack && entry.videoTrack !== videoTrack) continue;
          cleanupDisplayAudioEntry(pc, entry, reason);
        }
      };
      const rememberDisplayAudioSender = (pc, track, sender, videoTrack = null) => {
        if (!pc || !track || !sender) return sender;
        getDisplayAudioSenderMap(pc).set(track, sender);
        const entry = { audioTrack: track, sender, videoTrack };
        getDisplayAudioEntries(pc).add(entry);
        peerConnectionBySender.set(sender, pc);
        track.addEventListener("ended", () => cleanupDisplayAudioEntry(pc, entry, "audio track ended"), { once: true });
        if (videoTrack) {
          videoTrack.addEventListener("ended", () => cleanupDisplayAudioEntry(pc, entry, "video track ended"), { once: true });
        }
        return sender;
      };
      const getDisplayAudioSender = (pc, track) => {
        if (!pc || !track) return null;
        return displayAudioSendersByPeerConnection.get(pc)?.get(track) || null;
      };
      const addDisplayAudioForVideoTrack = (pc, videoTrack, streams = []) => {
        if (typeof originalAddTrack !== "function") return null;
        const audioTrack = displayAudioByVideoTrack.get(videoTrack);
        if (!audioTrack || audioTrack.readyState !== "live") return null;
        const existingSender = getDisplayAudioSender(pc, audioTrack);
        if (existingSender) return existingSender;

        try {
          const sender = originalAddTrack.call(pc, audioTrack, ...streams);
          rememberDisplayAudioSender(pc, audioTrack, sender, videoTrack);
          setState("screen", "WINDOW AUDIO PEER ATTACHED", formatTrack(audioTrack));
          return sender;
        } catch (error) {
          setState("raw", "WINDOW AUDIO PEER ATTACH FAILED", error?.message || String(error));
          return null;
        }
      };

      if (typeof originalAddTrack === "function") {
        peerConnectionPrototype.addTrack = function injectedAddTrack(track, ...streams) {
          activePeerConnections.add(this);
          if (track?.__vlanyaDisplayAudio) {
            const existingSender = getDisplayAudioSender(this, track);
            if (existingSender) return existingSender;
            const sender = originalAddTrack.call(this, track, ...streams);
            rememberDisplayAudioSender(this, track, sender);
            return sender;
          }
          if (track?.kind === "video") {
            const sender = originalAddTrack.call(this, track, ...streams);
            peerConnectionBySender.set(sender, this);
            addDisplayAudioForVideoTrack(this, track, streams);
            return sender;
          }
          if (!shouldProcessAudio(track)) return originalAddTrack.call(this, track, ...streams);
          const processedEntry = createStableProcessedTrack(track);
          const sender = originalAddTrack.call(this, processedEntry.track, ...streams);
          peerConnectionBySender.set(sender, this);
          setState("pending", "INJECTED RNNOISE ADDTRACK PROCESSED-FIRST", formatTrack(processedEntry.track));
          processedEntry.ready.then(() => {
            setState("processed", "INJECTED RNNOISE ADDTRACK READY", formatTrack(sender.track || processedEntry.track));
          }).catch((error) => {
            setState("raw", "INJECTED RNNOISE ADDTRACK ERROR", `${formatTrack(processedEntry.track)} / ${error?.message || error}`);
          });
          return sender;
        };
      }

      const originalAddTransceiver = peerConnectionPrototype.addTransceiver;
      if (typeof originalAddTransceiver === "function") {
        peerConnectionPrototype.addTransceiver = function injectedAddTransceiver(trackOrKind, init) {
          activePeerConnections.add(this);
          if (trackOrKind?.__vlanyaDisplayAudio) {
            const existingSender = getDisplayAudioSender(this, trackOrKind);
            if (existingSender) return { sender: existingSender, receiver: null, direction: "sendonly", currentDirection: "sendonly" };
            const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
            if (transceiver?.sender) peerConnectionBySender.set(transceiver.sender, this);
            rememberDisplayAudioSender(this, trackOrKind, transceiver?.sender);
            return transceiver;
          }
          if (trackOrKind?.kind === "video") {
            const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
            if (transceiver?.sender) peerConnectionBySender.set(transceiver.sender, this);
            addDisplayAudioForVideoTrack(this, trackOrKind, []);
            return transceiver;
          }
          if (!shouldProcessAudio(trackOrKind)) {
            const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
            if (transceiver?.sender) peerConnectionBySender.set(transceiver.sender, this);
            return transceiver;
          }
          const processedEntry = createStableProcessedTrack(trackOrKind);
          const transceiver = originalAddTransceiver.call(this, processedEntry.track, init);
          if (transceiver?.sender) peerConnectionBySender.set(transceiver.sender, this);
          setState("pending", "INJECTED RNNOISE TRANSCEIVER PROCESSED-FIRST", formatTrack(processedEntry.track));
          processedEntry.ready.then(() => {
            setState("processed", "INJECTED RNNOISE TRANSCEIVER READY", formatTrack(transceiver?.sender?.track || processedEntry.track));
          }).catch((error) => {
            setState("raw", "INJECTED RNNOISE TRANSCEIVER ERROR", `${formatTrack(processedEntry.track)} / ${error?.message || error}`);
          });
          return transceiver;
        };
      }

      addDisplayAudioForVideoTrackToPeer = addDisplayAudioForVideoTrack;
      if (typeof originalRemoveTrack === "function" && !peerConnectionPrototype.__vlanyaInjectedRemoveTrackPatched) {
        peerConnectionPrototype.removeTrack = function injectedRemoveTrack(sender) {
          activePeerConnections.add(this);
          if (sender?.track?.kind === "video") {
            cleanupDisplayAudioForPeer(this, sender.track, "video sender removed");
          }
          return originalRemoveTrack.call(this, sender);
        };
        Object.defineProperty(peerConnectionPrototype, "__vlanyaInjectedRemoveTrackPatched", { value: true });
      }
      if (typeof originalClose === "function" && !peerConnectionPrototype.__vlanyaInjectedClosePatched) {
        peerConnectionPrototype.close = function injectedClose() {
          cleanupDisplayAudioForPeer(this, null, "peer connection closed");
          return originalClose.call(this);
        };
        Object.defineProperty(peerConnectionPrototype, "__vlanyaInjectedClosePatched", { value: true });
      }
      Object.defineProperty(peerConnectionPrototype, "__vlanyaInjectedSenderPatched", { value: true });
    }

    const Sender = window.RTCRtpSender;
    if (Sender?.prototype && !Sender.prototype.__vlanyaInjectedReplaceTrackPatched) {
      const originalReplaceTrack = Sender.prototype.replaceTrack;
      if (typeof originalReplaceTrack === "function") {
        Sender.prototype.replaceTrack = function injectedReplaceTrack(track) {
          const pc = peerConnectionBySender.get(this);
          const previousTrack = this.track;
          if (previousTrack?.kind === "video" && previousTrack !== track && pc) {
            cleanupDisplayAudioForPeer(pc, previousTrack, track ? "video sender replaced" : "video sender cleared");
          }
          if (track === null && pc) {
            cleanupDisplayAudioForPeer(pc, null, "sender cleared");
          }
          if (track?.kind === "video") {
            if (pc && typeof addDisplayAudioForVideoTrackToPeer === "function") {
              addDisplayAudioForVideoTrackToPeer(pc, track, []);
            } else if (displayAudioByVideoTrack.get(track)) {
              setState("raw", "WINDOW AUDIO PEER UNKNOWN", "replaceTrack video sender has no peer connection");
            }
            return originalReplaceTrack.call(this, track);
          }
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

  const stopAudioWhenDisplayVideoEnds = (stream, audioTrack) => {
    if (!stream || !audioTrack) return;
    const stopIfNoLiveVideo = () => {
      const hasLiveVideo = stream.getVideoTracks?.().some((track) => track.readyState === "live");
      if (hasLiveVideo) return;
      try {
        if (audioTrack.readyState === "live") audioTrack.stop();
      } catch (_) {
        // Track may already be stopped.
      }
    };

    for (const videoTrack of stream.getVideoTracks?.() || []) {
      videoTrack.addEventListener("ended", stopIfNoLiveVideo, { once: true });
    }
    stream.addEventListener?.("removetrack", (event) => {
      if (event.track?.kind === "video") window.setTimeout(stopIfNoLiveVideo, 0);
    });
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
    if (!windowAudioIpc) {
      setState("raw", "WINDOW AUDIO IPC MISSING", "preload bridge is unavailable");
      return null;
    }

    const session = await windowAudioIpc.start().catch((error) => ({
      ok: false,
      error: error?.message || String(error),
    }));
    if (!session?.ok || !session.token) {
      if (session?.error !== "no-pending-window-audio") {
        setState("raw", "WINDOW AUDIO START FAILED", session?.error || "unknown");
      }
      return null;
    }

    const context = createAudioContext(session.sampleRate || 48000);
    if (!context) {
      windowAudioIpc.stop(session.token).catch(() => {});
      return null;
    }

    const destination = context.createMediaStreamDestination();
    const processor = context.createScriptProcessor(2048, 1, 1);
    const driver = context.createConstantSource?.() || null;
    const driverGain = context.createGain?.() || null;
    const queue = [];
    const maxQueuedSamples = Math.max(48000, (session.sampleRate || 48000) * 2);
    let queuedSamples = 0;
    let stopped = false;
    let offData = null;
    let offStop = null;
    let offStatus = null;

    const trimQueue = () => {
      while (queuedSamples > maxQueuedSamples && queue.length > 1) {
        const item = queue.shift();
        queuedSamples -= Math.max(0, item.samples.length - item.offset);
      }
    };

    const onData = (token, chunk) => {
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
      offData?.();
      offStop?.();
      offStatus?.();
      windowAudioIpc.stop(session.token).catch(() => {});
      try {
        driver?.stop();
      } catch (_) {
        // Already stopped.
      }
      try {
        driver?.disconnect();
        driverGain?.disconnect();
      } catch (_) {
        // Already disconnected.
      }
      try {
        processor.disconnect();
      } catch (_) {
        // Already disconnected.
      }
      context.close().catch(() => {});
    };

    const onStop = (token) => {
      if (token !== session.token) return;
      const track = destination.stream.getAudioTracks()[0];
      if (track?.readyState === "live") track.stop();
      cleanup();
    };

    const onStatus = (token, message) => {
      if (token !== session.token || !message) return;
      const nextMessage = String(message);
      if (nextMessage.startsWith("READY")) {
        setState("screen", "WINDOW AUDIO HELPER READY", nextMessage);
      } else if (nextMessage.startsWith("ERR")) {
        setState("raw", "WINDOW AUDIO HELPER ERROR", nextMessage);
      }
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

    offData = windowAudioIpc.onData(onData);
    offStop = windowAudioIpc.onStop(onStop);
    offStatus = windowAudioIpc.onStatus?.(onStatus) || (() => {});

    if (driver && driverGain) {
      driverGain.gain.value = 0;
      driver.connect(driverGain);
      driverGain.connect(processor);
      driver.start();
    }
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
        await requestMediaSettingsFromTop();
        let next = constraints;
        if (!next || typeof next !== "object") next = {};
        const stream = await originalDisplayMedia({
          ...withScreenShareVideoSettings(next),
          audio: true,
        });
        await applyScreenShareTrackSettings(stream);
        if (!stream.getAudioTracks().length) {
          const windowAudioTrack = await createWindowProcessAudioTrack();
          if (windowAudioTrack) {
            stream.addTrack(windowAudioTrack);
            stopAudioWhenDisplayVideoEnds(stream, windowAudioTrack);
            for (const videoTrack of stream.getVideoTracks()) {
              displayAudioByVideoTrack.set(videoTrack, windowAudioTrack);
              videoTrack.addEventListener("ended", () => windowAudioTrack.stop(), { once: true });
            }
          }
        } else {
          const displayAudioTrack = stream.getAudioTracks()[0];
          stopAudioWhenDisplayVideoEnds(stream, displayAudioTrack);
          for (const videoTrack of stream.getVideoTracks()) {
            displayAudioByVideoTrack.set(videoTrack, displayAudioTrack);
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
