(() => {
  const AUDIO_PROCESSING = {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
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
      mediaDevices.getUserMedia = (constraints = {}) => {
        return originalUserMedia(withAudioProcessing(constraints));
      };
    }

    Object.defineProperty(mediaDevices, "__vlanyaPatched", { value: true });
    console.info("[Vlanya Element] media capture patched for system audio and microphone noise suppression.");
  };

  patch();
  window.addEventListener("DOMContentLoaded", patch, { once: true });
})();
