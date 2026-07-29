#!/usr/bin/env bash
# Drive the app on a connected Android device and capture what each screen
# looks like. Screenshots land in /tmp/app-*.png.
#
# This is a smoke test, not a unit test: it proves the app starts, the tabs
# render, and nothing crashes on the way round. Pairing has to be done by hand
# once — the code is single-use and short-lived — after which this can be re-run
# freely.
set -uo pipefail

PKG="com.msantoki.browserpilot"
SHOT_DIR="${1:-/tmp}"

shot() {
  local name="$1"
  sleep "${2:-2}"
  adb exec-out screencap -p > "$SHOT_DIR/app-$name.png"
  echo "  captured $name"
}

crashed() {
  # Anything the app logged as fatal since the run started.
  adb logcat -d -t 400 2>/dev/null | grep -E "FATAL EXCEPTION|AndroidRuntime: .*Error" | head -5
}

echo "device: $(adb shell getprop ro.product.model | tr -d '\r')"
adb logcat -c

echo "launching…"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
shot "launch" 6

# Tab bar sits at the bottom; tap along it by proportion of the screen width so
# this works on a phone and a tablet alike.
size=$(adb shell wm size | tr -d '\r' | awk '{print $3}')
W="${size%x*}"; H="${size#*x}"
tab_y=$(( H * 95 / 100 ))

for i in 1 2 3 4; do
  x=$(( W * (2 * i - 1) / 8 ))
  adb shell input tap "$x" "$tab_y"
  shot "tab$i" 3
done

echo
echo "fatal errors in logcat:"
if crashed | grep -q .; then
  crashed
  exit 1
fi
echo "  none"
