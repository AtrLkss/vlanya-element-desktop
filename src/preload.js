(() => {
  const AUDIO_PROCESSING = {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  };

  const WORKLET_NAME = "vlanya-noise-gate";
  const WORKLET_CODE = `
class VlanyaNoiseGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1;
    this.noiseFloor = 0.012;
    this.hold = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    let sum = 0;
    let count = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) {
        sum += channel[i] * channel[i];
        count += 1;
      }
    }

    const rms = count ? Math.sqrt(sum / count) : 0;
    const openThreshold = Math.max(0.018, this.noiseFloor * 3.0);
    const closeThreshold = Math.max(0.012, this.noiseFloor * 1.8);
    const speaking = rms > openThreshold;

    if (speaking) {
      this.hold = 18;
    } else if (this.hold > 0) {
      this.hold -= 1;
    } else {
      this.noiseFloor = (this.noiseFloor * 0.98) + (Math.max(0.002, rms) * 0.02);
    }

    let targetGain = 0.08;
    if (speaking || this.hold > 0) {
      targetGain = 1;
    } else if (rms > closeThreshold) {
      targetGain = 0.32;
    }

    const smoothing = targetGain > this.gain ? 0.22 : 0.055;
    this.gain += (targetGain - this.gain) * smoothing;

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const source = input[Math.min(channelIndex, input.length - 1)];
      const destination = output[channelIndex];
      if (!source) {
        destination.fill(0);
        continue;
      }
      for (let i = 0; i < destination.length; i += 1) {
        destination[i] = source[i] * this.gain;
      }
    }

    return true;
  }
}

registerProcessor("${WORKLET_NAME}", VlanyaNoiseGate);
`;

  const processingContexts = new Set();

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

  const makeWorkletNode = async (context) => {
    if (!context.audioWorklet) return null;

    const blob = new Blob([WORKLET_CODE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(url);
      return new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const makeScriptProcessorGate = (context) => {
    const node = context.createScriptProcessor(1024, 1, 1);
    let gain = 1;
    let noiseFloor = 0.012;
    let hold = 0;

    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let sum = 0;

      for (let i = 0; i < input.length; i += 1) {
        sum += input[i] * input[i];
      }

      const rms = Math.sqrt(sum / input.length);
      const openThreshold = Math.max(0.018, noiseFloor * 3.0);
      const closeThreshold = Math.max(0.012, noiseFloor * 1.8);
      const speaking = rms > openThreshold;

      if (speaking) {
        hold = 18;
      } else if (hold > 0) {
        hold -= 1;
      } else {
        noiseFloor = (noiseFloor * 0.98) + (Math.max(0.002, rms) * 0.02);
      }

      let targetGain = 0.08;
      if (speaking || hold > 0) {
        targetGain = 1;
      } else if (rms > closeThreshold) {
        targetGain = 0.32;
      }

      const smoothing = targetGain > gain ? 0.22 : 0.055;
      gain += (targetGain - gain) * smoothing;

      for (let i = 0; i < input.length; i += 1) {
        output[i] = input[i] * gain;
      }
    };

    return node;
  };

  const processMicrophoneTrack = async (track) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || track.__vlanyaNoiseSuppressed) return track;

    const context = new AudioContextClass({
      latencyHint: "interactive",
    });

    try {
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }

      const inputStream = new MediaStream([track]);
      const source = context.createMediaStreamSource(inputStream);
      const highPass = context.createBiquadFilter();
      const lowPass = context.createBiquadFilter();
      const compressor = context.createDynamicsCompressor();
      const destination = context.createMediaStreamDestination();
      const gate = (await makeWorkletNode(context)) || makeScriptProcessorGate(context);

      highPass.type = "highpass";
      highPass.frequency.value = 95;
      highPass.Q.value = 0.7;

      lowPass.type = "lowpass";
      lowPass.frequency.value = 9800;
      lowPass.Q.value = 0.45;

      compressor.threshold.value = -28;
      compressor.knee.value = 18;
      compressor.ratio.value = 2.6;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.16;

      source.connect(highPass);
      highPass.connect(lowPass);
      lowPass.connect(compressor);
      compressor.connect(gate);
      gate.connect(destination);

      const processedTrack = destination.stream.getAudioTracks()[0];
      if (!processedTrack) throw new Error("Processed microphone track was not created");

      Object.defineProperty(processedTrack, "__vlanyaNoiseSuppressed", { value: true });
      processingContexts.add(context);

      const cleanup = () => {
        processingContexts.delete(context);
        source.disconnect();
        highPass.disconnect();
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

      console.info("[Vlanya Element] microphone track is processed by WebAudio noise suppression.");
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
    const nextStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...processedAudioTracks,
    ]);

    for (const track of stream.getTracks()) {
      if (!audioTracks.includes(track)) continue;
      if (!processedAudioTracks.includes(track) && track.readyState !== "ended") {
        track.enabled = true;
      }
    }

    return nextStream;
  };

  const patch = () => {
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
    console.info("[Vlanya Element] media capture patched for system audio and WebAudio microphone noise suppression.");
  };

  patch();
  window.addEventListener("DOMContentLoaded", patch, { once: true });
})();
