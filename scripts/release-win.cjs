const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
if (!token) {
  console.error(
    '[release:win] GH_TOKEN is missing or empty after loading .env.\n' +
      '  1. Open desktop-printer-app/.env\n' +
      '  2. Set: GH_TOKEN=your_github_pat (no quotes; one line)\n' +
      '  3. Token needs repo access to publish releases (classic: repo scope).\n' +
      '  https://github.com/settings/tokens\n'
  );
  process.exit(1);
}

const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [cli, '--win', '--publish', 'always'], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
