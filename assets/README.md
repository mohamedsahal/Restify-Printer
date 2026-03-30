# Assets Folder

Place your application icons and images here:

## Required Files:

### Icons
- `icon.png` - Main application icon (512x512px)
- `icon.ico` - Windows icon
- `icon.icns` - macOS icon
- `tray-icon.png` - System tray icon (16x16px or 32x32px)

### Logo
- `logo.png` - Application logo for header (height: 32px)

## Creating Icons

### From PNG to ICO (Windows)

Use online tools:
- https://convertio.co/png-ico/
- https://icoconvert.com/

Or use ImageMagick:
```bash
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

### From PNG to ICNS (macOS)

```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
```

## Temporary Placeholders

Until you add your own icons, the app will use default Electron icons.

For testing, you can use any PNG image as a placeholder.
