import { Menu, nativeTheme } from "electron";
import type {
  NativeAppearance,
  AppearanceSource,
} from "../../contracts/src/index";
const listeners = new Set<() => void>();
function notifyAppearance() {
  syncAppearanceMenu();
  for (const listener of listeners) listener();
}
export function subscribeAppearance(listener: () => void) {
  if (!listeners.size) nativeTheme.on("updated", notifyAppearance);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size)
      nativeTheme.removeListener("updated", notifyAppearance);
  };
}
export function readAppearance(): NativeAppearance {
  return {
    source: nativeTheme.themeSource,
    dark: nativeTheme.shouldUseDarkColors,
    highContrast: nativeTheme.shouldUseHighContrastColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    differentiateWithoutColor: nativeTheme.shouldDifferentiateWithoutColor,
  };
}
export function setAppearance(source: unknown) {
  if (
    typeof source !== "string" ||
    !["system", "light", "dark"].includes(source)
  )
    throw new Error("无效外观选项");
  nativeTheme.themeSource = source as AppearanceSource;
  // A source change (light -> system) need not change pixels or emit updated.
  notifyAppearance();
  return readAppearance();
}
export function syncAppearanceMenu() {
  for (const source of ["system", "light", "dark"]) {
    const item = Menu.getApplicationMenu()?.getMenuItemById(
      "appearance-" + source,
    );
    if (item) item.checked = source === nativeTheme.themeSource;
  }
}
