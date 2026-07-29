#!/usr/bin/env bash
# Pair a connected Android device by typing a code into the app.
#
#   ./scripts/pair-device.sh ABC1234
#
# The code comes from Devices in the console and is single-use, so this cannot
# be re-run with the same one. Scanning the QR is the real path; this exists so
# the app can be tested without pointing a camera at a screen.
set -uo pipefail

CODE="${1:?usage: pair-device.sh <pairing-code>}"
PKG="com.msantoki.browserpilot"

size=$(adb shell wm size | tr -d '\r' | awk '{print $3}')
W="${size%x*}"; H="${size#*x}"

echo "launching…"
adb shell am force-stop "$PKG"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 8

# The pairing screen offers the camera first; take the typed path instead.
echo "switching to the typed code…"
adb shell input tap $(( W / 2 )) $(( H * 78 / 100 ))
sleep 3

# Focus the code field and type it.
adb shell input tap $(( W / 2 )) $(( H * 33 / 100 ))
sleep 1
adb shell input text "$CODE"
sleep 1

echo "pairing…"
adb shell input tap $(( W / 2 )) $(( H * 42 / 100 ))
sleep 8

adb exec-out screencap -p > /tmp/app-paired.png
echo "captured /tmp/app-paired.png"
