# Vlanya Element Desktop

Electron wrapper for `https://chat.vlanya.ru` with a custom screen-share picker.

The wrapper tries to force `navigator.mediaDevices.getDisplayMedia` to request
audio and grants Electron desktop capture with `audio: "loopback"` on Windows.
This is meant to test system-audio screen sharing without modifying the official
Element Desktop installation.

Microphone capture is also patched to request browser-side `noiseSuppression`,
`echoCancellation`, and `autoGainControl` for calls. On top of that, microphone
tracks are routed through a WebAudio voice chain before WebRTC sees the track.

The default microphone mode is `rnnoise`: it runs RNNoise through a WASM
AudioWorklet before WebRTC sees the track. The current test build keeps this
path RNNoise-only: the local voice gate, click killer, high-pass, low-pass,
compressor, browser noise suppression, echo cancellation, and auto gain control
are disabled.

A visible audio-route indicator is injected into the app. It shows whether
Element Call is currently sending a processed microphone track, a raw microphone
track, a temporary silent placeholder, or screen-share audio. The indicator
refreshes every second and shows peer connection and microphone sender counts.
Route state is relayed from child frames so embedded Element Call frames can be
diagnosed from the top-level chat window.

The main process also injects a small page-context fallback patch into allowed
frames and guest webviews. This catches Element Call contexts where the normal
preload script is not loaded and applies the same RNNoise-only path there.

For testing, the page exposes
`window.vlanyaNoiseSuppression.setRnnoise(true | false)`,
`window.vlanyaNoiseSuppression.setDeepFilterNet(true | false)`,
`window.vlanyaNoiseSuppression.setExtreme(true | false)`, and
`window.vlanyaNoiseSuppression.setMode("normal" | "extreme" | "rnnoise")`.
Rejoin the call after changing the mode so Element captures the microphone
again.

The chat UI customizations live in the Vlanya Element Web build served from the
server. This desktop wrapper only handles native Windows capture behavior,
tray/background behavior, and media constraints.

## Run

```powershell
.\run.bat
```

## Build Windows Release

```powershell
.\build-release.bat
```

The Windows installer and portable executable are written to `dist\`.

## Auto Updates

Windows auto-updates are enabled for the NSIS installer build. Installed copies
check GitHub Releases after startup and periodically while running. When an
update has downloaded, Vlanya asks whether to restart immediately or install it
later on quit.

The portable executable remains available for manual download, but it does not
self-update. Use the `Vlanya-Element-Windows-Setup-*.exe` installer when
automatic updates are needed.

## GitHub Actions

Pushes to `master`, version tags, pull requests, and manual workflow runs build
the Windows installer and portable executable. Download them from the
`Vlanya-Element-windows` workflow artifact.

Pushing a version tag such as `v0.1.38` also publishes a GitHub Release with the
installer, update metadata, and portable executable attached.
