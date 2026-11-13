# Android setup and Bluetooth printer pairing

## A. Pair the printer (once)
1. Switch the 58 mm printer on (usually a long press on the power button). Load paper.
2. Android **Settings → Bluetooth** → scan → pick the printer (names like `MTP-II`, `PT-210`, `BlueTooth Printer`) → PIN is usually `0000` or `1234`.
3. Make sure it shows as *Paired*. Do **not** connect it as audio.

## B. Install the app – option 1: BITE AND MELT Android app (recommended, prints directly)
Needs a PC with **Android Studio** (free).
1. Install Android Studio, choose *Open* → select the `android/` folder, let Gradle sync.
2. Plug in your phone (USB debugging on) → press **Run**. Or *Build → Build APK(s)*, copy `app-debug.apk` to the phone and install it (allow "install unknown apps").
3. First launch asks for the **server address** (your deployed URL, e.g. `https://pos.yourcafe.in`; for testing on the same Wi-Fi use `http://<PC-IP>:3000`). It can be changed later in Settings → Android app.
4. Log in. Go to **Settings → Bluetooth printer**, set connection to *Android app (direct)*, allow the "Nearby devices" permission, choose your printer from the list, press **Test Print**.

## C. Install the app – option 2: no APK (RawBT)
Open the POS in Chrome → menu → *Add to Home screen*. Install the free **RawBT** app from Play Store, pair your printer inside RawBT, then in POS Settings choose *RawBT*. Printing then goes through RawBT.

## Troubleshooting
* *Printer list is empty*: pair it in Android settings first; allow Nearby devices; Bluetooth on.
* *Could not print / connection failed*: printer off or out of range, or connected to another phone. Switch it off and on.
* *Garbled text*: Settings → Printer → paper size 58 mm. Very cheap printers may ignore the cut command (harmless).
* *Logo or QR faint*: use a fresh paper roll; keep "dark text" on.
* The app needs internet for the first load. Billing continues offline and syncs automatically when internet returns (it shows an Offline badge and a queue count).
