// Regenerate committed native images from the editable SVG/geometry sources.
// Run: node_modules/.bin/electron scripts/render-icons.cjs
const { app, BrowserWindow } = require("electron");
const { readFile, writeFile, mkdir, rm } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const { execFileSync } = require("node:child_process");
app.setName("FlowGate Icon Renderer");
app.setActivationPolicy("accessory");
app
  .whenReady()
  .then(async () => {
    const output = resolve("assets/brand");
    const work = resolve("work/icon-render");
    await mkdir(work, { recursive: true });
    const mark = JSON.parse(await readFile(join(output, "mark.json"), "utf8"));
    const paths = (color, stream = color) =>
      `<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${mark.strokeWidth}"><path stroke="${color}" d="${mark.gate}"/><path stroke="${stream}" d="${mark.streams}"/></g>`;
    const svg = (body, viewBox = "0 0 1024 1024") =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
    const background = `<defs><linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#213a42"/><stop offset=".54" stop-color="#15292f"/><stop offset="1" stop-color="#0b1d23"/></linearGradient><radialGradient id="glow" cx=".85" cy=".9" r=".9"><stop stop-color="#2b857c" stop-opacity=".45"/><stop offset="1" stop-color="#2b857c" stop-opacity="0"/></radialGradient><linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#d4efea" stop-opacity=".36"/><stop offset="1" stop-color="#d4efea" stop-opacity=".05"/></linearGradient></defs><rect x="64" y="64" width="896" height="896" rx="208" fill="url(#base)"/><rect x="64" y="64" width="896" height="896" rx="208" fill="url(#glow)"/><rect x="66" y="66" width="892" height="892" rx="206" fill="none" stroke="url(#rim)" stroke-width="3"/>`;
    const icon = svg(
      background +
        `<g transform="translate(188 188) scale(27)">${paths("#f0faf6", "#82e4ce")}</g>`,
    );
    const template = svg(paths("#000"), mark.viewBox);
    await writeFile(join(output, "app-icon.svg"), icon + "\n");
    await writeFile(
      join(output, "mark.svg"),
      svg(paths("currentColor"), mark.viewBox) + "\n",
    );
    await writeFile(join(output, "menu-bar.svg"), template + "\n");
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    await window.loadURL('data:text/html,<meta charset="utf-8">');
    const raster = async (source, size, path, dpi = 72) => {
      const png = await window.webContents.executeJavaScript(
        `(async()=>{const i=new Image();i.src='data:image/svg+xml;base64,'+${JSON.stringify(Buffer.from(source).toString("base64"))};await i.decode();const c=document.createElement('canvas');c.width=c.height=${size};c.getContext('2d').drawImage(i,0,0,${size},${size});return c.toDataURL('image/png').split(',')[1]})()`,
      );
      await writeFile(path, Buffer.from(png, "base64"));
      execFileSync(
        "/usr/bin/sips",
        ["-s", "dpiWidth", String(dpi), "-s", "dpiHeight", String(dpi), path],
        { stdio: "ignore" },
      );
    };
    await raster(icon, 1024, join(output, "app-icon.png"));
    await raster(template, 18, join(output, "menuBarTemplate.png"));
    await raster(template, 36, join(output, "menuBarTemplate@2x.png"), 144);
    const iconset = join(work, "FlowGate.iconset");
    await mkdir(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      await raster(icon, size, join(iconset, `icon_${size}x${size}.png`));
      await raster(
        icon,
        size * 2,
        join(iconset, `icon_${size}x${size}@2x.png`),
        144,
      );
    }
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      join(output, "FlowGate.icns"),
    ]);
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
