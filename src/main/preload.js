'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ohdap', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  setEditorShortcutScope: (scope) => ipcRenderer.invoke('editor:shortcut-scope', scope),
  requestUpdateRestart: () => ipcRenderer.invoke('app:restart-for-update'),
  updateRestartReady: (state) => ipcRenderer.invoke('app:restart-ready', state),
  finishUpdateRestart: (result) => ipcRenderer.invoke('app:finish-update-restart', result),
  reportRestartState: (state) => ipcRenderer.send('app:restart-state', state),
  onUpdateAvailable: (callback) => {
    const listener = (_e, version) => callback(version);
    ipcRenderer.on('app:update-available', listener);
    return () => ipcRenderer.removeListener('app:update-available', listener);
  },
  onUpdateRestart: (callback) => {
    const listener = (_e, request) => callback(request);
    ipcRenderer.on('app:update-restart', listener);
    return () => ipcRenderer.removeListener('app:update-restart', listener);
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 책 (문제집 + 답지 + 분석 결과)
  listBooks: () => ipcRenderer.invoke('books:list'),
  createBook: (name, shared, subject) => ipcRenderer.invoke('books:create', { name, shared, subject }), // shared 를 빼면 학원 공유, subject: math · english · korean (계약한 과목만)
  getBook: (id) => ipcRenderer.invoke('books:get', id),
  saveBook: (book) => ipcRenderer.invoke('books:save', book),
  saveBookSync: (book) => ipcRenderer.sendSync('books:saveSync', book),
  deleteBook: (id) => ipcRenderer.invoke('books:delete', id),
  renameBookItems: (bookId, renames, removed) => ipcRenderer.invoke('books:renameItems', { bookId, renames, removed }),
  copyBook: (id) => ipcRenderer.invoke('books:copy', id), // 남의 책을 내 책으로
  setBookShared: (id, shared) => ipcRenderer.invoke('books:setShared', { id, shared }), // 학원 공유 켜고 끄기 (만든 사람만)
  ensureBookFiles: (id) => ipcRenderer.invoke('books:ensureFiles', id), // 아직 받지 않은 원본 받기

  // 학생 오답노트 (책에서 고른 문항)
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (args) => ipcRenderer.invoke('notes:create', args),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  // base: 열 때 받은 내용 (그사이 다른 사람이 고쳤으면 합쳐서 저장 → { merged: true })
  saveNote: (note, base) => ipcRenderer.invoke('notes:save', note, base),
  saveNoteSync: (note, base) => ipcRenderer.sendSync('notes:saveSync', note, base),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),

  // 학생 명단 (학원: 통합 클라우드 명단 — 지운 학생도 deletedAt 과 함께)
  listStudents: () => ipcRenderer.invoke('students:list'),
  saveStudent: (student) => ipcRenderer.invoke('students:save', student), // rev 가 있으면 고치기
  deleteStudent: (id) => ipcRenderer.invoke('students:delete', id),
  restoreStudent: (id) => ipcRenderer.invoke('students:restore', id),
  listMembers: () => ipcRenderer.invoke('students:members'), // 학원 사람 (담당 선생님)

  // 다른 컴퓨터·선생님이 바꾼 데이터가 들어옴 { books, notes, students, settings }
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
  importFiles: (bookId, role, paths, add) => ipcRenderer.invoke('files:import', { bookId, role, paths, add }), // add: 지금 파일 뒤에 더하기
  savePhotoPages: (photo) => ipcRenderer.invoke('files:photo', photo),
  commitFileImport: (token, book) => ipcRenderer.invoke('files:commit', { token, book }),
  discardFileImport: (token) => ipcRenderer.invoke('files:discard', token),
  pathForFile: (file) => webUtils.getPathForFile(file),
  savePdf: (defaultName, data) => ipcRenderer.invoke('files:savePdf', { defaultName, data }),
  saveFile: ({ defaultName, data, filters, title }) => ipcRenderer.invoke('files:saveFile', { defaultName, data, filters, title }),
  getTranscripts: (bookId) => ipcRenderer.invoke('books:getTranscripts', bookId),
  saveTranscripts: (bookId, data) => ipcRenderer.invoke('books:saveTranscripts', { bookId, data }),
  getAnswers: (bookId) => ipcRenderer.invoke('answers:get', bookId),
  saveAnswer: (bookId, itemId, data) => ipcRenderer.invoke('answers:save', { bookId, itemId, data }),
  saveAnswerSync: (bookId, itemId, data) => ipcRenderer.sendSync('answers:saveSync', { bookId, itemId, data }),
  putAnswerImage: (bookId, data) => ipcRenderer.invoke('answers:putImage', { bookId, data }),
  getAnswerImage: (bookId, file) => ipcRenderer.invoke('answers:getImage', { bookId, file }),
  renderAnswerPdf: (args) => ipcRenderer.invoke('answers:renderPdf', args),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openCloud: () => ipcRenderer.invoke('cloud:open'), // 통합 클라우드 창 (업데이트·계정은 거기서)
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
  openHelp: (section) => ipcRenderer.invoke('app:openHelp', section),
});
