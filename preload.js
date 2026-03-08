const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  checkPdf2zh: () => ipcRenderer.invoke('check-pdf2zh'),
  startTranslation: (options) => ipcRenderer.invoke('start-translation', options),
  cancelTranslation: () => ipcRenderer.invoke('cancel-translation'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  checkPdf2zhUpdate: () => ipcRenderer.invoke('check-pdf2zh-update'),
  updatePdf2zh: () => ipcRenderer.invoke('update-pdf2zh'),
  checkEnvironment: () => ipcRenderer.invoke('check-environment'),
  setupEnvironment: () => ipcRenderer.invoke('setup-environment'),

  onTranslationLog: (callback) => {
    ipcRenderer.on('translation-log', (event, data) => callback(data));
  },
  onTranslationProgress: (callback) => {
    ipcRenderer.on('translation-progress', (event, data) => callback(data));
  },
  onTranslationTick: (callback) => {
    ipcRenderer.on('translation-tick', (event, data) => callback(data));
  },
  onTranslationGpu: (callback) => {
    ipcRenderer.on('translation-gpu', (event, data) => callback(data));
  },
  onSetupLog: (callback) => {
    ipcRenderer.on('setup-log', (event, data) => callback(data));
  },
  onSetupStep: (callback) => {
    ipcRenderer.on('setup-step', (event, data) => callback(data));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
