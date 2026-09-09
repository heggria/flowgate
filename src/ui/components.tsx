import { client } from "../../packages/client/src/index";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Configuration } from "../../packages/contracts/src/index";
import { Icon } from "./icons";

export function useTask() {
  const active = useRef(false),
    operation = useRef<string | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const execute = async (action: () => Promise<unknown>) => {
    if (active.current) return false;
    active.current = true;
    operation.current = crypto.randomUUID();
    setPending(true);
    setError("");
    try {
      const result = await action();
      if (result === false) {
        setError("未保存更改，请检查输入与应用提示后重试。");
        return false;
      }
      return true;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/,
              "",
            )
          : "操作失败，请重试。",
      );
      return false;
    } finally {
      active.current = false;
      operation.current = null;
      setPending(false);
    }
  };
  const request = <T,>(method: string, payload?: unknown) =>
    client.request<T>(
      method,
      payload,
      operation.current ?? crypto.randomUUID(),
    );
  const cancel = async () => {
    if (operation.current) {
      try {
        await client.cancel(operation.current);
      } catch {
        setError("取消请求失败，请等待当前操作结束。");
      }
    }
  };
  return { pending, error, execute, setError, request, cancel };
}
export function Modal({
  title,
  description,
  onClose,
  children,
  busy = false,
  icon = "nodes",
  onCancelRequest,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  icon?: string;
  onCancelRequest?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    descriptionId = useId();
  useEffect(() => {
    const element = ref.current!,
      trigger = document.activeElement as HTMLElement | null;
    element.showModal();
    const firstField =
      element.querySelector<HTMLElement>("[data-autofocus]") ??
      element.querySelector<HTMLElement>(
        ".dialogcontent input:not([type=hidden]), .dialogcontent textarea, .dialogcontent select, .dialogcontent .selecttrigger",
      );
    firstField?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="taskdialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialogheading">
        <span className="dialogicon">
          <Icon name={icon} size={19} />
        </span>
        <button
          type="button"
          className="iconbutton dialogclose"
          aria-label="关闭表单"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
        <h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}
      </header>
      <div className="dialogcontent">
        <fieldset className="taskfields" disabled={busy}>
          {children}
        </fieldset>
        {busy && onCancelRequest ? (
          <div className="taskprogress">
            <span>正在处理，请稍候…</span>
            <button type="button" className="quiet" onClick={onCancelRequest}>
              取消请求
            </button>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
export function Field({
  label,
  id,
  hint,
  error,
  children,
  optional = false,
}: {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <div className={`field ${error ? "invalidfield" : ""}`}>
      <label htmlFor={id}>
        {label}
        {optional ? <span>可选</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-hint`} className="fielderror" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="fieldhint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
export function FormFooter({
  onClose,
  pending,
  ready = true,
  label,
  hint = "关闭后保留草稿",
}: {
  onClose: () => void;
  pending: boolean;
  ready?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <footer className="dialogfooter">
      <span>{hint}</span>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={onClose}
      >
        取消
      </button>
      <button className="primary" disabled={pending || !ready}>
        {pending ? (
          <>
            <span className="buttonspinner" />
            处理中…
          </>
        ) : (
          label
        )}
      </button>
    </footer>
  );
}
export function TaskError({ message }: { message?: string }) {
  return message ? (
    <p className="taskerror" role="alert">
      {message}
    </p>
  ) : null;
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="resourceheading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="headingactions">{children}</div>
    </div>
  );
}
export function SettingRow({
  label,
  description,
  children,
  htmlFor,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="settingrow">
      <div className="settingcopy">
        <label htmlFor={htmlFor}>{label}</label>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settingcontrol">{children}</div>
    </div>
  );
}
export interface Choice {
  value: string;
  label: string;
  detail?: string;
  group?: string;
}
export function outletChoices(config: Configuration): Choice[] {
  return [
    {
      value: "select",
      label: "所选节点",
      detail: "随当前所选节点切换",
      group: "通用出口",
    },
    {
      value: "direct",
      label: "直连",
      detail: "直接访问目标",
      group: "通用出口",
    },
    {
      value: "block",
      label: "阻断",
      detail: "拒绝匹配的连接",
      group: "通用出口",
    },
    ...config.nodes.map((n) => ({
      value: n.id,
      label: n.name,
      detail: `${n.type} · ${n.server}:${n.port}`,
      group: "代理节点",
    })),
    ...(config.externalNetworks ?? []).map((n) => ({
      value: n.id,
      label: n.name,
      detail: n.interface,
      group: "外部网络",
    })),
  ];
}
/** Native popover handles outside dismissal; listbox focus remains on the search input. */
export function Combobox({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "请选择",
}: {
  id?: string;
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const generated = useId(),
    key = id ?? generated,
    listId = `${key}-list`;
  const button = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const filtered = options.filter((o) =>
    `${o.label} ${o.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selected = options.find((o) => o.value === value);
  const dismiss = (restore = true) => {
    popover.current?.hidePopover();
    setOpen(false);
    if (restore) button.current?.focus();
  };
  const choose = (option: Choice) => {
    onChange(option.value);
    dismiss();
  };
  const show = () => {
    if (!button.current || !popover.current) return;
    const rect = button.current.getBoundingClientRect(),
      width = Math.min(Math.max(rect.width, 280), innerWidth - 32);
    const below = innerHeight - rect.bottom - 18;
    const above = rect.top - 18;
    const upward = below < 230 && above > below;
    const height = Math.min(316, Math.max(160, upward ? above : below));
    Object.assign(popover.current.style, {
      width: `${width}px`,
      left: `${Math.min(rect.left, innerWidth - width - 16)}px`,
      top: `${upward ? Math.max(16, rect.top - height - 6) : rect.bottom + 6}px`,
      maxHeight: `${height}px`,
    });
    popover.current.style.setProperty("--options-height", `${height - 52}px`);
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    popover.current.showPopover();
    setOpen(true);
    input.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const close = () => dismiss(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);
  return (
    <div className="combobox">
      <button
        ref={button}
        id={id}
        type="button"
        className="selecttrigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? dismiss() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className={selected ? "" : "placeholder"}>
          {selected?.label ?? (value ? "不可用出口" : placeholder)}
        </span>
        <Icon name="chevron" size={12} />
      </button>
      <div
        ref={popover}
        popover="auto"
        className="selectpopover"
        onToggle={(e) => setOpen(e.newState === "open")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            setActive((n) =>
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? filtered.length - 1
                  : (n + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                    Math.max(1, filtered.length),
            );
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[active]) choose(filtered[active]);
          }
          if (e.key === "Tab") dismiss(false);
        }}
      >
        <div className="selectsearch">
          <Icon name="search" size={15} />
          <input
            ref={input}
            role="combobox"
            aria-label={`搜索${label}`}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={
              filtered[active] ? `${key}-option-${active}` : undefined
            }
            value={query}
            placeholder="搜索名称或地址…"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="selectoptions"
        >
          {filtered.map((option, index) => (
            <div key={option.value}>
              {option.group &&
              (index === 0 || filtered[index - 1].group !== option.group) ? (
                <div className="optiongroup">{option.group}</div>
              ) : null}
              <div
                role="option"
                id={`${key}-option-${index}`}
                aria-selected={option.value === value}
                className={`selectoption ${active === index ? "activeoption" : ""}`}
                onMouseMove={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                ref={(el) => {
                  if (el && index === active && open)
                    el.scrollIntoView({ block: "nearest" });
                }}
              >
                <div>
                  <strong>{option.label}</strong>
                  {option.detail ? <small>{option.detail}</small> : null}
                </div>
                {option.value === value ? <span>✓</span> : null}
              </div>
            </div>
          ))}
          {!filtered.length ? (
            <div className="optionempty">没有匹配选项，试试其他关键词。</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
export function ActionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node))
        ref.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      ref={ref}
      className="actionmenu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          ref.current?.removeAttribute("open");
          ref.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={label} title={label}>
        •••
      </summary>
      <div
        className="actionitems"
        onClick={(e) => {
          if (
            (e.target as Element).closest("button:not(:disabled)") &&
            !ref.current?.querySelector("dialog[open]")
          )
            ref.current?.removeAttribute("open");
        }}
      >
        {children}
      </div>
    </details>
  );
}
