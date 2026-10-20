"use strict";

const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeImage, Menu } = require("electron");
const path = require("path");
const { fetchCatalog, supportEmailBody, withAiSummary } = require("./engine");
const { runSmokeTest, markPosted } = require("./runner");
const { sendReport } = require("./feishu");

const ICON_PNG = path.join(__dirname, "build", "icon.png");
const ICON_ICNS = path.join(__dirname, "build", "icon.icns");
const APP_NAME = "TDengine All-in-One Smoketest";

let mainWindow = null;

function appIcon() {
  const file = process.platform === "darwin" ? ICON_ICNS : ICON_PNG;
  return nativeImage.createFromPath(file);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#070b14",
    title: APP_NAME,
    icon: appIcon(),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function installMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName(APP_NAME);
app.whenReady().then(() => {
  const icon = appIcon();
  if (process.platform === "darwin" && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: "TDengine",
    iconPath: ICON_PNG,
  });
  installMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("catalog:fetch", async () => fetchCatalog());

ipcMain.handle("checks:run", async (event, platforms) => {
  const report = await runSmokeTest({
    platforms,
    userDataDir: app.getPath("userData"),
    trigger: "manual",
    onProgress: (progress) => event.sender.send("checks:progress", progress),
  });
  const email = `${report.human.plain}\n\n${withAiSummary(supportEmailBody(report.catalog, report.results), report.aiSummary)}\n`;
  return { ...report, email };
});

ipcMain.handle("report:copy", async (_event, text) => {
  clipboard.writeText(text || "");
  return true;
});

ipcMain.handle("report:save", async (_event, payload) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath("desktop"), `tdengine-aio-smoketest-${Date.now()}.json`),
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (canceled || !filePath) return null;
  const fs = require("fs");
  const isTxt = filePath.endsWith(".txt");
  fs.writeFileSync(filePath, isTxt ? payload.email : JSON.stringify(payload, null, 2));
  if (!isTxt) {
    fs.writeFileSync(filePath.replace(/\.json$/i, ".txt"), payload.email);
  }
  return filePath;
});

ipcMain.handle("report:feishu", async (_event, payload) => {
  const sent = await sendReport(payload);
  markPosted(app.getPath("userData"), payload.hashCompare, "manual");
  return sent;
});
