// Preloaded by test/run.cjs (node -r): the stubbed packages win over node_modules, so the
// tests also pass where the real Electron is installed (a developer machine, the build runner).
const Module = require('module');
const path = require('path');
const fs = require('fs');

const stubRoot = path.join(__dirname, 'node_modules');
const stubbed = new Set(fs.readdirSync(stubRoot));
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
    if (stubbed.has(request)) {
        return path.join(stubRoot, request, 'index.js');
    }
    return originalResolve.call(this, request, parent, isMain, options);
};
