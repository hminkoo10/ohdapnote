'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ohdap', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (name) => ipcRenderer.invoke('projects:create', { name }),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  saveProjectSync: (project) => ipcRenderer.sendSync('projects:saveSync', project),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),

  pickFiles: (title) => ipcRenderer.invoke('files:pick', { title }),
  importFiles: (projectId, role, paths) => ipcRenderer.invoke('files:import', { projectId, role, paths }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  savePdf: (defaultName, data) => ipcRenderer.invoke('files:savePdf', { defaultName, data }),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  geminiGenerate: (args) => ipcRenderer.invoke('gemini:generate', args),
  geminiListModels: (apiKey) => ipcRenderer.invoke('gemini:listModels', { apiKey }),

  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  onUpdateStatus: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
