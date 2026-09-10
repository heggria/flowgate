import { _electron as electron } from "playwright";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const output = resolve("work/macos-integration");
await mkdir(output, { recursive: true });
const fixture = join(output, "fixture.cjs");
await build({
  stdin: {
    contents: `
import {app,BrowserWindow,nativeImage,Menu} from 'electron';
import {MenuBarController} from './packages/shell/src/menu-bar';
import {installApplicationMenu} from './packages/shell/src/application-menu';
import {readAppearance,setAppearance} from './packages/shell/src/appearance';
app.setActivationPolicy('accessory');
app.whenReady().then(async()=>{
  const state={created:0,destroyed:false,title:'',tooltip:'',menu:null,updates:0,actions:[],routes:[]};
  const image=nativeImage.createFromPath(${JSON.stringify(resolve("dist/assets/menuBarTemplate.png"))});
  const controller=new MenuBarController(image,{open:()=>state.actions.push('open'),settings:()=>state.actions.push('settings'),connect:()=>state.actions.push('connect'),disconnect:()=>state.actions.push('disconnect'),quit:()=>state.actions.push('quit')},(_image,guid)=>{
    state.guid=guid;state.created++;return {isDestroyed:()=>state.destroyed,setTitle:v=>state.title=v,setToolTip:v=>state.tooltip=v,setContextMenu:v=>{state.menu=v;state.updates++},setIgnoreDoubleClickEvents:()=>{},destroy:()=>state.destroyed=true};
  });
  const menu=installApplicationMenu(${JSON.stringify(resolve("dist"))},route=>state.routes.push(route));
  globalThis.fixture={state,image,controller,menu,readAppearance,setAppearance};
  const window=new BrowserWindow({show:false,focusable:false,skipTaskbar:true});
  await window.loadURL('data:text/html,<title>Native integration</title>');
});`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: fixture,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const checks = [];
let app = await electron.launch({ args: [fixture] });
try {
  await app.firstWindow();
  const result = await app.evaluate(() => {
    const f = globalThis.fixture;
    const pixels = f.image.toBitmap({ scaleFactor: 1 });
    let opaque = 0,
      transparent = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]) opaque++;
      else transparent++;
    }
    f.controller.install();
    f.controller.install();
    const initial = {
      empty: f.image.isEmpty(),
      size: f.image.getSize(),
      scales: f.image.getScaleFactors(),
      template: f.image.isTemplateImage(),
      opaque,
      transparent,
      created: f.state.created,
      guid: f.state.guid,
    };
    const running = {
      kernel: { status: "running", appliedRevision: 2 },
      configuration: { revision: 2 },
    };
    f.controller.update(running);
    const updates = f.state.updates;
    f.controller.update(running);
    const coalesced = f.state.updates === updates;
    const stop = f.state.menu.items.find((i) => i.label === "停止代理");
    const enabled = stop.enabled;
    stop.click();
    f.state.menu.items.find((i) => i.label === "打开 FlowGate").click();
    f.state.menu.items.find((i) => i.label === "设置…").click();
    f.controller.update({ ...running, configuration: { revision: 3 } });
    const pending = f.state.tooltip;
    f.controller.update({
      kernel: { status: "stopped" },
      configuration: { revision: 3 },
    });
    const start = f.state.menu.items.find((i) => i.label === "启动代理");
    const stoppedCanStart = start.enabled;
    start.click();
    const settings = f.menu.items[0].submenu.items.find(
      (i) => i.label === "设置…",
    );
    settings.click();
    f.setAppearance("dark");
    const dark = f.readAppearance();
    const darkChecked = f.menu.getMenuItemById("appearance-dark").checked;
    f.setAppearance("system");
    const system = f.readAppearance();
    let invalid = false;
    try {
      f.setAppearance("arbitrary");
    } catch {
      invalid = true;
    }
    f.controller.dispose();
    return {
      initial,
      coalesced,
      enabled,
      pending,
      stoppedCanStart,
      actions: f.state.actions,
      routes: f.state.routes,
      settingsAccelerator: settings.accelerator,
      dark,
      darkChecked,
      system,
      invalid,
      destroyed: f.state.destroyed,
      menus: f.menu.items.map((i) => i.label),
    };
  });
  assert.equal(result.initial.empty, false);
  assert.deepEqual(result.initial.size, { width: 18, height: 18 });
  assert.ok(
    result.initial.scales.includes(1) && result.initial.scales.includes(2),
  );
  assert.equal(result.initial.template, true);
  assert.ok(result.initial.opaque > 30 && result.initial.transparent > 30);
  assert.equal(result.initial.created, 1);
  assert.equal(result.initial.guid, "e6de804e-41d4-4f24-8817-e19181f794e1");
  assert.equal(result.coalesced, true);
  assert.equal(result.enabled, true);
  assert.equal(result.stoppedCanStart, true);
  assert.match(result.pending, /待应用/);
  assert.deepEqual(result.actions, [
    "disconnect",
    "open",
    "settings",
    "connect",
  ]);
  assert.deepEqual(result.routes, ["settings"]);
  assert.equal(result.settingsAccelerator, "Command+,");
  assert.equal(result.dark.dark, true);
  assert.equal(result.darkChecked, true);
  assert.equal(result.system.source, "system");
  assert.equal(result.invalid, true);
  assert.equal(result.destroyed, true);
  assert.deepEqual(result.menus, [
    "FlowGate",
    "文件",
    "编辑",
    "显示",
    "窗口",
    "帮助",
  ]);
  checks.push(
    "native image decodes, 18pt plus Retina representation, nonempty transparent silhouette; template status icon; idempotent install/disposal and unchanged snapshot coalescing",
  );
  checks.push(
    "menu state and action wiring; native application menu roles, Settings shortcut and appearance radio state; no native tray/window displayed in fixture",
  );
} finally {
  await app.close();
}
app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    FLOWGATE_TEST_DATA: await mkdtemp(join(output, "data-")),
    FLOWGATE_TEST_VISIBLE: "0",
  },
});
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("flowgate.theme")),
    "system",
  );
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("appearance-dark").click(),
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("flowgate.theme")),
    "dark",
  );
  await page.getByRole("button", { name: "切换浅色外观", exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.shell.request("appearance.get")).source === "light",
  );
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("appearance-system").click(),
  );
  await page.waitForFunction(
    () => localStorage.getItem("flowgate.theme") === "system",
  );
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items[0].submenu.items.find((i) => i.label === "设置…")
      .click(),
  );
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((i) => i.label === "显示")
      .submenu.items.find((i) => i.label === "查找功能…")
      .click(),
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "查找功能" })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  const closeState = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.close();
    app.emit("activate");
    return {
      destroyed: window.isDestroyed(),
      visible: window.isVisible(),
      focused: window.isFocused(),
      focusable: window.isFocusable(),
    };
  });
  assert.deepEqual(closeState, {
    destroyed: false,
    visible: false,
    focused: false,
    focusable: false,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.highContrast = "true";
    document.documentElement.dataset.reducedTransparency = "true";
  });
  const border = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--border")
      .trim(),
  );
  assert.ok(["#77777e", "#a3a3ad"].includes(border));
  await page.screenshot({ path: join(output, "appearance.png") });
  checks.push(
    "real application: default system appearance, native-to-renderer and renderer-to-native theme updates, Settings/search menu navigation, close/reopen retains hidden background safety",
  );
  checks.push(
    "high-contrast CSS rendering checked with explicit presentation attributes; actual macOS 27 device and global accessibility setting toggles not exercised",
  );
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      { passed: true, checks, nativeTrayDisplayed: false },
      null,
      2,
    ),
  );
  console.log(
    "PASS: macOS icons, native menus, menu-bar lifecycle and system appearance",
  );
} finally {
  await app.close();
}
