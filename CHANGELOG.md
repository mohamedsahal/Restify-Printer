# Changelog

All notable changes to this project will be documented in this file.

## v1.1.0 - 2026-10-15

### Added
- **Chromium print engine.** Tickets arrive as HTML from the server and are printed by the
  same engine and CSS as the browser pop-up print, so the paper looks exactly like the pop-up.
  No screenshot, no download: a ticket is on the printer well under a second after the order.
  Image and PDF jobs from older servers still print through the existing worker.
- **Starts by itself.** Launch at login (hidden in the tray) is switched on the first time the
  app is set up; the printing service starts on launch from the saved settings, retrying every
  10 s / 30 s / 60 s while the server is unreachable. One copy of the app runs at a time.
- **Updates by themselves.** Checked 10 s after start and every 4 hours, downloaded in the
  background and installed when no ticket has printed for a minute (the app restarts on its
  own) or on quit. "Install now" is in the window and the tray.
- **Test print** per printer mapping: a built-in sample ticket checks the mapping without an order.
- **Copies** (1-5) and **engine** (Auto = Chromium for HTML tickets, Image = legacy worker)
  per printer mapping.
- **Recent prints** in the window: time, printer, engine, duration and result of the last
  tickets; the tray tooltip and menu show the service status.
- **Log file** (`Open log file` in the window): service start/stop, connection results, every
  job, update events and errors. Rotates at 2 MB.

### Changed
- Printers are listed through Chromium instead of `wmic`, which newer Windows versions no longer ship.
- The window is a view on the service: it can stay closed, printing keeps running in the tray
  and the service status, connection and Pusher state are shown when it is opened.
- The app sends its version with every request (`X-Restify-App-Version`), so the server stops
  rendering screenshots for branches on this version.
- No GitHub token is needed for updates (the repository is public).

### Fixed
- Jobs the server handed to the app were lost when the app had no mapping or hit an error;
  they are now marked failed with the reason so they do not stay "printing".
- Pusher is subscribed again after a network outage (after five failed pulls in a row the
  connection is re-tested on the next successful pull).

## v1.0.5 - 2026-10-15

### Changed
- Windows: one PowerShell print worker stays running (System.Drawing loaded once) and
  prints every ticket; a new PowerShell process per ticket used to cost 1-3 seconds each.
  The worker starts when the printing service starts, and restarts itself if it dies.
- Pulls pending jobs every second (was 1.5 s); after a Pusher signal it pulls every 250 ms
  and stops as soon as the job is printed.
- Pulls never overlap (one printer queue), and `RESTIFY_POWERSHELL` can point at another
  PowerShell for debugging.

Pairs with the RestiFy server change that announces a job only when its ticket image is on
disk and uses one Pusher channel per branch.

## v1.0.1 - 2026-03-30

### Added
- New release with latest improvements

### Fixed
- General bug fixes and stability improvements

### Changed
- Updated dependencies and configurations

## v1.0.0 - Initial Release

### Added
- Initial release of Restify Desktop Printer Application
- Thermal printer support
- Real-time order notifications via Pusher
- Auto-launch functionality
- Auto-update system
- Windows, macOS, and Linux support
