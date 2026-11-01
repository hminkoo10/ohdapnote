'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ohdap', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 책 (문제집 + 답지 + 분석 결과)
  listBooks: () => ipcRenderer.invoke('books:list'),
  createBook: (name) => ipcRenderer.invoke('books:create', { name }),
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  saveBook: (book) => ipcRenderer.invoke('books:save', book),
  saveBookSync: (book) => ipcRenderer.sendSync('books:saveSync', book),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  renameBookItems: (bookId, renames, removed) => ipcRenderer.invoke('books:renameItems', { bookId, renames, removed }),

  // 학생 오답노트 (책에서 고른 문항)
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (args) => ipcRenderer.invoke('notes:create', args),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),
  saveNoteSync: (note) => ipcRenderer.sendSync('notes:saveSync', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),

  pickFiles: (title) => ipcRenderer.invoke('files:pick', { title }),
  importFiles: (bookId, role, paths) => ipcRenderer.invoke('files:import', { bookId, role, paths }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  savePdf: (defaultName, data) => ipcRenderer.invoke('files:savePdf', { defaultName, data }),
  saveFile: ({ defaultName, data, filters, title }) => ipcRenderer.invoke('files:saveFile', { defaultName, data, filters, title }),
  getTranscripts: (bookId) => ipcRenderer.invoke('books:getTranscripts', bookId),
  saveTranscripts: (bookId, data) => ipcRenderer.invoke('books:saveTranscripts', { bookId, data }),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  geminiGenerate: (args) => ipcRenderer.invoke('gemini:generate', args),
  geminiAbort: (requestId) => ipcRenderer.invoke('gemini:abort', requestId),
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
