import { BrowserWindow, app, session, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import * as configStore from './services/configStore';
import * as settings from './services/settings';
import * as vault from './services/vault';
import * as transfer from './services/transferService';

/**
 * Electron main process.
 *
 * Security posture:
 *  - `contextIsolation: true` and `nodeIntegration: false` — the renderer is a
 *    plain web page with no Node access, talking to this process only through
 *    the allow-list in preload.ts.
 *  - `sandbox: true` — the renderer runs in the OS sandbox.
 *  - A strict CSP with no remote origins: the UI loads no external scripts,
 *    fonts or images, so a compromised dependency has nowhere to exfiltrate to.
 *  - Navigation and new-window creation are blocked outright; links open in
 *    the user's real browser via a validated IPC call.
 */

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

// A second instance would race this one for the vault and history files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 720,
    show: false,
    backgroundColor: '#0d1117',
    title: 'Flash Sender by Nora',
    icon: path.join(__dirname, '../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Devtools are useful in development and are a liability in a packaged
      // build, where they would let anyone poke at the renderer's state.
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Refuse in-app navigation; this app has exactly one page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only https links, and only into the user's own browser.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The renderer needs no privileged web APIs.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function applyContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // In development Vite needs inline styles and eval for HMR; the packaged
    // build gets the strict policy.
    const policy = isDev
      ? "default-src 'self' 'unsafe-inline' data: blob: ws: http://localhost:*;" +
        " script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*;"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" +
        " img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none';" +
        " frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
}

async function bootstrap() {
  applyContentSecurityPolicy();
  registerIpc(() => mainWindow);

  const appSettings = await settings.getSettings();
  vault.setAutoLockSeconds(appSettings.autoLockSeconds);

  // Serve the cached configuration immediately, then refresh in the background
  // so a cold start works offline.
  await configStore.hydrate();

  createWindow();

  if (appSettings.apiBaseUrl && appSettings.hasApiKey) {
    try {
      const { config } = await configStore.refresh();
      await transfer.resumeUnsettled(config.assets, appSettings.minConfirmations);
    } catch {
      // Backend unreachable at startup; the UI shows the cached list and the
      // poller will pick up the refresh when it comes back.
      const cached = configStore.getCached().config;
      if (cached) {
        await transfer.resumeUnsettled(cached.assets, appSettings.minConfirmations);
      }
    }
    await configStore.startPolling();
  }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  // Lock the vault before exiting so the key does not survive in a lingering
  // process.
  vault.lock();
  configStore.stopPolling();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  vault.lock();
});
