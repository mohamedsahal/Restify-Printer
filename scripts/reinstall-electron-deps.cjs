/**
 * Fixes npm EBUSY on Windows when updating `electron`: another process holds
 * default_app.asar (usually this app running via `npm start`, or a stray Electron).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

const RETRIES = 8;
const DELAY_SEC = 2;

function killProjectElectronWindows() {
  if (process.platform !== 'win32') return;
  const rootEsc = root.replace(/'/g, "''");
  const script = [
    `$base = '${rootEsc}'`,
    'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force',
    'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -and ($_.CommandLine -like ("*" + $base + "*electron*")) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'inherit',
    cwd: root,
  });
}

function waitSeconds(n) {
  if (process.platform === 'win32') {
    spawnSync('timeout', ['/t', String(n), '/nobreak'], { stdio: 'ignore', shell: true });
  } else {
    spawnSync('sleep', [String(n)], { stdio: 'ignore' });
  }
}

function tryRemoveElectronDir() {
  if (!fs.existsSync(electronDir)) return true;
  fs.rmSync(electronDir, { recursive: true, force: true });
  return !fs.existsSync(electronDir);
}

console.log(
  '\nIf removal fails with EBUSY:\n' +
    '  1. Restify Printer: tray icon → Quit (closing the window is not enough).\n' +
    '  2. Stop any terminal running: npm start / npm run dev in this folder.\n' +
    '  3. Task Manager → end "Restify Printer" / stray "Electron" if needed.\n' +
    '  4. Close Cursor/VS Code windows that have this folder open, or reboot, then run again.\n'
);

if (process.platform === 'win32') {
  console.log('Trying to stop Electron processes launched from this project...\n');
  killProjectElectronWindows();
}

let removed = false;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  try {
    removed = tryRemoveElectronDir();
    if (removed) {
      console.log('Removed node_modules\\electron\n');
      break;
    }
  } catch (err) {
    console.warn(`Attempt ${attempt}/${RETRIES}: ${err.message}`);
  }
  if (attempt < RETRIES) {
    console.log(`Waiting ${DELAY_SEC}s before retry...`);
    waitSeconds(DELAY_SEC);
    if (process.platform === 'win32' && attempt === 3) {
      killProjectElectronWindows();
    }
  }
}

if (fs.existsSync(electronDir)) {
  console.error('Could not remove node_modules\\electron after retries. Something still has a lock on default_app.asar.');
  process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npmCmd, ['install'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(r.status === null ? 1 : r.status);
