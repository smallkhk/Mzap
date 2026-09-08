# Deploying the dashboard without a build toolchain

`prebuilt/` holds generated output, committed on purpose: the cPanel host has
no reliable build toolchain, so the dashboard is deployed by copying three
files onto it rather than building there.

    index.html
    assets/app.js
    assets/app.css

The filenames are fixed rather than content-hashed, so the copy is the same
command every time. The backend serves them with a one-hour max-age, so a hard
refresh after an update is all that is needed.

Regenerate after changing anything under `src/`:

    npm run build && npm run prebuilt

Never edit `prebuilt/` by hand — the next build overwrites it.
