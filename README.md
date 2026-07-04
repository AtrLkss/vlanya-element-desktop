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
WASM AudioWorklet, then applies the local voice-only post-filter/gate to cut
everything outside speech as hard as possible. If DeepFilterNet assets cannot be
loaded, the wrapper falls back to the local `extreme` mode instead of breaking
the call.

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
