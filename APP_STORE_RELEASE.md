# Nimbus Noir — iOS/App Store release

The repository now contains a Capacitor iOS wrapper around the existing PWA. Web assets remain the source of truth and are copied into `www/` during the build.

## Provisional app identity

- App name: `Nimbus Noir`
- Bundle ID: `com.jottavia.nimbusnoir`
- Version: `1.0.0`

Change the bundle ID in `capacitor.config.json` and the Xcode target before the first App Store upload if this identifier is not appropriate. The App Store Connect record and Xcode project must use the same bundle ID.

## Build the native project

A Mac with a current Xcode release is required to compile, sign, archive, and upload an iOS app.

1. Clone the repository on the Mac.
2. Run `npm install`.
3. Run `npm run ios:open`.
4. In Xcode, select the **App** target, then **Signing & Capabilities**.
5. Choose your Apple Developer team and verify the bundle identifier.
6. Select an iPhone simulator and run the app.
7. Test first launch, Allow/Don't Allow location, city search, pinned locations, radar, sharing, offline cached data, and external attribution links.
8. Set the version/build number, select **Any iOS Device**, and choose **Product → Archive**.
9. In Organizer, validate and distribute the archive to App Store Connect.

After every web-code change, run `npm run ios:sync` before rebuilding in Xcode.

## App Store Connect checklist

- Active Apple Developer Program membership and current agreements accepted.
- App record created before upload with the same bundle ID.
- Support URL: `https://jottavia.github.io/nimbus-noir/support.html`
- Privacy Policy URL: `https://jottavia.github.io/nimbus-noir/privacy.html`
- App Privacy responses checked against the current practices of every weather/map provider. Do not claim “no data collected” until provider retention of IP addresses, coordinates, and searches has been verified.
- App description, subtitle, keywords, category, age rating, copyright, and review contact.
- At least one current iPhone screenshot; provide iPad screenshots too if the app is offered on iPad.
- Review notes explaining that location is optional, city search is the fallback, all preferences are local, and live weather/radar require network access.
- TestFlight smoke test on a physical iPhone before submission.

## Recommended store copy

**Subtitle:** Private, precise weather

**Promotional summary:** A focused weather forecast with next-hour precipitation, severe alerts, radar, saved places, and historical conditions—without accounts, ads, or analytics.

The support and privacy pages are deployed to GitHub Pages by `.github/workflows/pages.yml` after changes reach `main`. Verify every provider statement before submission and use the URLs above in App Store Connect.
