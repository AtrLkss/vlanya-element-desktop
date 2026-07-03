const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  ipcMain,
  shell,
  session,
} = require("electron");

const CHAT_URL = "https://chat.vlanya.ru";
const ALLOWED_HOSTS = new Set([
  "chat.vlanya.ru",
  "call.vlanya.ru",
  "matrix.vlanya.ru",
  "vlanya.ru",
]);

let mainWindow = null;
let pickerWindow = null;
let currentPickerResolve = null;
let currentSources = [];

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

function getOriginFromDetails(details) {
  return (
    details?.requestingUrl ||
    details?.requestingOrigin ||
    details?.securityOrigin ||
    details?.embeddingOrigin ||
    ""
  );
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

      const streams = { video: source };
      if (picked.shareAudio && process.platform === "win32") {
        streams.audio = "loopback";
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      partition: "persist:vlanya-element",
      nodeIntegration: false,
      contextIsolation: false,
      nodeIntegrationInSubFrames: true,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.loadURL(CHAT_URL);
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
        { label: "Выйти", role: "quit" },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  app.setAppUserModelId("ru.vlanya.element");
  Menu.setApplicationMenu(buildMenu());
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
