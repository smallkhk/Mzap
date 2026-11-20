# Building the iOS app

`.github/workflows/build-ios.yml` builds an **unsigned** `.ipa` on a macOS
GitHub Actions runner — no Apple secrets, no certificate, no provisioning
profile. It compiles `mobile/` into an app bundle and zips it into IPA shape.
You sign it yourself afterward with your own Apple Developer account, which
is the part Apple requires a human (and a paid membership) for regardless of
which machine does the compiling.

---

## Getting the unsigned IPA

- **Automatically**: push a commit to `claude/flash-sender-windows-app-zu3zmm`,
  or push a tag like `v1.0.1` to also attach it to a GitHub Release.
- **Manually**: GitHub → Actions → "Build iOS app" → Run workflow.

Output: the `flash-sender-ios-ipa-unsigned` artifact on the run, or the
Release page for a tag push. The file is named
`FlashSenderByNora-unsigned.ipa`.

---

## Signing it yourself

Pick whichever of these you already have set up:

### Option A — Xcode re-sign (simplest, needs a Mac)

1. Unzip the IPA: `unzip FlashSenderByNora-unsigned.ipa -d unsigned`.
2. Open Xcode → Window → Devices and Simulators → select your device →
   drag `unsigned/Payload/*.app` onto it. Xcode will offer to sign it with
   whatever team/identity is selected in your Xcode account settings and
   install it directly — no manual `codesign` needed for this path.

### Option B — `codesign` + manual provisioning profile

```bash
unzip FlashSenderByNora-unsigned.ipa -d unsigned
cp YourProfile.mobileprovision "unsigned/Payload/Flash Sender by Nora.app/embedded.mobileprovision"
codesign --force --sign "Apple Distribution: Your Name (TEAMID)" \
  --entitlements entitlements.plist \
  "unsigned/Payload/Flash Sender by Nora.app"
cd unsigned && zip -r -X ../FlashSenderByNora-signed.ipa Payload
```

`entitlements.plist` needs to match what the profile grants — easiest way to
get a correct one is extracting it from the profile itself:

```bash
security cms -D -i YourProfile.mobileprovision > profile.plist
/usr/libexec/PlistBuddy -x -c "Print :Entitlements" profile.plist > entitlements.plist
```

### Option C — Apple Configurator 2 / fastlane / a resigning GUI

Tools like `fastlane sigh` + `fastlane resign` or third-party apps (e.g.
iResign) take an unsigned or wrongly-signed IPA plus your `.p12` and
provisioning profile and do the above for you.

Once signed, install via Xcode's Devices window, Apple Configurator 2, or
an ad-hoc OTA page, same as any other IPA.

---

## If you'd rather CI sign it too

The workflow used to do exactly that — import a `.p12` and provisioning
profile from repo secrets and run `xcodebuild -exportArchive`. If you want
that back (so every CI build is already signed and installable with no
local step), say so and it'll be restored; it needs these repo secrets:
`APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`,
`APPLE_PROVISIONING_PROFILE_BASE64`, `APPLE_PROVISIONING_PROFILE_NAME`,
`APPLE_TEAM_ID`, `APPLE_KEYCHAIN_PASSWORD`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No .app found in the archive` | The `xcodebuild archive` step didn't actually produce a build — check the step's own log above it for the real compile error; this is just a sanity check that fires afterward. |
| Signed IPA won't install — "Unable to install" | Usually the provisioning profile doesn't cover that device's UDID (register it on developer.apple.com and regenerate the profile), or the profile has expired. |
| `expo prebuild` output looks wrong | The `ios/` directory is regenerated fresh every run (Continuous Native Generation) from `mobile/app.json` — it is never committed. Check `app.json`, not any local `ios/` folder; this workflow never reads your machine's copy. |
