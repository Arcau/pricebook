# Building the Pricebook Android app

The app is a thin shell around a Pricebook server: the pages come from the server, and the
shell adds a native barcode scanner, photo capture for receipts and price tags, and downloads.

## One-time setup

Create `android/keystore/` (it is ignored by git) with a signing key and a settings file:

    mkdir -p keystore && cd keystore
    keytool -genkeypair -keystore pricebook.jks -alias pricebook -keyalg RSA -keysize 2048 -validity 10950
    printf 'storePassword=THE_PASSWORD_YOU_CHOSE\nserverUrl=https://prices.example.org/\n' > keystore.properties

Use the same password for the store and the key. Keep the key safe: an update only installs
over the existing app when it is signed with the same key.

If you publish your own build, change `applicationId` in `app/build.gradle` to a name you own.

## Build

Needs Docker and internet access (the first run downloads Gradle and the Android libraries).

    cd android
    docker run --rm -u $(id -u):$(id -g) -e HOME=/project/.home -e GRADLE_USER_HOME=/project/.gradle-home \
      -v "$PWD":/project -w /project ghcr.io/cirruslabs/android-sdk:35 bash -c "
        mkdir -p .dist .home .gradle-home
        [ -x .dist/gradle-8.11.1/bin/gradle ] || { curl -sSL -o .dist/g.zip https://services.gradle.org/distributions/gradle-8.11.1-bin.zip && unzip -q .dist/g.zip -d .dist; }
        .dist/gradle-8.11.1/bin/gradle --no-daemon assembleRelease"

The APK lands in `app/build/outputs/apk/release/app-release.apk`. Bump `versionCode` in
`app/build.gradle` for every build people will install.

To offer it from your server at `/pricebook.apk`, copy it to `data/pricebook.apk`.
