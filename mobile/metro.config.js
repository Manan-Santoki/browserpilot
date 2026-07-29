// Expo's Metro defaults. Without this, Metro uses its own and cannot find the
// app's entry point, because expo-router supplies one rather than the project
// having an index of its own.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
