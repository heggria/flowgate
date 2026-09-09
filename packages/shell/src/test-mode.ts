// All isolated Electron tests run without presenting or activating native UI.
// Developers can explicitly opt in when inspecting a test by hand.
export const backgroundTest =
  Boolean(process.env.FLOWGATE_TEST_DATA) &&
  process.env.FLOWGATE_TEST_VISIBLE !== "1";
