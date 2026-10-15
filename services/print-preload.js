/**
 * Preload of the hidden print windows (services/ChromiumPrinter.js).
 *
 * It runs in the isolated world (contextIsolation), so the ticket's own `window.print` is
 * NOT reachable from here: that one is overridden by a guard script put at the top of <head>
 * and again with executeJavaScript at dom-ready. This file only makes sure nothing from the
 * isolated world can open a dialog either, and it exposes no bridge on purpose: the ticket
 * HTML comes from the server and must not reach anything outside its page.
 */
try {
    window.print = function () {};
    window.close = function () {};
    window.open = function () { return null; };
} catch (_) {
    /* ignore */
}
