# Vlanya Element Desktop

Electron wrapper for `https://chat.vlanya.ru` with a custom screen-share picker.

The wrapper tries to force `navigator.mediaDevices.getDisplayMedia` to request
audio and grants Electron desktop capture with `audio: "loopback"` on Windows.
This is meant to test system-audio screen sharing without modifying the official
Element Desktop installation.

Microphone capture is also patched to request browser-side `noiseSuppression`,
`echoCancellation`, and `autoGainControl` for calls. On top of that, microphone
tracks are routed through a WebAudio voice chain before WebRTC sees the track.

The default microphone mode is `deepfilter`: it runs DeepFilterNet3 through a
WASM AudioWorklet before WebRTC sees the track. The current test build keeps
this path DeepFilterNet-only: the local voice gate, click killer, high-pass,
low-pass, compressor, browser noise suppression, echo cancellation, and auto
gain control are disabled.

A visible audio-route indicator is injected into the app. It shows whether
Element Call is currently sending a processed microphone track, a raw microphone
track, a temporary silent placeholder, or screen-share audio. The indicator
refreshes every second and shows peer connection and microphone sender counts.
Route state is relayed from child frames so embedded Element Call frames can be
diagnosed from the top-level chat window.

The main process also injects a small page-context fallback patch into allowed
frames and guest webviews. This catches Element Call contexts where the normal
preload script is not loaded and applies the same DeepFilterNet-only path there.

For testing, the page exposes
`window.vlanyaNoiseSuppression.setDeepFilterNet(true | false)`,
`window.vlanyaNoiseSuppression.setExtreme(true | false)`, and
`window.vlanyaNoiseSuppression.setMode("normal" | "extreme" | "deepfilter")`.
Rejoin the call after changing the mode so Element captures the microphone
again.

The chat UI customizations live in the Vlanya Element Web build served from the
server. This desktop wrapper only handles native Windows capture behavior,
tray/background behavior, and media constraints.

## Run

```powershell
.\run.bat
```

## Build Portable EXE

```powershell
.\build-portable.bat
```

The portable executable is written to `dist\`.
