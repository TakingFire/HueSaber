const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

// Enable native File System Access API
app.commandLine.appendSwitch("enable-experimental-web-platform-features");

function createWindow() {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    },
    width: 760,
    minWidth: 640,
    maxWidth: 1000,
    height: 482,
    minHeight: 482,
    maxHeight: 482,
    frame: false,
    transparent: true,
  });

  win.loadFile(path.resolve(__dirname, 'index.html'));

  win.on('close', function(e) {
    e.preventDefault();
    win.webContents.send('close');
    ipcMain.on('close', function(event) {
      win.destroy();
    });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  ipcMain.on('resize', function(event, minw, minh, w, h, maxw, maxh) {
    win.setMinimumSize(minw, minh);
    win.setMaximumSize(maxw, maxh);
    win.setSize(w, h);
  });

  ipcMain.on('ontop', function(event, bool) {
    win.setAlwaysOnTop(bool);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
});
