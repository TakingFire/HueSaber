const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    },
    width: 800,
    minWidth: 600,
    maxWidth: 1000,
    height: 490,
    minHeight: 490,
    maxHeight: 490,
    frame: false,
    transparent: true,
  });

  win.loadFile(path.resolve(__dirname, 'index.html'));

  win.on('close', function(e) {
    win.webContents.send('close');
  })

  ipcMain.on('resize', function(event, minw, minh, w, h, maxw, maxh) {
    win.setMinimumSize(minw, minh);
    win.setMaximumSize(maxw, maxh);
    win.setSize(w, h);
  })
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  })
})

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
})
