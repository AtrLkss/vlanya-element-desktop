# Vlanya Element Desktop

Electron wrapper for `https://chat.vlanya.ru` with a custom screen-share picker.

The wrapper tries to force `navigator.mediaDevices.getDisplayMedia` to request
audio and grants Electron desktop capture with `audio: "loopback"` on Windows.
This is meant to test system-audio screen sharing without modifying the official
Element Desktop installation.

Microphone capture is also patched to request browser-side `noiseSuppression`,
`echoCancellation`, and `autoGainControl` for calls.

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
