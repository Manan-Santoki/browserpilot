const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Android blocks plain HTTP by default. Local BrowserPilot development uses a
 * private Tailscale address, so opt in only when this build is explicitly
 * pointed at an http:// console. Hosted/production builds remain HTTPS-only.
 */
module.exports = function withBrowserPilotNetwork(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("BrowserPilot could not find the Android application manifest.");
    }

    const consoleUrl = process.env.EXPO_PUBLIC_CONSOLE_URL ?? "";
    const allowCleartext =
      process.env.BROWSERPILOT_ALLOW_CLEARTEXT === "true" ||
      consoleUrl.startsWith("http://");

    application.$["android:usesCleartextTraffic"] = allowCleartext ? "true" : "false";
    return next;
  });
};
