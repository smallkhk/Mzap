# Deploying the portal without a build toolchain

`prebuilt/` holds generated output, committed on purpose: the cPanel host has
no reliable build toolchain, so the portal is deployed by copying three files
onto it rather than building there.

    index.html
    assets/app.js
    assets/app.css

The filenames are fixed rather than content-hashed, so the copy is the same
command every time. Point the backend's `PORTAL_DIST_PATH` at wherever you
copy them, and it serves the portal at `/portal` on the same origin as the
API — see `docs/CUSTODIAL.md` for the full walkthrough.

Regenerate after changing anything under `src/`:

    npm run build && npm run prebuilt

Never edit `prebuilt/` by hand — the next build overwrites it.
