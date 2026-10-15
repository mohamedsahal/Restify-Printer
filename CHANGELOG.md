# Changelog

All notable changes to this project will be documented in this file.

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