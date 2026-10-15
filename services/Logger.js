const fs = require('fs');
const path = require('path');

/** Rotate when the log passes this size; one older file is kept (printer.log.1). */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Append-only log file for the restaurant to send us when something goes wrong. Writes are
 * synchronous and small, so they never reorder, and every call is wrapped: logging must not
 * be the thing that crashes the printer.
 */
class Logger {
    constructor(dir, { maxBytes = DEFAULT_MAX_BYTES, echo = true, fileName = 'printer.log' } = {}) {
        this.dir = dir;
        this.file = path.join(dir, fileName);
        this.oldFile = `${this.file}.1`;
        this.maxBytes = maxBytes;
        this.echo = echo;
    }

    get path() {
        return this.file;
    }

    debug(message, meta) {
        this.write('debug', message, meta);
    }

    info(message, meta) {
        this.write('info', message, meta);
    }

    warn(message, meta) {
        this.write('warn', message, meta);
    }

    error(message, meta) {
        this.write('error', message, meta);
    }

    write(level, message, meta) {
        const text = message instanceof Error ? (message.stack || message.message) : String(message);
        let line = `${new Date().toISOString()} [${level}] ${text}`;
        if (meta !== undefined) {
            try {
                line += ' ' + JSON.stringify(meta);
            } catch {
                line += ' ' + String(meta);
            }
        }
        if (this.echo) {
            (level === 'error' ? console.error : console.log)(line);
        }
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            this.rotateIfNeeded();
            fs.appendFileSync(this.file, line + '\n');
        } catch {
            // Disk full or folder unwritable: the console copy is all we can do.
        }
    }

    rotateIfNeeded() {
        let size = 0;
        try {
            size = fs.statSync(this.file).size;
        } catch {
            return;
        }
        if (size < this.maxBytes) {
            return;
        }
        try {
            fs.rmSync(this.oldFile, { force: true });
            fs.renameSync(this.file, this.oldFile);
        } catch {
            // Rename failed (file open elsewhere); keep appending to the current file.
        }
    }
}

module.exports = Logger;
module.exports.DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
