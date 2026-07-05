(() => {
  if (window.__vlanyaFrameAudioPatch) return;
  Object.defineProperty(window, "__vlanyaFrameAudioPatch", { value: true });

  const ROUTE_TYPE = "vlanya-audio-route-state";
  const FRAME_ID = `injected-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const DEEPFILTER_LEVEL = 55;
  const DEEPFILTER_WET_GAIN = 0.92;
  const DEEPFILTER_DRY_SAFETY_GAIN = 0.14;
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
    status: "INJECTED DEEPFILTER READY",
    detail: `${FRAME_LABEL} / DeepFilterNet only`,
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
    Boolean(track && track.kind === "audio" && !track.__vlanyaDeepFilterOnly && !track.__vlanyaDisplayAudio);

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

  const makeDeepFilterNode = async (context) => {
    const Core = window.__vlanyaDeepFilterNet3Core;
    if (typeof Core !== "function") {
      throw new Error("DeepFilterNet browser bundle is not available");
    }

    const processor = new Core({
      sampleRate: context.sampleRate || 48000,
      noiseReductionLevel: DEEPFILTER_LEVEL,
    });
    await processor.initialize();
    const node = await processor.createAudioWorkletNode(context);
    processor.setNoiseSuppressionEnabled?.(true);
    processor.setSuppressionLevel?.(DEEPFILTER_LEVEL);
    return { node, processor };
  };

  const connectDeepFilterVoiceMix = (context, source, deepFilterNode, destination) => {
    const wetGain = context.createGain();
    const dryHighPass = context.createBiquadFilter();
    const dryLowPass = context.createBiquadFilter();
    const dryGain = context.createGain();
    const limiter = context.createDynamicsCompressor();

    wetGain.gain.value = DEEPFILTER_WET_GAIN;

    dryHighPass.type = "highpass";
    dryHighPass.frequency.value = 120;
    dryHighPass.Q.value = 0.7;

    dryLowPass.type = "lowpass";
    dryLowPass.frequency.value = 4300;
    dryLowPass.Q.value = 0.55;

    dryGain.gain.value = DEEPFILTER_DRY_SAFETY_GAIN;

    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;

    source.connect(deepFilterNode);
    deepFilterNode.connect(wetGain);
    wetGain.connect(limiter);

    source.connect(dryHighPass);
    dryHighPass.connect(dryLowPass);
    dryLowPass.connect(dryGain);
    dryGain.connect(limiter);

    limiter.connect(destination);

    return () => {
      for (const node of [source, deepFilterNode, wetGain, dryHighPass, dryLowPass, dryGain, limiter]) {
        try {
          node.disconnect();
        } catch (_) {
          // Ignore disconnect races while the iframe is closing.
        }
      }
    };
  };

  const processTrack = async (track) => {
    if (!shouldProcessAudio(track)) return track;
    const existing = processedTracks.get(track);
    if (existing) return existing;

    const promise = (async () => {
      const context = makeAudioContext();
      if (!context) {
        setState("raw", "INJECTED RAW MIC: NO AUDIOCONTEXT", formatTrack(track));
        return track;
      }

      try {
        if (context.state === "suspended") {
          await context.resume().catch(() => undefined);
        }

        setState("pending", "INJECTED DEEPFILTER LOADING", formatTrack(track));
        const source = context.createMediaStreamSource(new MediaStream([track]));
        const destination = context.createMediaStreamDestination();
        const { node, processor } = await makeDeepFilterNode(context);
        const disconnectVoiceMix = connectDeepFilterVoiceMix(context, source, node, destination);

        const processed = destination.stream.getAudioTracks()[0];
        if (!processed) {
          throw new Error("DeepFilterNet output track was not created");
        }

        Object.defineProperty(processed, "__vlanyaDeepFilterOnly", { value: true });
        Object.defineProperty(processed, "__vlanyaInjectedProcessed", { value: true });
        Object.defineProperty(processed, "__vlanyaNoiseSuppressed", { value: true });
        Object.defineProperty(processed, "__vlanyaSourceTrackId", { value: track.id || "" });

        const cleanup = () => {
          try {
            disconnectVoiceMix();
            processor?.destroy?.();
          } catch (_) {
            // Ignore disconnect races.
          }
          context.close().catch(() => undefined);
        };
        track.addEventListener("ended", cleanup, { once: true });

        setState("processed", "INJECTED DEEPFILTER MIC READY", formatTrack(processed));
        return processed;
      } catch (error) {
        setState("raw", "INJECTED RAW MIC: DEEPFILTER FAILED", `${formatTrack(track)} / ${error?.message || error}`);
        await context.close().catch(() => undefined);
        return track;
      }
    })();

    processedTracks.set(track, promise);
    return promise;
  };

  const replaceSenderTrack = (sender, track, route) => {
    if (!sender || !shouldProcessAudio(track)) return;
    setState("pending", "INJECTED RAW MIC FOUND", `${route}: ${formatTrack(track)}`);
    processTrack(track).then((processed) => {
      if (!processed || processed === track) {
        setState("raw", "INJECTED RAW MIC SENT", `${route}: ${formatTrack(track)}`);
        return undefined;
      }
      return sender.replaceTrack(processed).then(() => {
        setState("processed", "INJECTED DEEPFILTER MIC SENT", `${route}: ${formatTrack(processed)}`);
      });
    }).catch((error) => {
      setState("raw", "INJECTED RAW MIC ERROR", `${route}: ${error?.message || error}`);
    });
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
          const sender = originalAddTrack.call(this, track, ...streams);
          setState("pending", "INJECTED DEEPFILTER ADDTRACK RAW UNTIL READY", formatTrack(track));
          processTrack(track).then((processed) => {
            const next = processed || track;
            if (next === track || (sender.track && sender.track !== track)) {
              setState("raw", "INJECTED RAW MIC KEPT", `addTrack: ${formatTrack(sender.track || track)}`);
              return undefined;
            }
            return sender.replaceTrack(next).then(() => {
              setState(next === track ? "raw" : "processed", next === track ? "INJECTED RAW MIC SENT" : "INJECTED DEEPFILTER MIC SENT", `addTrack: ${formatTrack(next)}`);
            });
          }).catch(() => {
            setState("raw", "INJECTED RAW MIC KEPT", `addTrack fallback: ${formatTrack(sender.track || track)}`);
          });
          return sender;
        };
      }

      const originalAddTransceiver = PeerConnection.prototype.addTransceiver;
      if (typeof originalAddTransceiver === "function") {
        PeerConnection.prototype.addTransceiver = function injectedAddTransceiver(trackOrKind, init) {
          activePeerConnections.add(this);
          if (!shouldProcessAudio(trackOrKind)) return originalAddTransceiver.call(this, trackOrKind, init);
          const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
          setState("pending", "INJECTED DEEPFILTER TRANSCEIVER RAW UNTIL READY", formatTrack(trackOrKind));
          processTrack(trackOrKind).then((processed) => {
            const next = processed || trackOrKind;
            if (next === trackOrKind || (transceiver?.sender?.track && transceiver.sender.track !== trackOrKind)) {
              setState("raw", "INJECTED RAW MIC KEPT", `addTransceiver: ${formatTrack(transceiver?.sender?.track || trackOrKind)}`);
              return undefined;
            }
            return transceiver?.sender?.replaceTrack(next).then(() => {
              setState(next === trackOrKind ? "raw" : "processed", next === trackOrKind ? "INJECTED RAW MIC SENT" : "INJECTED DEEPFILTER MIC SENT", `addTransceiver: ${formatTrack(next)}`);
            });
          }).catch(() => {
            setState("raw", "INJECTED RAW MIC KEPT", `addTransceiver fallback: ${formatTrack(transceiver?.sender?.track || trackOrKind)}`);
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
          setState("pending", "INJECTED DEEPFILTER REPLACETRACK", formatTrack(track));
          return processTrack(track).then((processed) =>
            originalReplaceTrack.call(this, processed || track).then((result) => {
              setState(processed === track ? "raw" : "processed", processed === track ? "INJECTED RAW MIC SENT" : "INJECTED DEEPFILTER MIC SENT", `replaceTrack: ${formatTrack(processed || track)}`);
              return result;
            }),
          );
        };
      }
      Object.defineProperty(Sender.prototype, "__vlanyaInjectedReplaceTrackPatched", { value: true });
    }
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
        for (const track of stream.getAudioTracks()) {
          Object.defineProperty(track, "__vlanyaDisplayAudio", { value: true });
        }
        return stream;
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
        if (track.__vlanyaNoiseSuppressed || track.__vlanyaInjectedProcessed || track.__vlanyaDeepFilterOnly) processedSenders += 1;
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
