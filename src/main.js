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
let currentPickerRequestInfo = null;
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

function sortDisplaySources(sources) {
  return sources.slice().sort((a, b) => {
    const aScreen = a.id.startsWith("screen:");
    const bScreen = b.id.startsWith("screen:");
    if (aScreen !== bScreen) return aScreen ? 1 : -1;
    return (a.name || "").localeCompare(b.name || "");
  });
}

async function enumerateDisplaySources() {
  return desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 420, height: 260 },
    fetchWindowIcons: true,
  });
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
      const sources = await enumerateDisplaySources();

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
      if (picked.shareAudio && isScreenSource && process.platform === "win32") {
        streams.audio = "loopback";
        pendingWindowAudioCapture = null;
      } else if (isWindowSource && process.platform === "win32") {
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

function setCurrentDisplaySources(sources) {
  currentSources = sortDisplaySources(sources).map(sourceToView);
  return currentSources;
}

function sendPickerSources() {
  if (!pickerWindow || pickerWindow.isDestroyed()) return;
  pickerWindow.webContents.send("display-sources", {
    sources: currentSources,
    platform: process.platform,
    requestInfo: currentPickerRequestInfo,
  });
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderPickerHtml(initialSources, platform) {
  const initialLiteSources = initialSources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.type,
    thumbnail: "",
  }));

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>&#1042;&#1099;&#1073;&#1086;&#1088; &#1076;&#1077;&#1084;&#1086;&#1085;&#1089;&#1090;&#1088;&#1072;&#1094;&#1080;&#1080;</title>
    <style>
      :root { color-scheme: dark; --bg: #121419; --panel: #1b1e26; --panel-2: #252a34; --line: #333947; --text: #f3f6fb; --muted: #a3adbc; --accent: #45d483; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button, input { font: inherit; }
      .picker { min-height: 100vh; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr); gap: 14px; padding: 18px; }
      header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
      h1, p { margin: 0; }
      h1 { font-size: 24px; }
      p { margin-top: 4px; color: var(--muted); }
      .ghost { height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); cursor: pointer; }
      .ghost:disabled { opacity: 0.55; cursor: default; }
      .audio-row { height: 44px; display: flex; gap: 10px; align-items: center; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); }
      .audio-row input { width: 18px; height: 18px; accent-color: var(--accent); }
      .source-tabs { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .source-tab { height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); cursor: pointer; }
      .source-tab:hover, .source-tab:focus, .source-tab.is-active { border-color: var(--accent); color: var(--text); outline: none; }
      .source-tab.is-active { background: rgba(69, 212, 131, 0.14); }
      .source-refresh { margin-left: auto; }
      .empty-state { padding: 18px; border: 1px dashed var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.03); color: var(--muted); }
      .sources { min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); align-content: start; gap: 12px; }
      .source { min-width: 0; display: grid; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); text-align: left; cursor: pointer; }
      .source:hover, .source:focus { border-color: var(--accent); background: var(--panel-2); outline: none; }
      .thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 6px; background: #080a0e; }
      .source-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 720; }
      .source-type { color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <main class="picker">
      <header>
        <div>
          <h1>&#1063;&#1090;&#1086; &#1087;&#1086;&#1082;&#1072;&#1079;&#1072;&#1090;&#1100;?</h1>
          <p>&#1057;&#1085;&#1072;&#1095;&#1072;&#1083;&#1072; &#1087;&#1086;&#1082;&#1072;&#1079;&#1072;&#1085;&#1099; &#1086;&#1082;&#1085;&#1072;. &#1045;&#1089;&#1083;&#1080; &#1085;&#1091;&#1078;&#1085;&#1086;&#1075;&#1086; &#1086;&#1082;&#1085;&#1072; &#1085;&#1077;&#1090;, &#1085;&#1072;&#1078;&#1084;&#1080; &#171;&#1054;&#1073;&#1085;&#1086;&#1074;&#1080;&#1090;&#1100;&#187;.</p>
        </div>
        <button id="cancelButton" class="ghost" type="button">&#1054;&#1090;&#1084;&#1077;&#1085;&#1072;</button>
      </header>
      <label id="audioRow" class="audio-row">
        <input id="shareAudioInput" type="checkbox" checked />
        <span>&#1055;&#1077;&#1088;&#1077;&#1076;&#1072;&#1074;&#1072;&#1090;&#1100; &#1079;&#1074;&#1091;&#1082; Windows</span>
      </label>
      <nav class="source-tabs" aria-label="type">
        <button class="source-tab is-active" type="button" data-filter="window">&#1054;&#1082;&#1085;&#1072;</button>
        <button class="source-tab" type="button" data-filter="screen">&#1069;&#1082;&#1088;&#1072;&#1085;&#1099;</button>
        <button class="source-tab" type="button" data-filter="all">&#1042;&#1089;&#1077;</button>
        <button id="refreshButton" class="ghost source-refresh" type="button">&#1054;&#1073;&#1085;&#1086;&#1074;&#1080;&#1090;&#1100;</button>
      </nav>
      <div id="emptyState" class="empty-state" hidden></div>
      <section id="sourcesList" class="sources"></section>
    </main>
    <template id="sourceTemplate">
      <button class="source" type="button">
        <img class="thumb" alt="" />
        <span class="source-title"></span>
        <span class="source-type"></span>
      </button>
    </template>
    <script>
      (() => {
        const initialSources = ${safeJsonForScript(initialLiteSources)};
        const initialPlatform = ${safeJsonForScript(platform)};
        const labels = {
          window: "\\u041e\\u043a\\u043d\\u0430",
          screen: "\\u042d\\u043a\\u0440\\u0430\\u043d\\u044b",
          all: "\\u0412\\u0441\\u0435",
          sourceWindow: "\\u041e\\u043a\\u043d\\u043e",
          sourceScreen: "\\u042d\\u043a\\u0440\\u0430\\u043d",
          noWindows: "\\u041e\\u043a\\u043d\\u0430 \\u043d\\u0435 \\u043d\\u0430\\u0439\\u0434\\u0435\\u043d\\u044b. \\u0420\\u0430\\u0437\\u0432\\u0435\\u0440\\u043d\\u0438 \\u043d\\u0443\\u0436\\u043d\\u043e\\u0435 \\u043e\\u043a\\u043d\\u043e, \\u0443\\u0431\\u0435\\u0440\\u0438 \\u0435\\u0433\\u043e \\u0438\\u0437 \\u0442\\u0440\\u0435\\u044f \\u0438 \\u043d\\u0430\\u0436\\u043c\\u0438 \\u00ab\\u041e\\u0431\\u043d\\u043e\\u0432\\u0438\\u0442\\u044c\\u00bb.",
          noScreens: "\\u042d\\u043a\\u0440\\u0430\\u043d\\u044b \\u043d\\u0435 \\u043d\\u0430\\u0439\\u0434\\u0435\\u043d\\u044b. \\u041f\\u043e\\u043f\\u0440\\u043e\\u0431\\u0443\\u0439 \\u043d\\u0430\\u0436\\u0430\\u0442\\u044c \\u00ab\\u041e\\u0431\\u043d\\u043e\\u0432\\u0438\\u0442\\u044c\\u00bb.",
          noSources: "\\u041d\\u0435\\u0442 \\u0438\\u0441\\u0442\\u043e\\u0447\\u043d\\u0438\\u043a\\u043e\\u0432 \\u0434\\u043b\\u044f \\u0434\\u0435\\u043c\\u043e\\u043d\\u0441\\u0442\\u0440\\u0430\\u0446\\u0438\\u0438. \\u041f\\u043e\\u043f\\u0440\\u043e\\u0431\\u0443\\u0439 \\u043d\\u0430\\u0436\\u0430\\u0442\\u044c \\u00ab\\u041e\\u0431\\u043d\\u043e\\u0432\\u0438\\u0442\\u044c\\u00bb.",
          nonWindowsAudio: "\\u0421\\u0438\\u0441\\u0442\\u0435\\u043c\\u043d\\u044b\\u0439 \\u0437\\u0432\\u0443\\u043a \\u0434\\u043e\\u0441\\u0442\\u0443\\u043f\\u0435\\u043d \\u0442\\u043e\\u043b\\u044c\\u043a\\u043e \\u043d\\u0430 Windows",
        };
        const list = document.getElementById("sourcesList");
        const template = document.getElementById("sourceTemplate");
        const shareAudioInput = document.getElementById("shareAudioInput");
        const audioRow = document.getElementById("audioRow");
        const cancelButton = document.getElementById("cancelButton");
        const refreshButton = document.getElementById("refreshButton");
        const emptyState = document.getElementById("emptyState");
        const tabs = Array.from(document.querySelectorAll(".source-tab"));
        let allSources = Array.isArray(initialSources) ? initialSources : [];
        let platformName = initialPlatform;
        let activeFilter = "window";

        const bridge = window.vlanyaPicker;
        cancelButton.addEventListener("click", () => bridge?.cancel?.());
        const filterSources = () => activeFilter === "all" ? allSources : allSources.filter((source) => source.type === activeFilter);
        const updateTabs = () => {
          const counts = {
            window: allSources.filter((source) => source.type === "window").length,
            screen: allSources.filter((source) => source.type === "screen").length,
            all: allSources.length,
          };
          for (const tab of tabs) {
            const filter = tab.dataset.filter;
            tab.classList.toggle("is-active", filter === activeFilter);
            tab.textContent = labels[filter] + " " + (counts[filter] || 0);
          }
        };
        const updateEmptyState = (sources) => {
          emptyState.hidden = Boolean(sources.length);
          emptyState.textContent = sources.length ? "" : activeFilter === "window" ? labels.noWindows : activeFilter === "screen" ? labels.noScreens : labels.noSources;
        };
        const renderSources = () => {
          const sources = filterSources();
          list.innerHTML = "";
          updateTabs();
          updateEmptyState(sources);
          for (const source of sources) {
            const node = template.content.firstElementChild.cloneNode(true);
            const image = node.querySelector(".thumb");
            if (source.thumbnail) image.src = source.thumbnail;
            else image.removeAttribute("src");
            node.querySelector(".source-title").textContent = source.name || source.id;
            node.querySelector(".source-type").textContent = source.type === "screen" ? labels.sourceScreen : labels.sourceWindow;
            node.addEventListener("click", () => {
              const canShareAudio = platformName === "win32";
              bridge?.choose?.({ sourceId: source.id, shareAudio: canShareAudio && shareAudioInput.checked });
            });
            list.append(node);
          }
        };
        for (const tab of tabs) {
          tab.addEventListener("click", () => {
            activeFilter = tab.dataset.filter || "window";
            renderSources();
          });
        }
        refreshButton.addEventListener("click", async () => {
          refreshButton.disabled = true;
          try { await bridge?.refresh?.(); }
          finally { refreshButton.disabled = false; }
        });
        bridge?.onSources?.(({ sources, platform }) => {
          allSources = Array.isArray(sources) ? sources : [];
          platformName = platform;
          if (platform !== "win32") {
            shareAudioInput.checked = false;
            shareAudioInput.disabled = true;
            audioRow.querySelector("span").textContent = labels.nonWindowsAudio;
          }
          renderSources();
        });
        renderSources();
      })();
    </script>
  </body>
</html>`;
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

  currentPickerRequestInfo = requestInfo;
  setCurrentDisplaySources(sources);

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
    pickerWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.warn("picker failed to load:", code, description, url);
    });
    pickerWindow.webContents.on("render-process-gone", (_event, details) => {
      console.warn("picker renderer gone:", details);
    });
    pickerWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) console.warn(`picker console: ${message} (${sourceId}:${line})`);
    });
    pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPickerHtml(currentSources, process.platform))}`);
    pickerWindow.webContents.once("did-finish-load", () => {
      sendPickerSources();
      pickerWindow?.webContents.executeJavaScript("document.body && document.body.innerText ? document.body.innerText.slice(0, 120) : ''", true)
        .then((text) => {
          if (!text || !text.trim()) console.warn("picker loaded but body text is empty");
        })
        .catch((error) => console.warn("picker body check failed:", error?.message || error));
    });
    pickerWindow.on("closed", () => {
      pickerWindow = null;
      currentSources = [];
      currentPickerRequestInfo = null;
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
  currentPickerRequestInfo = null;
  if (pickerWindow) {
    pickerWindow.close();
    pickerWindow = null;
  }
  if (resolve) resolve(selection);
});

ipcMain.handle("picker:cancel", () => {
  const resolve = currentPickerResolve;
  currentPickerResolve = null;
  currentPickerRequestInfo = null;
  if (pickerWindow) {
    pickerWindow.close();
    pickerWindow = null;
  }
  if (resolve) resolve(null);
});

ipcMain.handle("picker:refresh", async () => {
  if (!pickerWindow || pickerWindow.isDestroyed()) return { ok: false, error: "picker-closed" };
  try {
    const sources = await enumerateDisplaySources();
    setCurrentDisplaySources(sources);
    sendPickerSources();
    return { ok: true, count: currentSources.length };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
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
