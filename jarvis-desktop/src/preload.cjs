/**
 * The entire surface the web app can see. Nothing else crosses from the page
 * into the machine: no require, no node globals, no arbitrary channel. Each
 * function here maps to one handler in main.js, and every one of those checks
 * permission first.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  version: 1,
  listApps: () => ipcRenderer.invoke('apps:list'),
  openApp: (name) => ipcRenderer.invoke('apps:open', name),
  openFile: (target) => ipcRenderer.invoke('files:open', target),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  listPermissions: () => ipcRenderer.invoke('permissions:list'),
  revokePermission: (capability, target) =>
    ipcRenderer.invoke('permissions:revoke', { capability, target }),
  onPermissionsChanged: (fn) => ipcRenderer.on('permissions:changed', () => fn()),
});
