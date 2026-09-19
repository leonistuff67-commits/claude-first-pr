/**
 * JARVIS for Windows — the main process.
 *
 * This is the only place with access to the machine. The renderer is the same
 * JARVIS you get in a browser, loaded from disk, with no node integration and
 * context isolation on; it can only reach the outside through the narrow bridge
 * in preload.js, and every call across that bridge lands in a handler here that
 * checks permission before doing anything.
 *
 * The capabilities are deliberately bounded. JARVIS can start a program that is
 * already installed, open a file, use the clipboard and post a notification.
 * There is no handler that runs a command, types into another window or reads
 * the screen, so there is no path to one — a model that decides it wants to do
 * those things simply has nothing to call.
 */
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, clipboard, Notification, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as perms from './permissions.js';
import * as apps from './apps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const GRANTS_FILE = path.join(app.getPath('userData'), 'permissions.json');

let win = null;
let tray = null;
let grants = perms.createGrants();
let installed = [];

async function loadGrants() {
  try {
    grants = perms.normalise(JSON.parse(await fs.readFile(GRANTS_FILE, 'utf8')));
  } catch {
    grants = perms.createGrants();
  }
}

async function saveGrants() {
  await fs.mkdir(path.dirname(GRANTS_FILE), { recursive: true });
  await fs.writeFile(GRANTS_FILE, `${JSON.stringify(grants, null, 2)}\n`, 'utf8');
}

/**
 * The gate. Everything privileged goes through here, and it either already has
 * an answer from the user or it stops and asks for one.
 */
async function authorise(capability, target = null) {
  if (perms.isGranted(grants, capability, target)) return true;
  if (grants.capabilities[capability] === 'denied') return false;

  const request = perms.describeRequest(capability, target);
  if (!request) return false;

  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Not this time'],
    defaultId: 1,
    cancelId: 1,
    title: request.title,
    message: request.message,
    detail: request.detail,
    checkboxLabel: 'Remember this choice',
    checkboxChecked: true,
    noLink: true,
  });

  const allowed = response === 0;
  grants = perms.grant(grants, capability, target, allowed ? 'allowed' : 'denied', checkboxChecked);
  if (checkboxChecked) await saveGrants();
  return allowed;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    backgroundColor: '#04070c',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  // A link in the transcript opens in the real browser, never inside JARVIS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Nothing navigates this window away from the app it was loaded with.
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.on('close', (event) => {
    // Closing hides it; JARVIS is meant to stay listening in the tray.
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function summon() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) return win.hide();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('JARVIS');
  tray.on('click', summon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show JARVIS', click: summon },
    { type: 'separator' },
    {
      label: 'Revoke all permissions',
      click: async () => {
        grants = perms.createGrants();
        await saveGrants();
        win?.webContents.send('permissions:changed');
        new Notification({ title: 'JARVIS', body: 'All permissions revoked.' }).show();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// --- the bridge -------------------------------------------------------------

ipcMain.handle('apps:list', async () => installed.map((a) => a.name));

ipcMain.handle('apps:open', async (_event, name) => {
  const found = apps.resolve(installed, String(name || ''));
  if (!found.ok) return { ok: false, error: found.reason };
  if (!(await authorise('apps.open', found.app.name))) {
    return { ok: false, error: `You did not approve opening ${found.app.name}.` };
  }
  const error = await shell.openPath(found.app.path);
  return error ? { ok: false, error } : { ok: true, opened: found.app.name };
});

ipcMain.handle('files:open', async (_event, target) => {
  const raw = String(target || '');
  if (!raw) return { ok: false, error: 'No file given.' };
  // Resolve first, then ask about the thing that will actually be opened.
  const resolved = path.resolve(raw);
  try {
    await fs.access(resolved);
  } catch {
    return { ok: false, error: `No such file: ${resolved}` };
  }
  if (!(await authorise('files.open', resolved))) {
    return { ok: false, error: 'You did not approve opening that file.' };
  }
  const error = await shell.openPath(resolved);
  return error ? { ok: false, error } : { ok: true, opened: resolved };
});

ipcMain.handle('clipboard:read', async () => {
  if (!(await authorise('clipboard.read'))) return { ok: false, error: 'Clipboard access not approved.' };
  return { ok: true, text: clipboard.readText() };
});

ipcMain.handle('clipboard:write', async (_event, text) => {
  if (!(await authorise('clipboard.write'))) return { ok: false, error: 'Clipboard access not approved.' };
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

ipcMain.handle('notify', async (_event, { title, body } = {}) => {
  if (!(await authorise('notify'))) return { ok: false, error: 'Notifications not approved.' };
  new Notification({ title: String(title || 'JARVIS'), body: String(body || '') }).show();
  return { ok: true };
});

ipcMain.handle('permissions:list', async () => perms.listGrants(grants));

ipcMain.handle('permissions:revoke', async (_event, { capability = null, target = null } = {}) => {
  grants = perms.revoke(grants, capability, target);
  await saveGrants();
  return perms.listGrants(grants);
});

// --- lifecycle --------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', summon);

  app.whenReady().then(async () => {
    await loadGrants();
    installed = await apps.discover();
    createWindow();
    createTray();
    // Ctrl+Shift+J from anywhere brings JARVIS forward.
    globalShortcut.register('CommandOrControl+Shift+J', summon);
  });

  app.on('window-all-closed', () => {
    // Stays in the tray on Windows; that is the point of a resident assistant.
    if (process.platform === 'darwin') return;
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
