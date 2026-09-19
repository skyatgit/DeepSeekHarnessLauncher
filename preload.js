// 渲染进程安全桥接：只暴露白名单 API
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcher', {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  update: () => ipcRenderer.invoke('update'),
  openWeb: () => ipcRenderer.invoke('open-web'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  setAutoStartDsh: (v) => ipcRenderer.invoke('set-auto-start-dsh', !!v),
  setOpenAtLogin: (v) => ipcRenderer.invoke('set-open-at-login', !!v),
  exit: () => ipcRenderer.invoke('exit-app'),
  getEnv: () => ipcRenderer.invoke('get-env'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log-line', (_e, item) => cb(item)),
  onEnv: (cb) => ipcRenderer.on('env', (_e, items) => cb(items))
})
