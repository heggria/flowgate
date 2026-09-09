import { createServer } from "node:net";
/** Isolate each app's data-plane listener from parallel tests and the user's app. */
export async function isolateProxyPort(page) {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await page.evaluate(async (port) => {
    const snapshot = await window.flowgate.request("snapshot");
    await window.flowgate.request(
      "configuration.save",
      {
        ...snapshot.configuration,
        settings: { ...snapshot.configuration.settings, listenPort: port },
      },
      crypto.randomUUID(),
    );
  }, port);
  return port;
}
