# Building the iOS app

Produces an unsigned-for-nobody, properly-signed `.ipa` via GitHub Actions
(`.github/workflows/build-ios.yml`), on a macOS runner. No local Mac or Xcode
needed to trigger a build — but Apple still requires a real, paid Apple
Developer account ($99/year) before any IPA can be signed, by anyone, on any
machine. That part cannot be skipped or worked around.

---

## What you need, once

1. **An Apple Developer account** (apps.apple.com/account) — personal or
   organization, either works for ad-hoc distribution.
2. **A Distribution certificate** (`.p12`) and its password.
3. **A provisioning profile** matching the app's bundle ID
   (`com.flashsenderbynora.app`, set in `mobile/app.json`) and the devices you
   want able to install it (ad-hoc profiles list specific device UDIDs).
4. **Your Team ID** — found on
   [developer.apple.com/account](https://developer.apple.com/account) under
   Membership.

### Generating the certificate and profile

On a Mac, in Xcode:

1. Xcode → Settings → Accounts → add your Apple ID → Manage Certificates →
   **+** → **Apple Distribution**.
2. Export it: Keychain Access → find the new certificate → right-click →
   **Export** → save as `cert.p12`, set a password (you'll need this
   password again as a secret).
3. On developer.apple.com → Certificates, Identifiers & Profiles → Profiles →
   **+** → **Ad Hoc** (for direct install on devices you register) or
   **App Store** (for TestFlight/App Store) → select the Distribution
   certificate from step 1 → select the registered devices (ad-hoc only) →
   download as `profile.mobileprovision`.
4. Register the devices that should be able to install an ad-hoc build under
   Devices, by UDID, **before** creating the profile — a profile only covers
   devices that existed when it was generated.

No Mac available? Apple's enrollment and certificate/profile creation all run
through the developer.apple.com web portal and work from any browser — Xcode
is only needed to *generate* the `.p12` locally; everything else is web-based.
If you truly have no Mac at all, ask whoever will test the app to generate the
certificate once from their own Mac and hand you the `.p12` — the private key
only needs to exist somewhere once, not on every machine that builds.

---

## Repository secrets

Set these at **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `APPLE_CERT_BASE64` | `base64 -i cert.p12 \| pbcopy` (or `base64 -w0 cert.p12` on Linux), then paste |
| `APPLE_CERT_PASSWORD` | The password you set exporting the `.p12` |
| `APPLE_PROVISIONING_PROFILE_BASE64` | `base64 -i profile.mobileprovision \| pbcopy` |
| `APPLE_PROVISIONING_PROFILE_NAME` | The profile's **Name** field, exactly as shown on developer.apple.com (not the filename) |
| `APPLE_TEAM_ID` | Your 10-character Team ID |
| `APPLE_KEYCHAIN_PASSWORD` | Any throwaway string — only used to lock/unlock a keychain that exists for the duration of one build |

**Never commit any of these values** or put them in a file that ships with
the app. The `.p12` and `.mobileprovision` files themselves should never
enter git history either — only their base64 copies, as GitHub secrets.

---

## Running the build

- **Automatically**: push a commit to `claude/flash-sender-windows-app-zu3zmm`,
  or push a tag like `v1.0.1` to also attach the IPA to a GitHub Release.
- **Manually**: GitHub → Actions → "Build iOS app" → Run workflow.

Output: download the `flash-sender-ios-ipa` artifact from the run, or (for a
tag push) grab it from the Release page directly.

---

## Installing an ad-hoc IPA on a device

Apple doesn't allow a plain "download and tap to install" for ad-hoc builds
the way Android's APKs work. Options, easiest first:

1. **Install via a Mac + Xcode**: Window → Devices and Simulators → drag the
   `.ipa` onto the connected device.
2. **Install via Apple Configurator 2** (Mac App Store, free): drag the
   `.ipa` onto the device.
3. **Over-the-air** via a hosting page (e.g.
   [diawi.com](https://diawi.com) or your own HTTPS server) with a
   `manifest.plist` — more setup, but installs by just opening a link on the
   device, no cable needed.

For wider, cable-free distribution without re-signing for every new device,
switch `method` in `.github/workflows/build-ios.yml`'s `ExportOptions.plist`
step from `ad-hoc` to `app-store` and submit through
[App Store Connect](https://appstoreconnect.apple.com) (TestFlight for
testers, or a full App Store release) — that needs an `app-store` profile
instead of an ad-hoc one, same secrets otherwise.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No signing certificate "Apple Distribution" found` | The cert imported into the CI keychain doesn't match `CODE_SIGN_IDENTITY` in the workflow, or `APPLE_CERT_PASSWORD` is wrong. Re-export the `.p12` and re-check the password. |
| `Provisioning profile "X" doesn't match the bundle identifier` | The profile's App ID doesn't cover `com.flashsenderbynora.app` — regenerate the profile from an App ID that does, or change the bundle identifier in `mobile/app.json` to match an existing profile (then also update `ExportOptions.plist`'s `provisioningProfiles` key). |
| `doesn't include the currently selected device` | The device's UDID wasn't registered before the ad-hoc profile was generated. Register it on developer.apple.com, regenerate the profile, update the secret. |
| Build succeeds but `.ipa` won't install — "Unable to install" on device | Usually an expired provisioning profile (they expire yearly) or a device not covered by it. Check the profile's expiry on developer.apple.com. |
| `expo prebuild` fails or produces something unexpected | The `ios/` directory is regenerated fresh every run (Continuous Native Generation) from `mobile/app.json` — it is never committed. Check `app.json` first, not any local `ios/` folder, which this workflow never reads from your machine. |
