const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const localElectron = process.platform === "win32"
  ? path.join(root, "node_modules", ".bin", "electron.cmd")
  : path.join(root, "node_modules", ".bin", "electron");
const command = existsSync(localElectron) ? localElectron : "electron";
const child = spawn(command, [path.join(__dirname, "main.cjs")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", () => {
  console.error("Electron is not installed. Install it with: npm install --save-dev electron");
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 0;
});
