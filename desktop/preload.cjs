const { contextBridge, ipcRenderer } = require('electron');
const names = [
  'state',
  'scan',
  'analyze',
  'review-group',
  'confirm',
  'update',
  'definition',
  'delete',
  'sync',
  'open',
  'open-library',
  'relink',
];
const api = {};
for (const name of names)
  api[name] = (...args) => ipcRenderer.invoke(`atlas:${name}`, ...args);
api.on = (name, callback) => {
  if (!['state', 'progress', 'sync'].includes(name)) throw Error('事件无效');
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(`atlas:${name}`, listener);
  return () => ipcRenderer.removeListener(`atlas:${name}`, listener);
};
contextBridge.exposeInMainWorld('atlas', api);
