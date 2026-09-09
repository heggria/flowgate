import { useEffect, useRef, useState } from "react";
export function useDraft<T extends object>(key: string, initial: T) {
  const [value, setValue] = useState(initial),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const edited = useRef(false),
    latest = useRef(value);
  useEffect(() => {
    let alive = true;
    void window.shell
      .request("ui.draft.get", { key })
      .then((saved) => {
        if (!alive) return;
        if (
          saved &&
          typeof saved === "object" &&
          !Array.isArray(saved) &&
          !edited.current
        ) {
          const restored = { ...initial, ...saved };
          latest.current = restored;
          setValue(restored);
        }
        setReady(true);
      })
      .catch(() => {
        if (alive) {
          setReady(true);
          setError("草稿恢复失败，请检查输入");
        }
      });
    return () => {
      alive = false;
    };
  }, [key]);
  const change = (patch: Partial<T>) => {
    edited.current = true;
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setValue(next);
    void window.shell
      .request("ui.draft.set", { key, value: next })
      .then(() => setError(""))
      .catch(() => setError("草稿未保存，请暂缓更新界面"));
  };
  const clear = async (next: T) => {
    await window.shell.request("ui.draft.set", { key, value: null });
    latest.current = next;
    setValue(next);
    setError("");
  };
  return { value, change, clear, ready, error };
}
