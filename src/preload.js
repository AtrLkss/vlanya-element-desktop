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

  const injectComposerAccent = () => {
    if (!document.head || document.getElementById("vlanya-composer-accent-style")) return;

    const style = document.createElement("style");
    style.id = "vlanya-composer-accent-style";
    style.textContent = `
      .mx_RoomView_MessageComposer {
        background: #08090d !important;
        padding: 8px 10px 10px !important;
      }

      .mx_RoomView_MessageComposer .mx_MessageComposer,
      .mx_RoomView_MessageComposer .vlanya-composer-accent {
        position: relative !important;
        min-height: 46px !important;
        margin: 0 !important;
        background: #15161b !important;
        border: 1px solid #343741 !important;
        border-radius: 7px !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03) !important;
        transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease !important;
      }

      .mx_RoomView_MessageComposer .mx_MessageComposer:hover,
      .mx_RoomView_MessageComposer .vlanya-composer-accent:hover {
        border-color: #424753 !important;
        background: #17191f !important;
      }

      .mx_RoomView_MessageComposer .mx_MessageComposer:focus-within,
      .mx_RoomView_MessageComposer .vlanya-composer-accent:focus-within {
        border-color: rgba(255, 58, 58, 0.72) !important;
        box-shadow:
          inset 3px 0 0 #ff3636,
          inset 0 1px 0 rgba(255, 255, 255, 0.04),
          0 0 0 1px rgba(255, 58, 58, 0.16) !important;
      }

      .mx_RoomView_MessageComposer .mx_MessageComposer::before,
      .mx_RoomView_MessageComposer .vlanya-composer-accent::before {
        content: "";
        position: absolute;
        left: 52px;
        top: 11px;
        bottom: 11px;
        width: 1px;
        background: #3a3e49;
        pointer-events: none;
      }

      .mx_RoomView_MessageComposer .mx_MessageComposer_wrapper,
      .mx_RoomView_MessageComposer .mx_BasicMessageComposer,
      .mx_RoomView_MessageComposer .mx_SendMessageComposer {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      .mx_RoomView_MessageComposer [contenteditable="true"],
      .mx_RoomView_MessageComposer textarea,
      .mx_RoomView_MessageComposer input {
        caret-color: #ff3636 !important;
      }

      .mx_RoomView_MessageComposer .mx_BasicMessageComposer_input,
      .mx_RoomView_MessageComposer .mx_SendMessageComposer_view,
      .mx_RoomView_MessageComposer [role="textbox"] {
        color: #e7e9ee !important;
      }

      .mx_RoomView_MessageComposer .mx_BasicMessageComposer_inputEmpty,
      .mx_RoomView_MessageComposer [data-placeholder],
      .mx_RoomView_MessageComposer [aria-placeholder] {
        color: #8c929f !important;
      }
    `;
    document.head.appendChild(style);
  };

  const markComposerRoots = () => {
    document
      .querySelectorAll(".mx_RoomView_MessageComposer .mx_MessageComposer")
      .forEach((composer) => composer.classList.add("vlanya-composer-accent"));
  };

  const installComposerAccent = () => {
    injectComposerAccent();
    markComposerRoots();

    if (window.__vlanyaComposerAccentObserver) return;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        injectComposerAccent();
        markComposerRoots();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__vlanyaComposerAccentObserver = observer;
  };

  const injectVideoFullscreenStyle = () => {
    if (!document.head || document.getElementById("vlanya-video-fullscreen-style")) return;

    const style = document.createElement("style");
    style.id = "vlanya-video-fullscreen-style";
    style.textContent = `
      video.vlanya-video-fullscreen-ready {
        cursor: zoom-in !important;
      }

      video.vlanya-video-fullscreen-ready:fullscreen {
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100vw !important;
        max-height: 100vh !important;
        object-fit: contain !important;
        background: #000 !important;
        cursor: zoom-out !important;
      }
    `;
    document.head.appendChild(style);
  };

  const markFullscreenVideos = () => {
    document.querySelectorAll("video").forEach((video) => {
      video.classList.add("vlanya-video-fullscreen-ready");
      video.setAttribute("data-vlanya-fullscreen-video", "true");
    });
  };

  const findVideoFromEvent = (event) => {
    const path = event.composedPath?.() || [];
    return path.find((node) => node instanceof HTMLVideoElement) || null;
  };

  const requestVideoFullscreen = async (video) => {
    if (!video) return;
    try {
      if (document.fullscreenElement) {
        const currentFullscreenElement = document.fullscreenElement;
        await document.exitFullscreen();
        if (currentFullscreenElement === video) return;
      }

      if (video.requestFullscreen) {
        await video.requestFullscreen({ navigationUI: "hide" });
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } catch (error) {
      console.warn("[Vlanya Element] video fullscreen failed:", error);
    }
  };

  const installVideoFullscreen = () => {
    injectVideoFullscreenStyle();
    markFullscreenVideos();

    if (!window.__vlanyaVideoFullscreenClickHandler) {
      window.__vlanyaVideoFullscreenClickHandler = (event) => {
        const video = findVideoFromEvent(event);
        if (!video) return;
        event.preventDefault();
        event.stopPropagation();
        requestVideoFullscreen(video);
      };
      document.addEventListener("dblclick", window.__vlanyaVideoFullscreenClickHandler, true);
    }

    if (window.__vlanyaVideoFullscreenObserver) return;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        injectVideoFullscreenStyle();
        markFullscreenVideos();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__vlanyaVideoFullscreenObserver = observer;
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
        next = {
          ...next,
          video: next.video ?? true,
          audio: true,
        };
        return originalDisplayMedia(next);
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
  installComposerAccent();
  installVideoFullscreen();
  window.addEventListener(
    "DOMContentLoaded",
    () => {
      patch();
      installComposerAccent();
      installVideoFullscreen();
    },
    { once: true },
  );
})();
