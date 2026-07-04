(() => {
  const AUDIO_PROCESSING = {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    channelCount: { ideal: 1 },
  };

  const NOISE_MODE_KEY = "vlanya.noiseSuppressionMode";
  const DEFAULT_NOISE_MODE = "extreme";
  const VALID_NOISE_MODES = new Set(["normal", "extreme"]);
  const WORKLET_NAME = "vlanya-voice-gate";
  const WORKLET_CODE = `
class VlanyaVoiceGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mode = options.processorOptions?.mode === "normal" ? "normal" : "extreme";
    this.gain = 1;
    this.noiseFloor = this.mode === "extreme" ? 0.009 : 0.012;
    this.hold = 0;
    this.closedFrames = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    let sum = 0;
    let peak = 0;
    let count = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) {
        const sample = channel[i];
        const abs = Math.abs(sample);
        sum += sample * sample;
        if (abs > peak) peak = abs;
        count += 1;
      }
    }

    const rms = count ? Math.sqrt(sum / count) : 0;
    const extreme = this.mode === "extreme";
    const openThreshold = Math.max(extreme ? 0.032 : 0.018, this.noiseFloor * (extreme ? 5.2 : 3.0));
    const closeThreshold = Math.max(extreme ? 0.021 : 0.012, this.noiseFloor * (extreme ? 3.3 : 1.8));
    const peakBoost = peak > (extreme ? 0.09 : 0.06) && rms > closeThreshold;
    const speaking = rms > openThreshold || peakBoost;

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
    } else if (rms > closeThreshold) {
      targetGain = extreme ? 0.12 : 0.32;
    }

    if (extreme && this.closedFrames > 16) {
      targetGain = 0;
    }

    const smoothing = targetGain > this.gain ? (extreme ? 0.35 : 0.22) : (extreme ? 0.12 : 0.055);
    this.gain += (targetGain - this.gain) * smoothing;

    if (extreme && this.gain < 0.006) {
      this.gain = 0;
    }

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const source = input[Math.min(channelIndex, input.length - 1)];
      const destination = output[channelIndex];
      if (!source || this.gain === 0) {
        destination.fill(0);
        continue;
      }

      for (let i = 0; i < destination.length; i += 1) {
        const sample = source[i] * this.gain;
        destination[i] = Math.max(-0.98, Math.min(0.98, sample));
      }
    }

    return true;
  }
}

registerProcessor("${WORKLET_NAME}", VlanyaVoiceGate);
`;

  const processingContexts = new Set();

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
    let gain = 1;
    let noiseFloor = extreme ? 0.009 : 0.012;
    let hold = 0;
    let closedFrames = 0;

    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let sum = 0;
      let peak = 0;

      for (let i = 0; i < input.length; i += 1) {
        const sample = input[i];
        const abs = Math.abs(sample);
        sum += sample * sample;
        if (abs > peak) peak = abs;
      }

      const rms = Math.sqrt(sum / input.length);
      const openThreshold = Math.max(extreme ? 0.032 : 0.018, noiseFloor * (extreme ? 5.2 : 3.0));
      const closeThreshold = Math.max(extreme ? 0.021 : 0.012, noiseFloor * (extreme ? 3.3 : 1.8));
      const peakBoost = peak > (extreme ? 0.09 : 0.06) && rms > closeThreshold;
      const speaking = rms > openThreshold || peakBoost;

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
      } else if (rms > closeThreshold) {
        targetGain = extreme ? 0.12 : 0.32;
      }
      if (extreme && closedFrames > 16) targetGain = 0;

      const smoothing = targetGain > gain ? (extreme ? 0.35 : 0.22) : (extreme ? 0.12 : 0.055);
      gain += (targetGain - gain) * smoothing;
      if (extreme && gain < 0.006) gain = 0;

      if (gain === 0) {
        output.fill(0);
        return;
      }

      for (let i = 0; i < input.length; i += 1) {
        const sample = input[i] * gain;
        output[i] = Math.max(-0.98, Math.min(0.98, sample));
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
    lowPass.frequency.value = extreme ? 4300 : 9800;
    lowPass.Q.value = extreme ? 0.65 : 0.45;

    presence.type = "peaking";
    presence.frequency.value = 2550;
    presence.Q.value = 1.05;
    presence.gain.value = extreme ? 4.5 : 1.5;

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

  const processMicrophoneTrack = async (track) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || track.__vlanyaNoiseSuppressed) return track;

    const mode = getNoiseMode();
    const context = new AudioContextClass({
      latencyHint: "interactive",
    });

    try {
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }

      const inputStream = new MediaStream([track]);
      const source = context.createMediaStreamSource(inputStream);
      const { highPass, lowPass, presence, deMud, compressor } = createVoiceOnlyFilters(context, mode);
      const destination = context.createMediaStreamDestination();
      const gate = (await makeWorkletNode(context, mode)) || makeScriptProcessorGate(context, mode);

      source.connect(highPass);
      highPass.connect(deMud);
      deMud.connect(presence);
      presence.connect(lowPass);
      lowPass.connect(compressor);
      compressor.connect(gate);
      gate.connect(destination);

      const processedTrack = destination.stream.getAudioTracks()[0];
      if (!processedTrack) throw new Error("Processed microphone track was not created");

      Object.defineProperty(processedTrack, "__vlanyaNoiseSuppressed", { value: true });
      Object.defineProperty(processedTrack, "__vlanyaNoiseMode", { value: mode });
      processingContexts.add(context);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        processingContexts.delete(context);
        source.disconnect();
        highPass.disconnect();
        deMud.disconnect();
        presence.disconnect();
        lowPass.disconnect();
        compressor.disconnect();
        gate.disconnect();
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

      console.info(`[Vlanya Element] microphone track is processed by "${mode}" voice-only noise suppression.`);
      return processedTrack;
    } catch (error) {
      console.warn("[Vlanya Element] WebAudio noise suppression failed, using original microphone track.", error);
      await context.close().catch(() => undefined);
      return track;
    }
  };

  const processMicrophoneStream = async (stream) => {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return stream;

    const processedAudioTracks = await Promise.all(audioTracks.map(processMicrophoneTrack));
    return new MediaStream([
      ...stream.getVideoTracks(),
      ...processedAudioTracks,
    ]);
  };

  const patch = () => {
    exposeNoiseControls();

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || mediaDevices.__vlanyaPatched) return;

    const originalDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    const originalUserMedia = mediaDevices.getUserMedia?.bind(mediaDevices);

    if (originalDisplayMedia) {
      mediaDevices.getDisplayMedia = (constraints = {}) => {
        let next = constraints;
        if (!next || typeof next !== "object") next = {};

        return originalDisplayMedia({
          ...next,
          video: next.video ?? true,
          audio: true,
        });
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
    console.info(`[Vlanya Element] media capture patched for system audio and "${getNoiseMode()}" voice-only microphone suppression.`);
  };

  patch();
  window.addEventListener("DOMContentLoaded", patch, { once: true });
})();
