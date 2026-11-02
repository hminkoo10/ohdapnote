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
  copyBook: (id) => ipcRenderer.invoke('books:copy', id), // 남의 책을 내 책으로
  ensureBookFiles: (id) => ipcRenderer.invoke('books:ensureFiles', id), // 아직 받지 않은 원본 받기

  // 학생 오답노트 (책에서 고른 문항)
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (args) => ipcRenderer.invoke('notes:create', args),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  saveNote: (note) => ipcRenderer.invoke('notes:save', note),
  saveNoteSync: (note) => ipcRenderer.sendSync('notes:saveSync', note),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),

  // 학원 공용 학생 명단
  listStudents: () => ipcRenderer.invoke('students:list'),
  saveStudent: (student) => ipcRenderer.invoke('students:save', student),
  deleteStudent: (id) => ipcRenderer.invoke('students:delete', id),

  // 학원 공용 AI 키 (원장만)
  getAcademyAi: () => ipcRenderer.invoke('academy:getAi'),
  setAcademyAi: (ai) => ipcRenderer.invoke('academy:setAi', ai),

  // 다른 컴퓨터·선생님이 바꾼 데이터가 들어옴 { books, notes, students, academy, settings }
  onDataChanged: (callback) => {
    const listener = (_e, change) => callback(change);
    ipcRenderer.on('data:changed', listener);
    return () => ipcRenderer.removeListener('data:changed', listener);
  },
  // 아직 받지 않은 교재 원본을 받는 중 / 다 받음
  onFilesFetching: (callback) => {
    const on = (_e, info) => callback({ ...info, done: false });
    const off = (_e, info) => callback({ ...info, done: true });
    ipcRenderer.on('files:fetching', on);
    ipcRenderer.on('files:fetched', off);
    return () => {
      ipcRenderer.removeListener('files:fetching', on);
      ipcRenderer.removeListener('files:fetched', off);
    };
  },

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

  // AI (Gemini · OpenAI 호환 · Claude · ChatGPT 구독)
  aiGenerate: (args) => ipcRenderer.invoke('ai:generate', args),
  aiAbort: (requestId) => ipcRenderer.invoke('ai:abort', requestId),
  aiListModels: (args) => ipcRenderer.invoke('ai:listModels', args),
  aiCodexStatus: (path) => ipcRenderer.invoke('ai:codexStatus', { path }),

  // 수식 인식 (AI 없이 내 컴퓨터에서 — 모델을 한 번 받아 둠)
  mathocrStatus: () => ipcRenderer.invoke('mathocr:status'),
  mathocrInstall: () => ipcRenderer.invoke('mathocr:install'),
  mathocrCancelInstall: () => ipcRenderer.invoke('mathocr:cancelInstall'),
  mathocrRecognize: ({ images, requestId, maxTokens } = {}) => ipcRenderer.invoke('mathocr:recognize', { images, requestId, maxTokens }),
  mathocrAbort: (requestId) => ipcRenderer.invoke('mathocr:abort', requestId),
  onMathocrProgress: (callback) => {
    const listener = (_e, progress) => callback(progress);
    ipcRenderer.on('mathocr:progress', listener);
    return () => ipcRenderer.removeListener('mathocr:progress', listener);
  },

  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  onUpdateStatus: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
