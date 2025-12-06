const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getParentDirectory: (p) => ipcRenderer.invoke('get-parent-directory', p),
  getInitialDirectory: () => ipcRenderer.invoke('get-initial-directory'),
  getDirectory: () => ipcRenderer.invoke('get-directory'),
  getOwnershipStats: (dirPath) => ipcRenderer.invoke('get-ownership-stats', dirPath),
  wasCodeownersFound: () => ipcRenderer.invoke('was-codeowners-found'),
  getFiles: (dirPath) => ipcRenderer.invoke('get-files', dirPath),
  navigateTo: (newPath) => ipcRenderer.send('navigate-to', newPath),
  onDirectoryChanged: (callback) => ipcRenderer.on('directory-changed', (event, ...args) => callback(...args)),
  getAllOwners: () => ipcRenderer.invoke('get-all-owners'),
  assignOwner: (filePath, owner, isDirectory) => ipcRenderer.invoke('assign-owner', filePath, owner, isDirectory),
  removeOwner: (filePath, isDirectory) => ipcRenderer.invoke('remove-owner', filePath, isDirectory),
  joinPath: (...parts) => ipcRenderer.invoke('join-path', ...parts),
  getDebugInfo: () => ipcRenderer.invoke('get-debug-info'),
  needsDirectorySelection: () => ipcRenderer.invoke('needs-directory-selection'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getRuleInfo: (filePath, isDirectory) => ipcRenderer.invoke('get-rule-info', filePath, isDirectory),
  openFileInEditor: (filePath, lineNumber) => ipcRenderer.invoke('open-file-in-editor', filePath, lineNumber),
  getCodeownersContent: () => ipcRenderer.invoke('get-codeowners-content'),
  saveCodeownersContent: (content) => ipcRenderer.invoke('save-codeowners-content', content),
});