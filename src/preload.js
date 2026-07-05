(() => {
  const AUDIO_PROCESSING = {
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };

  const NOISE_MODE_KEY = "vlanya.noiseSuppressionMode";
  const DEFAULT_NOISE_MODE = "deepfilter";
  const VALID_NOISE_MODES = new Set(["normal", "extreme", "deepfilter"]);
  const DEEPFILTER_SUPPRESSION_LEVEL = 55;
  const DEEPFILTER_WET_GAIN = 0.92;
  const DEEPFILTER_DRY_SAFETY_GAIN = 0.14;
  const DEEPFILTER_PACKAGE = "deepfilternet3-noise-filter";
  const DEEPFILTER_ASSET_BASE = "https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3";
  const WORKLET_NAME = "vlanya-voice-gate";
  const WORKLET_CODE = `
class VlanyaVoiceGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mode = options.processorOptions?.mode === "normal" ? "normal" : "extreme";
    this.gain = 0;
    this.noiseFloor = this.mode === "extreme" ? 0.009 : 0.012;
    this.hold = 0;
    this.closedFrames = 0;
    this.clickMute = 0;
    this.voiceFrames = 0;
    this.prevSample = 0;
    this.declickSmooth = 0;
    this.declickPrevRaw = 0;
    this.declickPrevOut = 0;
    this.declickHold = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    let sum = 0;
    let peak = 0;
    let count = 0;
    let diffSum = 0;
    let zeroCrossings = 0;
    let previous = this.prevSample;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) {
        const sample = channel[i];
        const abs = Math.abs(sample);
        sum += sample * sample;
        if (abs > peak) peak = abs;
        diffSum += Math.abs(sample - previous);
        if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) zeroCrossings += 1;
        previous = sample;
        count += 1;
      }
    }
    this.prevSample = previous;

    const rms = count ? Math.sqrt(sum / count) : 0;
    const extreme = this.mode === "extreme";
    const openThreshold = Math.max(extreme ? 0.032 : 0.018, this.noiseFloor * (extreme ? 5.2 : 3.0));
    const closeThreshold = Math.max(extreme ? 0.021 : 0.012, this.noiseFloor * (extreme ? 3.3 : 1.8));
    const crest = peak / Math.max(0.000001, rms);
    const roughness = count ? diffSum / count : 0;
    const zeroCrossRate = count ? zeroCrossings / count : 0;
    const clickLike =
      peak > (extreme ? 0.045 : 0.07) &&
      crest > (extreme ? 5.6 : 7.2) &&
      roughness > Math.max(extreme ? 0.010 : 0.016, rms * (extreme ? 1.45 : 1.85)) &&
      zeroCrossRate > (extreme ? 0.055 : 0.075);
    const isolatedImpulse =
      peak > (extreme ? 0.07 : 0.11) &&
      crest > (extreme ? 4.8 : 6.4) &&
      rms < Math.max(extreme ? 0.030 : 0.022, openThreshold * (extreme ? 1.35 : 1.2));
    const transient = clickLike || isolatedImpulse;
    if (transient) {
      this.clickMute = Math.max(this.clickMute, extreme ? 5 : 2);
    }
    const voiceCandidate = !transient && rms > openThreshold;
    if (voiceCandidate) {
      this.voiceFrames = Math.min(32, this.voiceFrames + 1);
    } else {
      this.voiceFrames = 0;
    }
    const sustainedVoice = this.voiceFrames >= (extreme ? 3 : 2);
    const peakBoost = !extreme && !transient && peak > 0.08 && rms > openThreshold * 0.9;
    const speaking = sustainedVoice || peakBoost;

    if (speaking) {
      this.hold = extreme ? 8 : 18;
      this.closedFrames = 0;
    } else if (this.hold > 0) {
      this.hold -= 1;
    } else {
      this.closedFrames += 1;
      this.noiseFloor = (this.noiseFloor * 0.985) + (Math.max(0.0015, rms) * 0.015);
    }

    let targetGain = extreme ? 0.0 : 0.08;
    if (speaking || this.hold > 0) {
      targetGain = 1;
    } else if (!extreme && rms > closeThreshold) {
      targetGain = 0.32;
    }

    if (extreme && (!speaking && this.hold <= 0)) {
      targetGain = 0;
    }

    if (extreme && targetGain === 0) {
      this.gain = 0;
    } else {
      const smoothing = targetGain > this.gain ? (extreme ? 0.55 : 0.22) : (extreme ? 0.35 : 0.055);
      this.gain += (targetGain - this.gain) * smoothing;
    }

    if (extreme && this.gain < 0.006) {
      this.gain = 0;
    }

    let clickGain = 1;
    if (this.clickMute > 0) {
      clickGain = extreme ? 0.035 : 0.16;
      this.clickMute -= 1;
    }

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const source = input[Math.min(channelIndex, input.length - 1)];
      const destination = output[channelIndex];
      if (!source || this.gain === 0) {
        destination.fill(0);
        continue;
      }

      let smooth = this.declickSmooth;
      let previousRaw = this.declickPrevRaw;
      let previousOut = this.declickPrevOut;
      let holdSamples = this.declickHold;
      for (let i = 0; i < destination.length; i += 1) {
        const raw = source[i] * this.gain * clickGain;
        smooth = (smooth * 0.985) + (raw * 0.015);
        const residual = raw - smooth;
        const jump = raw - previousRaw;
        const level = Math.max(extreme ? 0.006 : 0.010, rms * 0.85, Math.abs(smooth) * 1.5);
        const sampleTransient =
          Math.abs(residual) > Math.max(extreme ? 0.020 : 0.036, level * 3.0) &&
          Math.abs(jump) > Math.max(extreme ? 0.018 : 0.032, level * 2.6);
        if (sampleTransient) {
          holdSamples = Math.max(holdSamples, extreme ? 420 : 180);
        }

        let sample = raw;
        if (holdSamples > 0) {
          sample = ((smooth * 0.7) + (previousOut * 0.3)) * (extreme ? 0.14 : 0.42);
          holdSamples -= 1;
        }

        destination[i] = Math.max(-0.98, Math.min(0.98, sample));
        previousRaw = raw;
        previousOut = destination[i];
      }
      this.declickSmooth = smooth;
      this.declickPrevRaw = previousRaw;
      this.declickPrevOut = previousOut;
      this.declickHold = holdSamples;
    }

    return true;
  }
}

registerProcessor("${WORKLET_NAME}", VlanyaVoiceGate);
`;

  const processingContexts = new Set();
  const processedAudioTrackPromises = new WeakMap();
  const activePeerConnections = new Set();
  const AUDIO_ROUTE_INDICATOR_ID = "vlanya-audio-route-indicator";
  const AUDIO_ROUTE_INDICATOR_TITLE_ID = "vlanya-audio-route-indicator-title";
  const AUDIO_ROUTE_INDICATOR_DETAIL_ID = "vlanya-audio-route-indicator-detail";
  const AUDIO_ROUTE_INDICATOR_TIME_ID = "vlanya-audio-route-indicator-time";
  const AUDIO_ROUTE_RELAY_TYPE = "vlanya-audio-route-state";
  const FRAME_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
      return "unknown-frame";
    }
  })();
  const AUDIO_ROUTE_COLORS = {
    ready: { background: "#151a22", border: "#667085", color: "#eef2ff" },
    pending: { background: "#332607", border: "#f5b301", color: "#fff0b8" },
    processed: { background: "#06281b", border: "#2dd36f", color: "#d7ffe8" },
    raw: { background: "#3a0a0a", border: "#ff4545", color: "#ffe0e0" },
    muted: { background: "#111827", border: "#8ea0b8", color: "#e5edf7" },
    screen: { background: "#0b203a", border: "#49a6ff", color: "#d9efff" },
  };
  let audioRouteScanTimer = null;
  let lastAudioRouteLog = "";
  const audioRouteStats = {
    peerConnections: 0,
    audioSenders: 0,
    processedSenders: 0,
    rawSenders: 0,
    placeholderSenders: 0,
    screenSenders: 0,
  };
  const audioRouteState = {
    level: "ready",
    status: "MIC PATCH BOOTING",
    detail: "waiting for Element Call audio sender",
    updatedAt: Date.now(),
  };
  const relayedAudioRoutes = new Map();
  let deepFilterModulePromise = null;
  let audioRouteIndicatorVisible = false;

  const createAudioRouteSnapshot = () => ({
    type: AUDIO_ROUTE_RELAY_TYPE,
    frameId: FRAME_ID,
    frameLabel: FRAME_LABEL,
    isTopFrame: IS_TOP_FRAME,
    state: { ...audioRouteState },
    stats: { ...audioRouteStats },
    sentAt: Date.now(),
  });

  const postAudioRouteSnapshotToTop = () => {
    if (IS_TOP_FRAME) return;
    try {
      window.top?.postMessage(createAudioRouteSnapshot(), "*");
    } catch (_) {
      // Cross-origin frames can still fail in unusual embed states; local frame indicator remains available.
    }
  };

  const routeScore = (snapshot) => {
    const state = snapshot?.state || {};
    const stats = snapshot?.stats || {};
    if (state.level === "raw" || stats.rawSenders > 0) return 1000;
    if (state.level === "processed" || stats.processedSenders > 0) return 900;
    if (state.level === "pending" || stats.placeholderSenders > 0) return 800;
    if (stats.audioSenders > 0) return 700;
    if (stats.peerConnections > 0) return 600;
    if (state.level === "screen" || stats.screenSenders > 0) return 500;
    if (state.level === "muted") return 400;
    return snapshot?.isTopFrame ? 100 : 200;
  };

  const getDisplayAudioRouteSnapshot = () => {
    const now = Date.now();
    const own = createAudioRouteSnapshot();
    const candidates = [own];

    for (const [frameId, snapshot] of Array.from(relayedAudioRoutes.entries())) {
      if (now - (snapshot.sentAt || 0) > 5000) {
        relayedAudioRoutes.delete(frameId);
        continue;
      }
      candidates.push(snapshot);
    }

    return candidates.sort((a, b) => routeScore(b) - routeScore(a))[0] || own;
  };

  const installAudioRouteRelayListener = () => {
    if (!IS_TOP_FRAME || window.__vlanyaAudioRouteRelayInstalled) return;
    Object.defineProperty(window, "__vlanyaAudioRouteRelayInstalled", { value: true });

    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.type !== AUDIO_ROUTE_RELAY_TYPE || !data.frameId || data.frameId === FRAME_ID) return;
      relayedAudioRoutes.set(data.frameId, {
        frameId: data.frameId,
        frameLabel: data.frameLabel || "child-frame",
        isTopFrame: false,
        state: data.state || {},
        stats: data.stats || {},
        sentAt: data.sentAt || Date.now(),
      });
      renderAudioRouteIndicator();
    });
  };

  const formatTrackInfo = (track) => {
    if (!track) return "no track";
    const label = track.label || "unlabeled";
    const id = track.id ? track.id.slice(0, 8) : "no-id";
    return `${label} / ${id} / ${track.readyState || "unknown"}`;
  };

  const ensureAudioRouteIndicator = () => {
    try {
      if (!document?.documentElement) return null;
      if (!audioRouteIndicatorVisible) {
        document.getElementById(AUDIO_ROUTE_INDICATOR_ID)?.remove();
        return null;
      }

      let root = document.getElementById(AUDIO_ROUTE_INDICATOR_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = AUDIO_ROUTE_INDICATOR_ID;
        root.setAttribute("role", "status");
        root.setAttribute("aria-live", "polite");
        root.innerHTML = `
          <div id="${AUDIO_ROUTE_INDICATOR_TITLE_ID}"></div>
          <div id="${AUDIO_ROUTE_INDICATOR_DETAIL_ID}"></div>
          <div id="${AUDIO_ROUTE_INDICATOR_TIME_ID}"></div>
        `;
        Object.assign(root.style, {
          position: "fixed",
          right: "14px",
          bottom: "14px",
          zIndex: "2147483647",
          minWidth: "260px",
          maxWidth: "420px",
          padding: "10px 12px",
          border: "2px solid #667085",
          borderRadius: "8px",
          background: "#151a22",
          color: "#eef2ff",
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          fontFamily: "Inter, Segoe UI, Arial, sans-serif",
          fontSize: "12px",
          lineHeight: "1.35",
          pointerEvents: "none",
          userSelect: "none",
        });

        const parent = document.body || document.documentElement;
        parent.appendChild(root);
      }

      const title = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_TITLE_ID}`);
      const detail = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_DETAIL_ID}`);
      const time = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_TIME_ID}`);
      if (title) {
        Object.assign(title.style, {
          fontSize: "13px",
          fontWeight: "800",
          letterSpacing: "0",
          marginBottom: "4px",
          textTransform: "uppercase",
        });
      }
      if (detail) {
        Object.assign(detail.style, {
          opacity: "0.96",
          overflowWrap: "anywhere",
        });
      }
      if (time) {
        Object.assign(time.style, {
          marginTop: "4px",
          opacity: "0.72",
          fontSize: "11px",
        });
      }

      return root;
    } catch (_) {
      return null;
    }
  };

  const renderAudioRouteIndicator = () => {
    postAudioRouteSnapshotToTop();
    if (!IS_TOP_FRAME) return;
    if (!audioRouteIndicatorVisible) {
      document.getElementById(AUDIO_ROUTE_INDICATOR_ID)?.remove();
      return;
    }

    const displaySnapshot = getDisplayAudioRouteSnapshot();
    const displayState = displaySnapshot.state || audioRouteState;
    const displayStats = displaySnapshot.stats || audioRouteStats;
    const root = ensureAudioRouteIndicator();
    if (!root) return;

    const colors = AUDIO_ROUTE_COLORS[displayState.level] || AUDIO_ROUTE_COLORS.ready;
    root.style.background = colors.background;
    root.style.borderColor = colors.border;
    root.style.color = colors.color;

    const title = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_TITLE_ID}`);
    const detail = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_DETAIL_ID}`);
    const time = root.querySelector(`#${AUDIO_ROUTE_INDICATOR_TIME_ID}`);
    const frameSuffix = displaySnapshot.isTopFrame ? "" : ` [${displaySnapshot.frameLabel}]`;
    if (title) title.textContent = `${displayState.status || "MIC PATCH READY"}${frameSuffix}`;
    if (detail) detail.textContent = displayState.detail || "";
    if (time) {
      const date = new Date(displayState.updatedAt || displaySnapshot.sentAt || Date.now());
      time.textContent =
        `route check ${date.toLocaleTimeString()} | ` +
        `pc ${displayStats.peerConnections || 0} / mic ${displayStats.audioSenders || 0} / ` +
        `ok ${displayStats.processedSenders || 0} / raw ${displayStats.rawSenders || 0}`;
    }
  };

  const updateAudioRouteIndicator = (level, status, detail) => {
    const nextLevel = AUDIO_ROUTE_COLORS[level] ? level : "ready";
    const nextStatus = status || audioRouteState.status;
    const nextDetail = detail || "";
    const logKey = `${nextLevel}|${nextStatus}|${nextDetail}`;

    audioRouteState.level = nextLevel;
    audioRouteState.status = nextStatus;
    audioRouteState.detail = nextDetail;
    audioRouteState.updatedAt = Date.now();

    if (logKey !== lastAudioRouteLog) {
      lastAudioRouteLog = logKey;
      const message = `[Vlanya Element][audio-route] ${nextStatus}: ${nextDetail}`;
      if (nextLevel === "raw") {
        console.error(message);
      } else if (nextLevel === "pending") {
        console.warn(message);
      } else {
        console.info(message);
      }
    }

    renderAudioRouteIndicator();
  };

  const reportOutgoingAudioTrack = (route, track) => {
    if (!track || track.kind !== "audio") return;
    if (track.__vlanyaDisplayAudio) {
      updateAudioRouteIndicator("screen", "SCREEN AUDIO PASSTHROUGH", `${route}: ${formatTrackInfo(track)}`);
      return;
    }
    if (track.__vlanyaSilentPlaceholder) {
      updateAudioRouteIndicator("pending", "MIC PENDING: SENDING SILENCE", `${route}: ${formatTrackInfo(track)}`);
      return;
    }
    if (track.__vlanyaNoiseSuppressed) {
      updateAudioRouteIndicator("processed", "PROCESSED MIC SENT", `${route}: ${formatTrackInfo(track)}`);
      return;
    }
    updateAudioRouteIndicator("raw", "RAW MIC SENT", `${route}: ${formatTrackInfo(track)}`);
  };

  const importDeepFilterModule = () => {
    if (deepFilterModulePromise) return deepFilterModulePromise;

    deepFilterModulePromise = (async () => {
      if (typeof require === "function") {
        try {
          const path = require("node:path");
          const { pathToFileURL } = require("node:url");
          const commonJsEntry = require.resolve(DEEPFILTER_PACKAGE);
          const esmEntry = path.join(path.dirname(commonJsEntry), "index.esm.js");
          return import(pathToFileURL(esmEntry).href);
        } catch (error) {
          console.warn("[Vlanya Element] DeepFilterNet local module lookup failed, trying browser import.", error);
        }
      }

      return import(DEEPFILTER_PACKAGE);
    })();

    return deepFilterModulePromise;
  };

  const fetchDeepFilterAssetWithNode = (url, redirectCount = 0) =>
    new Promise((resolve, reject) => {
      if (typeof require !== "function") {
        reject(new Error("Node asset loader is not available"));
        return;
      }

      const http = require("node:http");
      const https = require("node:https");
      const { Buffer } = require("node:buffer");
      const client = url.startsWith("http:") ? http : https;
      const request = client.get(
        url,
        {
          headers: {
            "User-Agent": "Vlanya-Element-DeepFilterNet/0.1",
          },
        },
        (response) => {
          const status = response.statusCode || 0;
          const redirectUrl = response.headers.location;
          if (status >= 300 && status < 400 && redirectUrl) {
            response.resume();
            if (redirectCount >= 5) {
              reject(new Error(`Too many redirects while loading ${url}`));
              return;
            }
            const nextUrl = new URL(redirectUrl, url).toString();
            fetchDeepFilterAssetWithNode(nextUrl, redirectCount + 1).then(resolve, reject);
            return;
          }

          if (status < 200 || status >= 300) {
            response.resume();
            reject(new Error(`DeepFilterNet asset request failed with HTTP ${status}`));
            return;
          }

          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
          });
        },
      );

      request.setTimeout(45000, () => {
        request.destroy(new Error(`Timed out loading ${url}`));
      });
      request.on("error", reject);
    });

  const createDeepFilterAssetLoader = () => {
    if (typeof require !== "function") return null;

    return {
      getAssetUrls: () => ({
        wasm: `${DEEPFILTER_ASSET_BASE}/v3/pkg/df_bg.wasm`,
        model: `${DEEPFILTER_ASSET_BASE}/v3/models/DeepFilterNet3_onnx.tar.gz`,
      }),
      fetchAsset: fetchDeepFilterAssetWithNode,
    };
  };

  const makeDeepFilterNode = async (context) => {
    const module = await importDeepFilterModule();
    const Core = module?.DeepFilterNet3Core;
    if (typeof Core !== "function") {
      throw new Error("DeepFilterNet3Core export was not found");
    }

    const processor = new Core({
      sampleRate: context.sampleRate || 48000,
      noiseReductionLevel: DEEPFILTER_SUPPRESSION_LEVEL,
    });
    const nodeAssetLoader = createDeepFilterAssetLoader();
    if (nodeAssetLoader) {
      processor.assetLoader = nodeAssetLoader;
    }

    await processor.initialize();
    const node = await processor.createAudioWorkletNode(context);
    processor.setNoiseSuppressionEnabled?.(true);
    processor.setSuppressionLevel?.(DEEPFILTER_SUPPRESSION_LEVEL);

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
          // Ignore disconnect races when tracks end while the call is closing.
        }
      }
    };
  };

  const getNoiseMode = () => {
    try {
      const storedMode = window.localStorage?.getItem(NOISE_MODE_KEY);
      return VALID_NOISE_MODES.has(storedMode) ? storedMode : DEFAULT_NOISE_MODE;
    } catch (_) {
      return DEFAULT_NOISE_MODE;
    }
  };

  const setNoiseMode = (mode) => {
    const nextMode = VALID_NOISE_MODES.has(mode) ? mode : DEFAULT_NOISE_MODE;
    try {
      window.localStorage?.setItem(NOISE_MODE_KEY, nextMode);
    } catch (_) {
      // Ignore storage failures; the current page can still use the default mode.
    }
    console.info(`[Vlanya Element] microphone noise suppression mode set to "${nextMode}". Rejoin the call to recapture the microphone.`);
    return nextMode;
  };

  const exposeNoiseControls = () => {
    if (window.vlanyaNoiseSuppression) return;
    Object.defineProperty(window, "vlanyaNoiseSuppression", {
      value: {
        getMode: getNoiseMode,
        setMode: setNoiseMode,
        setExtreme: (enabled = true) => setNoiseMode(enabled ? "extreme" : "normal"),
        isExtreme: () => getNoiseMode() === "extreme",
        setDeepFilterNet: (enabled = true) => setNoiseMode(enabled ? "deepfilter" : "extreme"),
        isDeepFilterNet: () => getNoiseMode() === "deepfilter",
        getRouteState: () => ({ ...audioRouteState }),
        showRouteIndicator: () => {
          audioRouteIndicatorVisible = true;
          renderAudioRouteIndicator();
          return { ...audioRouteState };
        },
        hideRouteIndicator: () => {
          audioRouteIndicatorVisible = false;
          document.getElementById(AUDIO_ROUTE_INDICATOR_ID)?.remove();
          return { ...audioRouteState };
        },
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  };

  const withAudioProcessing = (constraints = {}) => {
    if (!constraints || typeof constraints !== "object") return constraints;
    if (!("audio" in constraints) || constraints.audio === false) return constraints;

    const audio =
      constraints.audio && typeof constraints.audio === "object"
        ? { ...constraints.audio }
        : {};

    return {
      ...constraints,
      audio: {
        ...audio,
        ...AUDIO_PROCESSING,
      },
    };
  };

  const makeWorkletNode = async (context, mode) => {
    if (!context.audioWorklet) return null;

    const blob = new Blob([WORKLET_CODE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(url);
      return new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { mode },
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const makeScriptProcessorGate = (context, mode) => {
    const node = context.createScriptProcessor(1024, 1, 1);
    const extreme = mode === "extreme";
    let gain = 0;
    let noiseFloor = extreme ? 0.009 : 0.012;
    let hold = 0;
    let closedFrames = 0;
    let clickMute = 0;
    let voiceFrames = 0;
    let prevSample = 0;
    let declickSmooth = 0;
    let declickPrevRaw = 0;
    let declickPrevOut = 0;
    let declickHold = 0;

    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let sum = 0;
      let peak = 0;
      let diffSum = 0;
      let zeroCrossings = 0;
      let previous = prevSample;

      for (let i = 0; i < input.length; i += 1) {
        const sample = input[i];
        const abs = Math.abs(sample);
        sum += sample * sample;
        if (abs > peak) peak = abs;
        diffSum += Math.abs(sample - previous);
        if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) zeroCrossings += 1;
        previous = sample;
      }
      prevSample = previous;

      const rms = Math.sqrt(sum / input.length);
      const openThreshold = Math.max(extreme ? 0.032 : 0.018, noiseFloor * (extreme ? 5.2 : 3.0));
      const closeThreshold = Math.max(extreme ? 0.021 : 0.012, noiseFloor * (extreme ? 3.3 : 1.8));
      const crest = peak / Math.max(0.000001, rms);
      const roughness = diffSum / input.length;
      const zeroCrossRate = zeroCrossings / input.length;
      const clickLike =
        peak > (extreme ? 0.045 : 0.07) &&
        crest > (extreme ? 5.6 : 7.2) &&
        roughness > Math.max(extreme ? 0.010 : 0.016, rms * (extreme ? 1.45 : 1.85)) &&
        zeroCrossRate > (extreme ? 0.055 : 0.075);
      const isolatedImpulse =
        peak > (extreme ? 0.07 : 0.11) &&
        crest > (extreme ? 4.8 : 6.4) &&
        rms < Math.max(extreme ? 0.030 : 0.022, openThreshold * (extreme ? 1.35 : 1.2));
      const transient = clickLike || isolatedImpulse;
      if (transient) clickMute = Math.max(clickMute, extreme ? 1 : 1);
      const voiceCandidate = !transient && rms > openThreshold;
      if (voiceCandidate) {
        voiceFrames = Math.min(32, voiceFrames + 1);
      } else {
        voiceFrames = 0;
      }
      const sustainedVoice = voiceFrames >= (extreme ? 2 : 2);
      const peakBoost = !extreme && !transient && peak > 0.08 && rms > openThreshold * 0.9;
      const speaking = sustainedVoice || peakBoost;

      if (speaking) {
        hold = extreme ? 8 : 18;
        closedFrames = 0;
      } else if (hold > 0) {
        hold -= 1;
      } else {
        closedFrames += 1;
        noiseFloor = (noiseFloor * 0.985) + (Math.max(0.0015, rms) * 0.015);
      }

      let targetGain = extreme ? 0.0 : 0.08;
      if (speaking || hold > 0) {
        targetGain = 1;
      } else if (!extreme && rms > closeThreshold) {
        targetGain = 0.32;
      }
      if (extreme && (!speaking && hold <= 0)) targetGain = 0;

      if (extreme && targetGain === 0) {
        gain = 0;
      } else {
        const smoothing = targetGain > gain ? (extreme ? 0.55 : 0.22) : (extreme ? 0.35 : 0.055);
        gain += (targetGain - gain) * smoothing;
      }
      if (extreme && gain < 0.006) gain = 0;

      if (gain === 0) {
        output.fill(0);
        return;
      }

      let clickGain = 1;
      if (clickMute > 0) {
        clickGain = extreme ? 0.035 : 0.16;
        clickMute -= 1;
      }

      for (let i = 0; i < input.length; i += 1) {
        const raw = input[i] * gain * clickGain;
        declickSmooth = (declickSmooth * 0.985) + (raw * 0.015);
        const residual = raw - declickSmooth;
        const jump = raw - declickPrevRaw;
        const level = Math.max(extreme ? 0.006 : 0.010, rms * 0.85, Math.abs(declickSmooth) * 1.5);
        const sampleTransient =
          Math.abs(residual) > Math.max(extreme ? 0.020 : 0.036, level * 3.0) &&
          Math.abs(jump) > Math.max(extreme ? 0.018 : 0.032, level * 2.6);
        if (sampleTransient) {
          declickHold = Math.max(declickHold, extreme ? 420 : 180);
        }

        let sample = raw;
        if (declickHold > 0) {
          sample = ((declickSmooth * 0.7) + (declickPrevOut * 0.3)) * (extreme ? 0.14 : 0.42);
          declickHold -= 1;
        }

        output[i] = Math.max(-0.98, Math.min(0.98, sample));
        declickPrevRaw = raw;
        declickPrevOut = output[i];
      }
    };

    return node;
  };

  const createVoiceOnlyFilters = (context, mode) => {
    const extreme = mode === "extreme";
    const highPass = context.createBiquadFilter();
    const lowPass = context.createBiquadFilter();
    const presence = context.createBiquadFilter();
    const deMud = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();

    highPass.type = "highpass";
    highPass.frequency.value = extreme ? 165 : 95;
    highPass.Q.value = extreme ? 0.95 : 0.7;

    lowPass.type = "lowpass";
    lowPass.frequency.value = extreme ? 3400 : 9800;
    lowPass.Q.value = extreme ? 0.65 : 0.45;

    presence.type = "peaking";
    presence.frequency.value = 2550;
    presence.Q.value = 1.05;
    presence.gain.value = extreme ? 1.2 : 1.5;

    deMud.type = "peaking";
    deMud.frequency.value = 320;
    deMud.Q.value = 1.1;
    deMud.gain.value = extreme ? -5.5 : -1.5;

    compressor.threshold.value = extreme ? -34 : -28;
    compressor.knee.value = extreme ? 9 : 18;
    compressor.ratio.value = extreme ? 5.5 : 2.6;
    compressor.attack.value = extreme ? 0.002 : 0.004;
    compressor.release.value = extreme ? 0.09 : 0.16;

    return { highPass, lowPass, presence, deMud, compressor };
  };

  const makeAudioContext = () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      return new AudioContextClass({
        latencyHint: "interactive",
        sampleRate: 48000,
      });
    } catch (_) {
      return new AudioContextClass({
        latencyHint: "interactive",
      });
    }
  };

  const processMicrophoneTrack = async (track) => {
    if (track.__vlanyaNoiseSuppressed || track.__vlanyaDisplayAudio) return track;

    const context = makeAudioContext();
    if (!context) {
      updateAudioRouteIndicator("raw", "RAW MIC: NO AUDIOCONTEXT", formatTrackInfo(track));
      return track;
    }

    try {
      updateAudioRouteIndicator("pending", "DEEPFILTER MIC PROCESSING STARTED", formatTrackInfo(track));
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }

      const inputStream = new MediaStream([track]);
      const source = context.createMediaStreamSource(inputStream);
      const destination = context.createMediaStreamDestination();
      const deepFilter = await makeDeepFilterNode(context);
      const deepFilterNode = deepFilter.node;
      const deepFilterProcessor = deepFilter.processor;
      const disconnectVoiceMix = connectDeepFilterVoiceMix(context, source, deepFilterNode, destination);

      console.info("[Vlanya Element] DeepFilterNet microphone processor is active with dry voice safety mix.");

      const processedTrack = destination.stream.getAudioTracks()[0];
      if (!processedTrack) throw new Error("DeepFilterNet microphone track was not created");

      Object.defineProperty(processedTrack, "__vlanyaNoiseSuppressed", { value: true });
      Object.defineProperty(processedTrack, "__vlanyaDeepFilterOnly", { value: true });
      Object.defineProperty(processedTrack, "__vlanyaNoiseMode", { value: "deepfilter" });
      Object.defineProperty(processedTrack, "__vlanyaSourceTrackId", { value: track.id || "" });
      processingContexts.add(context);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        processingContexts.delete(context);
        disconnectVoiceMix();
        deepFilterProcessor?.destroy?.();
        context.close().catch(() => undefined);
      };

      const originalStop = processedTrack.stop.bind(processedTrack);
      processedTrack.stop = () => {
        if (track.readyState !== "ended") track.stop();
        originalStop();
        cleanup();
      };

      track.addEventListener(
        "ended",
        () => {
          if (processedTrack.readyState !== "ended") originalStop();
          cleanup();
        },
        { once: true },
      );

      console.info("[Vlanya Element] microphone track is processed by DeepFilterNet with dry voice safety mix.");
      updateAudioRouteIndicator("processed", "DEEPFILTER MIC READY", formatTrackInfo(processedTrack));
      return processedTrack;
    } catch (error) {
      console.warn("[Vlanya Element] DeepFilterNet processing failed, using original microphone track.", error);
      updateAudioRouteIndicator("raw", "RAW MIC: DEEPFILTER FAILED", `${formatTrackInfo(track)} / ${error?.message || error}`);
      await context.close().catch(() => undefined);
      return track;
    }
  };

  const getProcessedAudioTrack = (track) => {
    if (!track || track.kind !== "audio" || track.__vlanyaNoiseSuppressed || track.__vlanyaDisplayAudio) {
      return Promise.resolve(track);
    }

    const existingPromise = processedAudioTrackPromises.get(track);
    if (existingPromise) return existingPromise;

    updateAudioRouteIndicator("pending", "MIC PROCESSING QUEUED", formatTrackInfo(track));
    const promise = processMicrophoneTrack(track).catch((error) => {
      console.warn("[Vlanya Element] outgoing audio track processing failed, using original track.", error);
      updateAudioRouteIndicator("raw", "RAW MIC: PROCESSING PROMISE FAILED", `${formatTrackInfo(track)} / ${error?.message || error}`);
      return track;
    });
    processedAudioTrackPromises.set(track, promise);
    return promise;
  };

  const processMicrophoneStream = async (stream) => {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return stream;

    const processedAudioTracks = await Promise.all(audioTracks.map(getProcessedAudioTrack));
    return new MediaStream([
      ...stream.getVideoTracks(),
      ...processedAudioTracks,
    ]);
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

  const shouldProcessOutgoingAudioTrack = (track) =>
    Boolean(track && track.kind === "audio" && !track.__vlanyaNoiseSuppressed && !track.__vlanyaDisplayAudio);

  const scanOutgoingAudioRoutes = () => {
    let sawMicrophoneSender = false;
    let peerConnections = 0;
    let audioSenders = 0;
    let processedSenders = 0;
    let rawSenders = 0;
    let placeholderSenders = 0;
    let screenSenders = 0;

    for (const pc of Array.from(activePeerConnections)) {
      const state = pc.connectionState || pc.iceConnectionState || "unknown";
      if (state === "closed") {
        activePeerConnections.delete(pc);
        continue;
      }
      peerConnections += 1;

      let senders = [];
      try {
        senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
      } catch (_) {
        continue;
      }

      for (const sender of senders) {
        const track = sender?.track;
        if (!track || track.kind !== "audio") continue;
        if (track.__vlanyaDisplayAudio) {
          screenSenders += 1;
          reportOutgoingAudioTrack("scan sender", track);
          continue;
        }
        audioSenders += 1;
        sawMicrophoneSender = true;
        if (track.__vlanyaNoiseSuppressed) processedSenders += 1;
        if (track.__vlanyaSilentPlaceholder) placeholderSenders += 1;
        if (shouldProcessOutgoingAudioTrack(track)) rawSenders += 1;
        reportOutgoingAudioTrack("scan sender", track);
        if (shouldProcessOutgoingAudioTrack(track)) {
          maybeReplaceSenderTrack(sender, track);
        }
      }
    }

    audioRouteStats.peerConnections = peerConnections;
    audioRouteStats.audioSenders = audioSenders;
    audioRouteStats.processedSenders = processedSenders;
    audioRouteStats.rawSenders = rawSenders;
    audioRouteStats.placeholderSenders = placeholderSenders;
    audioRouteStats.screenSenders = screenSenders;

    if (!sawMicrophoneSender && activePeerConnections.size > 0) {
      updateAudioRouteIndicator("muted", "NO MIC SENDER FOUND", "peer connection exists, no outgoing microphone track");
      return;
    }

    audioRouteState.updatedAt = Date.now();
    renderAudioRouteIndicator();
  };

  const startAudioRouteScan = () => {
    if (audioRouteScanTimer) return;
    audioRouteScanTimer = window.setInterval(scanOutgoingAudioRoutes, 1000);
    scanOutgoingAudioRoutes();
  };

  const maybeReplaceSenderTrack = (sender, track) => {
    if (!sender || !shouldProcessOutgoingAudioTrack(track)) return;

    updateAudioRouteIndicator("pending", "RAW MIC FOUND: REPLACING", formatTrackInfo(track));
    getProcessedAudioTrack(track).then((processedTrack) => {
      if (!processedTrack || processedTrack === track) {
        reportOutgoingAudioTrack("replace skipped", track);
        return;
      }
      if (sender.track && sender.track !== track) {
        reportOutgoingAudioTrack("replace skipped: sender changed", sender.track);
        return;
      }
      sender.replaceTrack(processedTrack).then(() => {
        reportOutgoingAudioTrack("forced sender replace", processedTrack);
      }).catch((error) => {
        console.warn("[Vlanya Element] failed to replace outgoing audio track with processed track.", error);
        updateAudioRouteIndicator("raw", "RAW MIC: REPLACE FAILED", `${formatTrackInfo(track)} / ${error?.message || error}`);
      });
    });
  };

  const patchPeerConnectionAudioSenders = () => {
    const NativePeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (NativePeerConnection && !NativePeerConnection.__vlanyaConstructorPatched) {
      const WrappedPeerConnection = function VlanyaPatchedRTCPeerConnection(...args) {
        const pc = new NativePeerConnection(...args);
        activePeerConnections.add(pc);
        updateAudioRouteIndicator("ready", "PEER CONNECTION CAPTURED", `pc count ${activePeerConnections.size}`);
        return pc;
      };

      Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
      WrappedPeerConnection.prototype = NativePeerConnection.prototype;
      Object.defineProperty(WrappedPeerConnection, "__vlanyaConstructorPatched", { value: true });

      try {
        window.RTCPeerConnection = WrappedPeerConnection;
        if (window.webkitRTCPeerConnection === NativePeerConnection) {
          window.webkitRTCPeerConnection = WrappedPeerConnection;
        }
      } catch (error) {
        console.warn("[Vlanya Element] failed to patch RTCPeerConnection constructor.", error);
      }
    }

    const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (PeerConnection?.prototype && !PeerConnection.prototype.__vlanyaAudioSenderPatched) {
      const originalAddTrack = PeerConnection.prototype.addTrack;
      if (typeof originalAddTrack === "function") {
        PeerConnection.prototype.addTrack = function addTrackWithNoiseSuppression(track, ...streams) {
          activePeerConnections.add(this);
          if (!shouldProcessOutgoingAudioTrack(track)) {
            const sender = originalAddTrack.call(this, track, ...streams);
            reportOutgoingAudioTrack("addTrack direct", sender?.track || track);
            return sender;
          }

          updateAudioRouteIndicator("pending", "MIC ADDTRACK: RAW UNTIL FILTER READY", formatTrackInfo(track));
          const sender = originalAddTrack.call(this, track, ...streams);
          reportOutgoingAudioTrack("addTrack raw pending filter", sender?.track || track);
          getProcessedAudioTrack(track).then((processedTrack) => {
            const nextTrack = processedTrack || track;
            if (nextTrack === track || (sender.track && sender.track !== track)) {
              reportOutgoingAudioTrack("addTrack keep raw", sender?.track || track);
              return undefined;
            }
            return sender.replaceTrack(nextTrack).then(() => {
              reportOutgoingAudioTrack("addTrack processed replace", sender?.track || nextTrack);
            });
          }).catch((error) => {
            console.warn("[Vlanya Element] failed to prepare outgoing audio track, keeping original track.", error);
            reportOutgoingAudioTrack("addTrack fallback raw", sender?.track || track);
          });
          return sender;
        };
      }

      const originalAddTransceiver = PeerConnection.prototype.addTransceiver;
      if (typeof originalAddTransceiver === "function") {
        PeerConnection.prototype.addTransceiver = function addTransceiverWithNoiseSuppression(trackOrKind, init) {
          activePeerConnections.add(this);
          if (!shouldProcessOutgoingAudioTrack(trackOrKind)) {
            const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
            if (trackOrKind === "audio" || trackOrKind?.kind === "audio") {
              reportOutgoingAudioTrack("addTransceiver direct", transceiver?.sender?.track || trackOrKind);
            }
            return transceiver;
          }

          updateAudioRouteIndicator("pending", "MIC TRANSCEIVER: RAW UNTIL FILTER READY", formatTrackInfo(trackOrKind));
          const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
          reportOutgoingAudioTrack("addTransceiver raw pending filter", transceiver?.sender?.track || trackOrKind);
          getProcessedAudioTrack(trackOrKind).then((processedTrack) => {
            const nextTrack = processedTrack || trackOrKind;
            if (nextTrack === trackOrKind || (transceiver?.sender?.track && transceiver.sender.track !== trackOrKind)) {
              reportOutgoingAudioTrack("addTransceiver keep raw", transceiver?.sender?.track || trackOrKind);
              return undefined;
            }
            return transceiver?.sender?.replaceTrack(nextTrack).then(() => {
              reportOutgoingAudioTrack("addTransceiver processed replace", transceiver?.sender?.track || nextTrack);
            });
          }).catch((error) => {
            console.warn("[Vlanya Element] failed to prepare outgoing transceiver audio track, keeping original track.", error);
            reportOutgoingAudioTrack("addTransceiver fallback raw", transceiver?.sender?.track || trackOrKind);
          });
          return transceiver;
        };
      }

      Object.defineProperty(PeerConnection.prototype, "__vlanyaAudioSenderPatched", { value: true });
    }

    const Sender = window.RTCRtpSender;
    if (Sender?.prototype && !Sender.prototype.__vlanyaReplaceTrackPatched) {
      const originalReplaceTrack = Sender.prototype.replaceTrack;
      if (typeof originalReplaceTrack === "function") {
        Sender.prototype.replaceTrack = function replaceTrackWithNoiseSuppression(track) {
          if (!shouldProcessOutgoingAudioTrack(track)) {
            return Promise.resolve(originalReplaceTrack.call(this, track)).then((result) => {
              if (!track) {
                updateAudioRouteIndicator("muted", "MIC TRACK REMOVED", "replaceTrack(null)");
              } else {
                reportOutgoingAudioTrack("replaceTrack direct", this.track || track);
              }
              return result;
            });
          }

          updateAudioRouteIndicator("pending", "MIC REPLACETRACK: PROCESSING", formatTrackInfo(track));
          return getProcessedAudioTrack(track).then((processedTrack) => {
            const nextTrack = processedTrack || track;
            return Promise.resolve(originalReplaceTrack.call(this, nextTrack)).then((result) => {
              reportOutgoingAudioTrack("replaceTrack processed", this.track || nextTrack);
              return result;
            });
          }).catch((error) => {
            console.warn("[Vlanya Element] failed to process replaceTrack audio, using original track.", error);
            return Promise.resolve(originalReplaceTrack.call(this, track)).then((result) => {
              updateAudioRouteIndicator("raw", "RAW MIC: REPLACETRACK FALLBACK", `${formatTrackInfo(track)} / ${error?.message || error}`);
              return result;
            });
          });
        };
      }

      Object.defineProperty(Sender.prototype, "__vlanyaReplaceTrackPatched", { value: true });
    }
  };

  const patch = () => {
    installAudioRouteRelayListener();
    exposeNoiseControls();
    patchPeerConnectionAudioSenders();
    startAudioRouteScan();
    updateAudioRouteIndicator("ready", "MIC PATCH READY", `${location.hostname || "local"} / mode ${getNoiseMode()}`);

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || mediaDevices.__vlanyaPatched) return;

    const originalDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    const originalUserMedia = mediaDevices.getUserMedia?.bind(mediaDevices);

    if (originalDisplayMedia) {
      mediaDevices.getDisplayMedia = async (constraints = {}) => {
        let next = constraints;
        if (!next || typeof next !== "object") next = {};

        const stream = await originalDisplayMedia({
          ...next,
          video: next.video ?? true,
          audio: true,
        });
        return markDisplayAudioTracks(stream);
      };
    }

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
        return processMicrophoneStream(stream);
      };
    }

    Object.defineProperty(mediaDevices, "__vlanyaPatched", { value: true });
    console.info(`[Vlanya Element] media capture patched for system audio and "${getNoiseMode()}" microphone suppression.`);
  };

  patch();
  window.addEventListener("DOMContentLoaded", patch, { once: true });
})();
