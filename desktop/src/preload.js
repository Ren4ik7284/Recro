const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  isElectron: true,
  platform: 'linux',
  sendPlaybackState: (state) => ipcRenderer.send('recro:playback-state', state),
  sendTrackInfo: (track) => ipcRenderer.send('recro:track-info', track),
  onMediaCommand: (callback) => {
    ipcRenderer.on('recro:media-command', (_event, cmd) => callback(cmd));
  },
  minimizeToTray: () => ipcRenderer.send('recro:minimize-tray')
});
