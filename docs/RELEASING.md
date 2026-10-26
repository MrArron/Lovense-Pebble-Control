# Releasing

Same pipeline as the Wrist Assistant repo. `.github/workflows/release.yml` runs when you push a tag
`v*`: it builds the watch app (`.pbw`) and a release-signed companion APK and attaches both, plus
`SHA256SUMS.txt`, to a GitHub Release. `.github/workflows/ci.yml` builds both (debug APK) on every PR.

## One-time setup: signing secrets

The companion APK must always be signed with the same key, because Android only installs updates
signed with the key the app was first installed with. Reusing the Wrist Assistant keystore is fine.

1. Base64-encode the keystore (one line): `base64 -w0 release.jks > release.jks.b64`
   (macOS: `base64 -i release.jks | tr -d '\n' > release.jks.b64`).
2. In this repo: Settings, Secrets and variables, Actions, New repository secret:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | contents of `release.jks.b64` |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore (store) password |
   | `ANDROID_KEY_ALIAS` | the key alias |
   | `ANDROID_KEY_PASSWORD` | the key password |

   With the GitHub CLI: `gh secret set ANDROID_KEYSTORE_BASE64 < release.jks.b64`, and so on.
3. Add the repository **variable** `ANDROID_CERT_SHA256` (Variables tab) with the certificate's
   SHA-256 (`keytool -list -v -keystore release.jks`). The workflow refuses to publish an APK signed
   with any other key. `gh variable set ANDROID_CERT_SHA256 --body <value>`.
4. Delete `release.jks.b64`. Keep the `.jks` and passwords backed up.

## Cutting a release

1. Bump the version in `package.json` (`version`) and in `android-companion/app/build.gradle.kts`
   (`versionName` to the same value, and raise `versionCode`). Add a `CHANGELOG.md` entry.
2. Merge to `main` (only after the change is confirmed on real hardware, per `CLAUDE.md`).
3. `git tag v1.3.0 && git push origin v1.3.0`. The workflow fails early if the tag doesn't match
   both versions or a secret/variable is missing.
4. Upload the `.pbw` to the Pebble app store with `pebble publish` from the local machine, pasting
   the `CHANGELOG.md` entry as release notes. The UUID must never change.
