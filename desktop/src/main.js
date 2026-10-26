const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Native Linux optimizations: Wayland auto-detection, hardware acceleration, smooth audio playback
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let currentTrackMeta = { title: 'Recro', artist: 'Music & Radio Player', isPlaying: false };

function createTray(win) {
  const iconPath = path.join(__dirname, '../assets/icon-32.png');
  const trayIcon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(trayIcon);
  tray.setToolTip('Recro — Lossless Music Player');

  updateTrayMenu();

  tray.on('click', () => {
    if (win.isVisible()) {
      if (win.isFocused()) {
        win.hide();
      } else {
        win.focus();
      }
    } else {
      win.show();
      win.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const trackLabel = currentTrackMeta.title 
    ? `${currentTrackMeta.title} — ${currentTrackMeta.artist}`
    : 'Recro Player';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: trackLabel.length > 36 ? trackLabel.slice(0, 33) + '...' : trackLabel,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: currentTrackMeta.isPlaying ? 'Пауза' : 'Воспроизведение',
      click: () => {
        mainWindow?.webContents.send('recro:media-command', 'toggle-play');
      }
    },
    {
      label: 'Следующий трек',
      click: () => {
        mainWindow?.webContents.send('recro:media-command', 'next');
      }
    },
    {
      label: 'Предыдущий трек',
      click: () => {
        mainWindow?.webContents.send('recro:media-command', 'prev');
      }
    },
    { type: 'separator' },
    {
      label: mainWindow?.isVisible() ? 'Скрыть окно' : 'Показать Recro',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
        updateTrayMenu();
      }
    },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function registerMediaShortcuts(win) {
  try {
    globalShortcut.register('MediaPlayPause', () => {
      win.webContents.send('recro:media-command', 'toggle-play');
    });
    globalShortcut.register('MediaNextTrack', () => {
      win.webContents.send('recro:media-command', 'next');
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      win.webContents.send('recro:media-command', 'prev');
    });
  } catch (err) {
    console.warn('[Desktop] Media shortcuts registration note:', err);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '../assets/icon-512.png');
  const appIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 420,
    minHeight: 580,
    title: 'Recro',
    icon: appIcon,
    backgroundColor: '#0d0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // Do not throttle background audio playback!
      webSecurity: true
    }
  });

  createTray(mainWindow);
  registerMediaShortcuts(mainWindow);

  // Determine URL to load
  const targetUrl = process.env.RECRO_URL || process.env.APP_URL || 'https://recro.online';
  const localDist = path.join(__dirname, '../../dist_frontend/index.html');

  if (process.env.RECRO_LOCAL === '1' && fs.existsSync(localDist)) {
    mainWindow.loadFile(localDist);
  } else {
    mainWindow.loadURL(targetUrl).catch(() => {
      if (fs.existsSync(localDist)) {
        mainWindow.loadFile(localDist);
      }
    });
  }

  // Intercept close to minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
      return false;
    }
  });

  mainWindow.on('show', () => updateTrayMenu());
  mainWindow.on('hide', () => updateTrayMenu());

  // Handle external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers from Web App
ipcMain.on('recro:playback-state', (_event, state) => {
  currentTrackMeta.isPlaying = state === 'playing';
  updateTrayMenu();
});

ipcMain.on('recro:track-info', (_event, track) => {
  if (track) {
    currentTrackMeta.title = track.title || 'Recro';
    currentTrackMeta.artist = track.artist || 'Music Player';
  }
  updateTrayMenu();
});

ipcMain.on('recro:minimize-tray', () => {
  mainWindow?.hide();
  updateTrayMenu();
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
