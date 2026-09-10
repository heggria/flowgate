import { useEffect, useState } from "react";
import type {
  AppearanceSource,
  NativeAppearance,
} from "../../packages/contracts/src/index";
/** Follow the native system preference by default; preserve explicit user overrides. */
export function useAppearance(): [
  "light" | "dark",
  (source: AppearanceSource) => void,
] {
  const [source, setSource] = useState<AppearanceSource>(() => {
    const stored = localStorage.getItem("flowgate.theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [native, setNative] = useState<NativeAppearance>();
  const theme = source === "system" ? (systemDark ? "dark" : "light") : source;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    const unsubscribe = window.shell.onAppearance?.((value) => {
      setSource(value.source);
      setSystemDark(value.dark);
      setNative(value);
    });
    return () => {
      media.removeEventListener("change", changed);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    let active = true;
    localStorage.setItem("flowgate.theme", source);
    // Older compatible shells and presentation fixtures may not expose native appearance.
    void window.shell
      .request("appearance.set", { source })
      .then((value) => {
        const current = value as NativeAppearance | null;
        if (
          active &&
          current &&
          ["system", "light", "dark"].includes(current.source)
        ) {
          setSystemDark(current.dark);
          setNative(current);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [source]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.highContrast = String(
      native?.highContrast ?? false,
    );
    document.documentElement.dataset.reducedTransparency = String(
      native?.reducedTransparency ?? false,
    );
  }, [theme, native]);
  return [theme, setSource];
}
