# Vlanya Element Desktop

Electron wrapper for `https://chat.vlanya.ru` with a custom screen-share picker.

The wrapper tries to force `navigator.mediaDevices.getDisplayMedia` to request
audio and grants Electron desktop capture with `audio: "loopback"` on Windows.
This is meant to test system-audio screen sharing without modifying the official
Element Desktop installation.

Microphone capture is also patched to request browser-side `noiseSuppression`,
`echoCancellation`, and `autoGainControl` for calls.

The message composer gets a compact dark accent style with a red focus bar and
caret inside the Electron wrapper.

Call videos can be opened fullscreen with a double-click, including webcam
tiles that Element does not normally expose like screen shares.

## Run

```powershell
.\run.bat
```

## Build Portable EXE

```powershell
.\build-portable.bat
```

The portable executable is written to `dist\`.
