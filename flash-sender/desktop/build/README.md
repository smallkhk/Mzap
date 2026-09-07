# Build resources

Place the application icon here before packaging:

- **`icon.ico`** — Windows. A multi-resolution .ico containing at least
  256×256, 128, 64, 48, 32 and 16 px. Used for the executable, the installer
  and the Start Menu entry.
- `icon.png` — 512×512, used as the window icon in development.

Generate an .ico from a PNG with ImageMagick:

```bash
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

If these files are absent the build still succeeds — electron-builder falls
back to the default Electron icon.
