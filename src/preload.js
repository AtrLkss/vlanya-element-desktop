(() => {
  const patch = () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || mediaDevices.__vlanyaPatched) return;
    const original = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    if (!original) return;

    mediaDevices.getDisplayMedia = (constraints = {}) => {
      let next = constraints;
      if (!next || typeof next !== "object") next = {};
      next = {
        ...next,
        video: next.video ?? true,
        audio: true,
      };
      return original(next);
    };
    Object.defineProperty(mediaDevices, "__vlanyaPatched", { value: true });
    console.info("[Vlanya Element] getDisplayMedia patched to request system audio.");
  };

  patch();
  window.addEventListener("DOMContentLoaded", patch, { once: true });
})();
