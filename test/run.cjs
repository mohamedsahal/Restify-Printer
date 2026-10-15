/**
 * Runs every test/*.test.cjs with the module stubs preloaded (test/stubs/register.cjs), so
 * `npm test` needs no Electron, printer or network, and the stubs win even where the real
 * packages are installed. Exit code is non-zero when any file fails.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const stubs = path.join(testDir, 'stubs', 'node_modules');
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.cjs')).sort();

let failed = 0;
for (const file of files) {
    console.log(`\n== ${file}`);
    const result = spawnSync(process.execPath, ['-r', path.join(stubs, 'register.cjs'), path.join(testDir, file)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_PATH: stubs },
    });
    if (result.status !== 0) {
        failed += 1;
    }
}
console.log(`\n${files.length - failed}/${files.length} test file(s) passed`);
process.exit(failed === 0 ? 0 : 1);
