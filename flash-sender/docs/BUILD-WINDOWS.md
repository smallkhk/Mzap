# Building the Windows installer

Produces `Flash-Sender-by-Nora-Setup-1.0.0.exe`.

---

## Prerequisites

- **Windows 10/11 x64** (recommended — building on Windows avoids every
  cross-compilation caveat below)
- **Node 20+**
- Roughly 2 GB free disk (electron-builder downloads and caches Electron)

---

## Build

```cmd
cd desktop
npm install
npm run package:win
```

The script runs the typecheck, bundles the renderer/main/preload with Vite, then
packages with electron-builder. Output:

```
desktop\release\
  Flash-Sender-by-Nora-Setup-1.0.0.exe     <- the installer
  win-unpacked\                             <- the unpacked app, for inspection
  latest.yml
```

### Other targets

```cmd
npm run package:win:portable    :: one self-contained .exe, no installer
npm run package:dir             :: unpacked only — fastest for smoke-testing
```

---

## What the installer does

Configured in `desktop/electron-builder.yml`:

- **Per-user install by default** (`perMachine: false`) — no admin rights needed,
  and `requestedExecutionLevel: asInvoker` means the app never asks for
  elevation. It only ever writes to `%APPDATA%`.
- Lets the user choose the install directory.
- Creates Start Menu and desktop shortcuts.
- **Does not delete `%APPDATA%` on uninstall** (`deleteAppDataOnUninstall:
  false`). This is deliberate: that directory holds the encrypted wallet vault,
  and removing it during an uninstall or upgrade would destroy the user's key.

### Where the app stores data

```
%APPDATA%\flash-sender-desktop\
  wallet.vault          encrypted private key (scrypt + AES-256-GCM, DPAPI-wrapped)
  settings.json         API URL + DPAPI-encrypted API key, preferences
  history.json          local transaction history
  config-cache.json     last-known asset list, so the app starts offline
```

To fully reset an installation, uninstall and then delete that folder — but
**export or record your recovery phrase first**, because the vault is the only
copy of the key.

---

## Code signing

An unsigned build works, but Windows SmartScreen will show a
"Windows protected your PC" warning on first run, and browsers will flag the
download. For anything distributed to other people, sign it.

You need an **OV or EV code-signing certificate** from a CA (DigiCert, Sectigo,
SSL.com…). Since June 2023 the private key must live on hardware (a token or
cloud HSM), so the classic `.pfx` file flow only applies to older certificates.

### With a .pfx (legacy / internal use)

```cmd
set CSC_LINK=C:\path\to\certificate.pfx
set CSC_KEY_PASSWORD=your-password
npm run package:win
```

electron-builder picks these up automatically. **Never commit the certificate or
its password**, and never put them in `.env` files that ship with the app.

### With a hardware token or cloud HSM

Add a custom sign hook to `electron-builder.yml`:

```yaml
win:
  sign: ./sign.js
```

```js
// desktop/sign.js — invoked once per artifact
exports.default = async function (configuration) {
  const { execSync } = require('node:child_process');
  execSync(
    `signtool sign /sha1 ${process.env.CERT_THUMBPRINT} /tr http://timestamp.digicert.com ` +
      `/td sha256 /fd sha256 "${configuration.path}"`,
    { stdio: 'inherit' },
  );
};
```

Always include a timestamp (`/tr`) — without one, signatures stop validating the
moment the certificate expires.

### Verifying a signature

```cmd
signtool verify /pa /v release\Flash-Sender-by-Nora-Setup-1.0.0.exe
```

---

## Building on Linux or macOS

Possible, with caveats:

```bash
cd desktop
npm run build
npx electron-builder --win --x64
```

- Wine is required for the NSIS installer target. On Debian/Ubuntu:
  `sudo apt install wine64`.
- **Code signing does not work** — sign on Windows.
- Test the result on real Windows before distributing it.

The most reliable cross-platform route is a Windows CI runner:

```yaml
# .github/workflows/build.yml
name: Build Windows installer
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: desktop/package-lock.json

      - run: npm ci
        working-directory: desktop

      - run: npm run package:win
        working-directory: desktop
        env:
          CSC_LINK: ${{ secrets.WINDOWS_CERT_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CERT_PASSWORD }}

      - uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: desktop/release/*.exe
```

---

## Application icon

Place a **256×256 (or larger) multi-resolution `.ico`** at
`desktop/build/icon.ico` before packaging. electron-builder uses it for the
executable, the installer, and the Start Menu entry.

To generate one from a PNG:

```bash
# ImageMagick
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

If the file is absent, electron-builder substitutes the default Electron icon
and the build still succeeds.

---

## Versioning

The installer filename comes from `version` in `desktop/package.json`. Bump it
before each release:

```cmd
cd desktop
npm version patch      :: 1.0.0 -> 1.0.1
npm run package:win
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `cannot execute cause=EACCES` during packaging | electron-builder's cache is corrupt. Delete `%LOCALAPPDATA%\electron-builder\Cache` and retry. |
| App launches to a blank window | The renderer bundle is missing. Run `npm run build` before packaging, and check `dist/index.html` exists. |
| `Cannot find module 'ethers'` at runtime | Something changed the Vite externals. `ethers` must be **bundled** into `dist-electron/main.js`, not left external — only `electron` is external. |
| SmartScreen warning on every install | The build is unsigned, or the certificate has no reputation yet. EV certificates get reputation immediately; OV ones accrue it over downloads. |
| Installer is very large (>150 MB) | Expected — it contains Chromium. `compression: maximum` is already set. |
