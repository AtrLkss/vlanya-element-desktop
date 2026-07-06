const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  ipcMain,
  nativeImage,
  shell,
  session,
  Tray,
  webFrameMain,
} = require("electron");

const CHAT_URL = "https://chat.vlanya.ru";
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const FRAME_AUDIO_PATCH_PATH = path.join(__dirname, "frame-audio-patch.js");
const RNNOISE_BROWSER_BUNDLE_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@shiguredo",
  "rnnoise-wasm",
  "dist",
  "rnnoise.js",
);
const WINDOW_AUDIO_HELPER_NAME = "Vlanya.WindowAudioCapture.exe";
const ALLOWED_HOSTS = new Set([
  "chat.vlanya.ru",
  "call.vlanya.ru",
  "matrix.vlanya.ru",
  "vlanya.ru",
]);

let mainWindow = null;
let pickerWindow = null;
let tray = null;
let isQuitting = false;
let currentPickerResolve = null;
let currentSources = [];
let pendingWindowAudioCapture = null;
const activeWindowAudioCaptures = new Map();
const configuredWebContents = new WeakSet();
let frameAudioPatchSource = null;
let rnnoiseBrowserBundleSource = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function isAllowedUrl(value) {
  if (!value) return false;
  if (value.startsWith("vector://") || value.startsWith("file://")) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function isAllowedFrameUrl(value) {
  if (!value) return false;
  if (value === "about:blank" || value.startsWith("about:srcdoc")) return true;
  return isAllowedUrl(value);
}

function isElementCallFrameUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === "call.vlanya.ru" || parsed.pathname.includes("/widgets/element-call/");
  } catch (_) {
    return false;
  }
}

function getFrameAudioPatchSource() {
  if (!frameAudioPatchSource) {
    frameAudioPatchSource = fs.readFileSync(FRAME_AUDIO_PATCH_PATH, "utf8");
  }
  return `${getRnnoiseBrowserBundleSource()}\n${frameAudioPatchSource}\n//# sourceURL=vlanya-frame-audio-patch.js`;
}

function getRnnoiseBrowserBundleSource() {
  if (!rnnoiseBrowserBundleSource) {
    let source = fs.readFileSync(RNNOISE_BROWSER_BUNDLE_PATH, "utf8");
    source = source
      .replace(/import\.meta\.url/g, JSON.stringify("vlanya-rnnoise-browser-bundle.js"))
      .replace(
        /export\s+\{\s*kA\s+as\s+DenoiseState,\s*l\s+as\s+Rnnoise\s*\};?\s*$/m,
        [
          "globalThis.__vlanyaRnnoiseClass = l;",
          "globalThis.__vlanyaRnnoiseDenoiseStateClass = kA;",
        ].join("\n"),
      );
    rnnoiseBrowserBundleSource = [
      "(function installVlanyaRnnoiseBundle() {",
      "if (globalThis.__vlanyaRnnoiseClass) return;",
      source,
      "})();",
      "//# sourceURL=vlanya-rnnoise-browser-bundle.js",
    ].join("\n");
  }
  return rnnoiseBrowserBundleSource;
}

function injectFrameAudioPatch(frame) {
  if (!frame || frame.detached || frame.isDestroyed?.()) return;
  if (!isAllowedFrameUrl(frame.url)) return;
  if (!isElementCallFrameUrl(frame.url)) return;

  frame.executeJavaScript(getFrameAudioPatchSource(), false).catch((error) => {
    console.warn("frame audio patch injection failed:", frame.url, error?.message || error);
  });
}

function injectAllFrameAudioPatches(contents) {
  if (!contents || contents.isDestroyed?.()) return;
  try {
    for (const frame of contents.mainFrame.framesInSubtree) {
      injectFrameAudioPatch(frame);
    }
  } catch (error) {
    console.warn("failed to enumerate frames for audio patch:", error?.message || error);
  }
}

function getOriginFromDetails(details) {
  return (
    details?.requestingUrl ||
    details?.requestingOrigin ||
    details?.securityOrigin ||
    details?.embeddingOrigin ||
    ""
  );
}

function getAppWebPreferences() {
  return {
    preload: PRELOAD_PATH,
    partition: "persist:vlanya-element",
    nodeIntegration: false,
    contextIsolation: false,
    nodeIntegrationInSubFrames: true,
    sandbox: false,
    spellcheck: true,
  };
}

function getWindowAudioHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "window-audio-capture", WINDOW_AUDIO_HELPER_NAME);
  }
  return path.join(__dirname, "..", "native", "window-audio-capture", "publish", WINDOW_AUDIO_HELPER_NAME);
}

function getWindowHandleFromSourceId(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId || ""));
  if (!match) return null;
  const handle = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

function isWindowAudioFrameAllowed(frame) {
  if (!frame || frame.detached || frame.isDestroyed?.()) return false;
  return isAllowedFrameUrl(frame.url) && isElementCallFrameUrl(frame.url);
}

function isWindowAudioIpcFrameAllowed(frame) {
  if (!frame || frame.detached || frame.isDestroyed?.()) return false;
  if (!isAllowedFrameUrl(frame.url)) return false;
  if (isElementCallFrameUrl(frame.url)) return true;

  try {
    const parsed = new URL(frame.url);
    return parsed.hostname === "chat.vlanya.ru" || parsed.hostname === "vlanya.ru";
  } catch (_) {
    return false;
  }
}

function stopWindowAudioCapture(token) {
  const capture = activeWindowAudioCaptures.get(token);
  if (!capture) return;
  activeWindowAudioCaptures.delete(token);

  try {
    capture.child.stdin?.end();
  } catch (_) {
    // The process may already be gone.
  }

  if (!capture.child.killed) {
    try {
      capture.child.kill();
    } catch (_) {
      // Best-effort cleanup.
    }
  }
}

function stopCapturesForFrame(frame) {
  for (const [token, capture] of activeWindowAudioCaptures) {
    if (capture.frame === frame) stopWindowAudioCapture(token);
  }
}

function rememberWindowAudioCapture(source) {
  const windowHandle = getWindowHandleFromSourceId(source.id);

  pendingWindowAudioCapture = {
    sourceId: source.id,
    sourceName: source.name || "Window",
    windowHandle,
    expiresAt: Date.now() + 15000,
  };
  return true;
}

function consumePendingWindowAudioCapture() {
  const pending = pendingWindowAudioCapture;
  pendingWindowAudioCapture = null;
  if (!pending || pending.expiresAt < Date.now()) return null;
  return pending;
}

function configureAppWebContents(contents) {
  if (!contents || configuredWebContents.has(contents)) return;
  configuredWebContents.add(contents);

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          backgroundColor: "#101114",
          webPreferences: getAppWebPreferences(),
        },
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isAllowedUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  contents.on("frame-created", (_event, details) => {
    if (details?.frame) {
      setTimeout(() => injectFrameAudioPatch(details.frame), 0);
      setTimeout(() => injectFrameAudioPatch(details.frame), 250);
    }
  });

  contents.on("did-frame-finish-load", (_event, _isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (frame) injectFrameAudioPatch(frame);
  });

  contents.on("did-frame-navigate", (_event, _url, _httpResponseCode, _httpStatusText, _isMainFrame, frameProcessId, frameRoutingId) => {
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (frame) setTimeout(() => injectFrameAudioPatch(frame), 0);
  });

  contents.on("did-finish-load", () => {
    injectAllFrameAudioPatches(contents);
  });

  contents.on("destroyed", () => {
    for (const [token, capture] of activeWindowAudioCaptures) {
      if (capture.webContents === contents) stopWindowAudioCapture(token);
    }
  });

  contents.on("did-attach-webview", (_event, guestContents) => {
    configureAppWebContents(guestContents);
    injectAllFrameAudioPatches(guestContents);
  });
}

function configureSession(ses) {
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (!isAllowedUrl(requestingOrigin) && !isAllowedUrl(getOriginFromDetails(details))) return false;
    return [
      "media",
      "display-capture",
      "notifications",
      "fullscreen",
      "speaker-selection",
      "window-management",
    ].includes(permission);
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (!isAllowedUrl(getOriginFromDetails(details))) {
      callback(false);
      return;
    }
    callback([
      "media",
      "display-capture",
      "notifications",
      "fullscreen",
      "speaker-selection",
      "window-management",
    ].includes(permission));
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isAllowedUrl(request.securityOrigin)) {
      callback({});
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 360, height: 220 },
        fetchWindowIcons: true,
      });

      const picked = await showPicker(sources, {
        audioRequested: request.audioRequested,
        securityOrigin: request.securityOrigin,
      });

      if (!picked) {
        callback({});
        return;
      }

      const source = sources.find((item) => item.id === picked.sourceId);
      if (!source) {
        callback({});
        return;
      }

      const isScreenSource = source.id.startsWith("screen:");
      const isWindowSource = source.id.startsWith("window:");
      const streams = { video: source };
      if (picked.shareAudio && isWindowSource && process.platform === "win32") {
        rememberWindowAudioCapture(source);
      } else {
        pendingWindowAudioCapture = null;
      }
      callback(streams);
    } catch (error) {
      console.error("display media handler failed:", error);
      callback({});
    }
  });
}

function createMainWindow() {
  const appSession = session.fromPartition("persist:vlanya-element");
  configureSession(appSession);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: "Vlanya Element",
    backgroundColor: "#101114",
    webPreferences: getAppWebPreferences(),
  });

  configureAppWebContents(mainWindow.webContents);

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.loadURL(CHAT_URL);
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayImage());
  tray.setToolTip("Vlanya Element");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleMainWindow);
  tray.on("double-click", showMainWindow);
}

function createTrayImage() {
  const trayPng =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAL2SURBVFhH1Vc/aBNRGM/oFnOXa+5C2wv+qVpbbKPSGmm1EhE6SAeRQgWlUAgUVKxIHISA4KQILtmcBNFFJ51EcNFJF8HR0dHR8Xy/y7tr3nu/d7lEOvjBj0De937f3/d9SeG/FccZW3Tdyvl+yKO9Ec/z/JLrtxw3eO+Ug8iGUjn4XHKDdrFSqcmr/ybFYrhfEHaE8T/M4AB04bikGl6QVqfs/ybEuQHHS+XquqTML45XuTFi1BTIoqQeLDDOSPpRrR+LJpunUowvzlK9foiAnkoTdkHasyI/2roULb3biS5+f2hg+cO9aObu5citjtO7gOBuSVOmoGFsNUfEjdfb1LAOODixPG9wAAiu6FXnpElVkCJ26fC1laj5tUONZWH65qrBBZTK/htpclfkOzdSj8hHMZ4A/aFzAkYWMDyYYt6027Dy6X7k1UKDV6ArTfcEE0xXQsMx0gRn396KzrxoxZ/sPEH9yYbCC4iAf0nTvWmnKwDoakZ44cuDqLa6oOhOnJsXzXeH6qOELAtpGbBY9EO8a0YGhJa6VuvT1n45sNYw9NMJ6brBmn546OoSJWq82lb0dJzubtJ7lhdxO3YAw0E/PLLZpERzj9YVPR3HxSBi9zCgdN10PCMV+iHePiNaeL6l6OmoP96g9ywOtGMHeltPPcQkY0SocTA7pegmwAjGs2P3UFLjjtg5sQO9EaweggzdzsjQB2NTBw39k8+uU30gmCFOi+aPHYCIL37qCqg3IwPg3InOlbjm+LRFDmBO6NyYumEY7pPm+R5AlFnEeYCSsVVt7AMMBV0JwPtlxHlhW0h4+tL0rsArppxViixYX4zrf5MmVbFlAcCztDWlDqTdFjlAo0/EthUB9ASWDzOaIOvHiIS6BZmIFL0kF1PgSWFSYrgkwObEbwemnwAbV+l8m0BpkBPDAsaxdaWJfIJZzchGQDdX5EzkmP6oEeaCeFU/MhtuGIlXtigL+91oAP8fkzm/F9L77xC0UaJ+4PvhUl0o/AVHY9dvalvirAAAAABJRU5ErkJggg==";
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${trayPng}`);
  image.setTemplateImage(false);
  return image;
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  mainWindow?.hide();
}

function toggleMainWindow() {
  if (!mainWindow || !mainWindow.isVisible()) {
    showMainWindow();
  } else {
    hideMainWindow();
  }
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Показать", click: showMainWindow },
    { label: "Скрыть", click: hideMainWindow },
    { type: "separator" },
    { label: "Выйти", click: quitApp },
  ]);
}

function sourceToView(source) {
  const isScreen = source.id.startsWith("screen:");
  return {
    id: source.id,
    name: source.name || (isScreen ? "Экран" : "Окно"),
    type: isScreen ? "screen" : "window",
    thumbnail: source.thumbnail?.toDataURL() || "",
    appIcon: source.appIcon?.toDataURL() || "",
  };
}

function showPicker(sources, requestInfo) {
  if (pickerWindow) {
    pickerWindow.close();
    pickerWindow = null;
  }
  if (currentPickerResolve) {
    currentPickerResolve(null);
    currentPickerResolve = null;
  }

  currentSources = sources
    .slice()
    .sort((a, b) => {
      const aScreen = a.id.startsWith("screen:");
      const bScreen = b.id.startsWith("screen:");
      if (aScreen !== bScreen) return aScreen ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "");
    })
    .map(sourceToView);

  return new Promise((resolve) => {
    currentPickerResolve = resolve;
    pickerWindow = new BrowserWindow({
      width: 820,
      height: 610,
      minWidth: 700,
      minHeight: 500,
      title: "Выбор демонстрации",
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      backgroundColor: "#121419",
      webPreferences: {
        preload: path.join(__dirname, "picker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    pickerWindow.removeMenu();
    pickerWindow.loadFile(path.join(__dirname, "picker.html"));
    pickerWindow.webContents.once("did-finish-load", () => {
      pickerWindow?.webContents.send("display-sources", {
        sources: currentSources,
        platform: process.platform,
        requestInfo,
      });
    });
    pickerWindow.on("closed", () => {
      pickerWindow = null;
      currentSources = [];
      if (currentPickerResolve) {
        currentPickerResolve(null);
        currentPickerResolve = null;
      }
    });
  });
}

ipcMain.handle("picker:choose", (_event, selection) => {
  const resolve = currentPickerResolve;
  currentPickerResolve = null;
  if (pickerWindow) {
    pickerWindow.close();
    pickerWindow = null;
  }
  if (resolve) resolve(selection);
});

ipcMain.handle("picker:cancel", () => {
  const resolve = currentPickerResolve;
  currentPickerResolve = null;
  if (pickerWindow) {
    pickerWindow.close();
    pickerWindow = null;
  }
  if (resolve) resolve(null);
});

ipcMain.handle("vlanya-window-audio:start", (event) => {
  const frame = event.senderFrame;
  if (!isWindowAudioIpcFrameAllowed(frame)) {
    return { ok: false, error: "frame-not-allowed" };
  }

  const pending = consumePendingWindowAudioCapture();
  if (!pending) {
    return { ok: false, error: "no-pending-window-audio" };
  }

  const helperPath = getWindowAudioHelperPath();
  if (!fs.existsSync(helperPath)) {
    console.warn("window audio helper not found:", helperPath);
    return { ok: false, error: "helper-not-found" };
  }

  const token = randomUUID();
  const helperArgs = [];
  if (pending.windowHandle) {
    helperArgs.push("--hwnd", String(pending.windowHandle));
  }
  if (pending.sourceName) {
    helperArgs.push("--window-title", pending.sourceName);
  }

  const child = spawn(helperPath, helperArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const capture = {
    token,
    child,
    frame,
    webContents: event.sender,
    sourceName: pending.sourceName,
  };
  activeWindowAudioCaptures.set(token, capture);

  child.stdout.on("data", (chunk) => {
    if (!activeWindowAudioCaptures.has(token)) return;
    if (!isWindowAudioIpcFrameAllowed(frame)) {
      stopWindowAudioCapture(token);
      return;
    }

    try {
      frame.send("vlanya-window-audio:data", token, chunk);
    } catch (error) {
      console.warn("window audio frame send failed:", error?.message || error);
      stopWindowAudioCapture(token);
    }
  });

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.info(`[window-audio:${token.slice(0, 8)}] ${message}`);
      try {
        frame.send("vlanya-window-audio:status", token, message);
      } catch (_) {
        // The frame may already be gone.
      }
    }
  });

  child.on("error", (error) => {
    console.warn("window audio helper failed:", error?.message || error);
    try {
      frame.send("vlanya-window-audio:stop", token, error?.message || "helper-error");
    } catch (_) {
      // The frame may already be gone.
    }
    stopWindowAudioCapture(token);
  });

  child.on("exit", (code, signal) => {
    activeWindowAudioCaptures.delete(token);
    try {
      frame.send("vlanya-window-audio:stop", token, code === 0 ? null : `exit ${code ?? signal}`);
    } catch (_) {
      // The frame may already be gone.
    }
  });

  return {
    ok: true,
    token,
    sampleRate: 48000,
    channels: 1,
    sourceName: pending.sourceName,
  };
});

ipcMain.handle("vlanya-window-audio:stop", (event, token) => {
  if (!isWindowAudioIpcFrameAllowed(event.senderFrame)) return false;
  stopWindowAudioCapture(token);
  return true;
});

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Vlanya",
      submenu: [
        { label: "Обновить", accelerator: "Ctrl+R", click: () => mainWindow?.reload() },
        {
          label: "DevTools",
          accelerator: "Ctrl+Shift+I",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { type: "separator" },
        { label: "Свернуть в трей", click: hideMainWindow },
        { label: "Выйти", click: quitApp },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  app.setAppUserModelId("ru.vlanya.element");
  app.on("web-contents-created", (_event, contents) => {
    configureAppWebContents(contents);
  });
  Menu.setApplicationMenu(buildMenu());
  createTray();
  createMainWindow();
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (isQuitting) app.quit();
});
