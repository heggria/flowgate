import { client } from "../../packages/client/src/index";
import {
  createContext,
  useContext,
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Configuration } from "../../packages/contracts/src/index";
import { Icon } from "./icons";

/** Pending actions remain focusable; unavailable actions retain native disabled semantics. */
export function Button({
  pending = false,
  disabled,
  onClick,
  title,
  ...props
}: ComponentProps<"button"> & { pending?: boolean }) {
  const id = useId();
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    tooltip.current?.hidePopover();
  };
  const show = (button: HTMLButtonElement) => {
    hide();
    timer.current = setTimeout(() => {
      const el = tooltip.current;
      if (!el || !button.isConnected) return;
      el.showPopover();
      const r = button.getBoundingClientRect(),
        box = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.width - 8))}px`;
      el.style.top = `${r.bottom + box.height + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - box.height - 6)}px`;
    }, 450);
  };
  useEffect(() => {
    if (!title) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [title]);
  return (
    <>
      <button
        {...props}
        disabled={disabled}
        aria-describedby={
          title
            ? [props["aria-describedby"], id].filter(Boolean).join(" ")
            : props["aria-describedby"]
        }
        aria-disabled={pending || props["aria-disabled"] || undefined}
        aria-busy={pending || props["aria-busy"] || undefined}
        onPointerEnter={(e) => {
          if (title) show(e.currentTarget);
          props.onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          if (timer.current) clearTimeout(timer.current);
          if (title) timer.current = setTimeout(hide, 120);
          props.onPointerLeave?.(e);
        }}
        onFocus={(e) => {
          if (title) show(e.currentTarget);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          hide();
          props.onBlur?.(e);
        }}
        onClick={(event) => {
          hide();
          if (
            pending ||
            props["aria-disabled"] === true ||
            props["aria-disabled"] === "true"
          ) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onClick?.(event);
        }}
      />
      {title ? (
        <span
          ref={tooltip}
          id={id}
          role="tooltip"
          popover="manual"
          className="controltooltip"
          onPointerEnter={() => {
            if (timer.current) clearTimeout(timer.current);
          }}
          onPointerLeave={hide}
        >
          {title}
        </span>
      ) : null}
    </>
  );
}
/** A pending switch/radio keeps its native keyboard position without accepting another change. */
export function Toggle({
  pending = false,
  onChange,
  onClick,
  onKeyDown,
  ...props
}: ComponentProps<"input"> & { pending?: boolean }) {
  return (
    <input
      {...props}
      aria-disabled={pending || props["aria-disabled"] || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      onChange={(event) => {
        if (!pending) onChange?.(event);
      }}
      onKeyDown={(event) => {
        if (
          pending &&
          [" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          return;
        }
        onKeyDown?.(event);
      }}
    />
  );
}
const FooterContext = createContext<{
  host: HTMLDivElement | null;
  formId: string;
} | null>(null);

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
/** Resolve menu items to their persistent trigger before the popup closes. */
export function focusReturnTarget(
  element: HTMLElement | null,
): HTMLElement | null {
  return (
    element?.closest(".actionmenu")?.querySelector<HTMLElement>("summary") ??
    element
  );
}
export function restoreFocus(element: HTMLElement | null) {
  if (element?.isConnected && element.getClientRects().length)
    element.focus({ preventScroll: true });
  else {
    const heading = document.querySelector<HTMLElement>(".content h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }
}
/** Both choice and action popovers use the same viewport bounds and flip behavior. */
function placePopover(
  anchor: HTMLElement,
  popup: HTMLElement,
  minWidth: number,
  maxHeight: number,
  alignEnd = false,
) {
  const rect = anchor.getBoundingClientRect(),
    edge = 12,
    gap = 6;
  const width = Math.min(Math.max(rect.width, minWidth), innerWidth - edge * 2);
  const below = Math.max(0, innerHeight - rect.bottom - edge - gap);
  const above = Math.max(0, rect.top - edge - gap);
  const upward = below < Math.min(230, maxHeight) && above > below;
  const height = Math.min(
    maxHeight,
    Math.max(above, below),
    innerHeight - edge * 2,
  );
  Object.assign(popup.style, {
    width: `${width}px`,
    maxHeight: `${height}px`,
    left: `${Math.max(edge, Math.min(alignEnd ? rect.right - width : rect.left, innerWidth - width - edge))}px`,
  });
  popup.style.setProperty("--options-height", `${Math.max(24, height - 52)}px`);
  const actualHeight = popup.getBoundingClientRect().height;
  popup.style.top = `${Math.max(edge, Math.min(upward ? rect.top - actualHeight - gap : rect.bottom + gap, innerHeight - actualHeight - edge))}px`;
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
    descriptionId = useId(),
    formId = useId();
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current!,
      trigger = focusReturnTarget(document.activeElement as HTMLElement | null);
    const form = element.querySelector("form");
    if (form) form.id = formId;
    element.showModal();
    const firstField =
      element.querySelector<HTMLElement>("[data-autofocus]") ??
      element.querySelector<HTMLElement>(
        ".dialogcontent input:not([type=hidden]), .dialogcontent textarea, .dialogcontent select, .dialogcontent .selecttrigger",
      );
    firstField?.focus({ preventScroll: true });
    return () => {
      element.close();
      restoreFocus(trigger);
    };
  }, []);
  return createPortal(
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
        <Button
          type="button"
          className="iconbutton dialogclose"
          aria-label="关闭表单"
          pending={Boolean(busy)}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </Button>
        <h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}
      </header>
      <div className="dialogcontent">
        <fieldset className="taskfields" disabled={busy}>
          <FooterContext.Provider value={{ host: footerHost, formId }}>
            {children}
          </FooterContext.Provider>
        </fieldset>
        <div ref={setFooterHost} />
        {busy && onCancelRequest ? (
          <div className="taskprogress">
            <span role="status">正在处理，请稍候…</span>
            <Button type="button" className="quiet" onClick={onCancelRequest}>
              取消请求
            </Button>
          </div>
        ) : null}
      </div>
    </dialog>,
    document.body,
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
  const context = useContext(FooterContext);
  const footer = (
    <footer className="dialogfooter">
      <span>{hint}</span>
      <Button
        type="button"
        className="secondary"
        pending={Boolean(pending)}
        onClick={onClose}
      >
        取消
      </Button>
      <Button
        className="primary"
        form={context?.formId}
        pending={pending}
        disabled={!ready}
      >
        {pending ? (
          <>
            <span className="buttonspinner" />
            处理中…
          </>
        ) : (
          label
        )}
      </Button>
    </footer>
  );
  return context
    ? context.host
      ? createPortal(footer, context.host)
      : null
    : footer;
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
    ...(config.groups ?? []).map((group) => ({
      value: group.id,
      label: group.name,
      detail: `${group.members.length} 个成员`,
      group: "策略组",
    })),
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
  const placement = useRef<DOMRect | null>(null);
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
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    popover.current.showPopover();
    placePopover(button.current, popover.current, 280, 316);
    placement.current = button.current.getBoundingClientRect();
    setOpen(true);
    input.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (open && button.current && popover.current) {
      placePopover(button.current, popover.current, 280, 316);
      placement.current = button.current.getBoundingClientRect();
    }
  }, [open, query, options.length]);
  useEffect(() => {
    if (!open) return;
    const close = () => dismiss(false);
    const scroll = (event: Event) => {
      if (popover.current?.contains(event.target as Node)) return;
      const rect = button.current?.getBoundingClientRect(),
        previous = placement.current;
      // A scroll queued before opening must not dismiss a correctly placed popup.
      if (
        !rect ||
        !previous ||
        rect.top !== previous.top ||
        rect.left !== previous.left
      )
        close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  return (
    <div className="combobox">
      <Button
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
      </Button>
      <div
        ref={popover}
        popover="auto"
        className="selectpopover"
        onToggle={(e) => setOpen(e.newState === "open")}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
          }
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            setActive(
              (n) =>
                (n + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                Math.max(1, filtered.length),
            );
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[active]) choose(filtered[active]);
          }
          if (e.key === "Tab") dismiss();
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
                  if (el && index === active && open) {
                    const list = el.closest<HTMLElement>(".selectoptions");
                    if (!list) return;
                    const item = el.getBoundingClientRect(),
                      bounds = list.getBoundingClientRect();
                    if (item.top < bounds.top)
                      list.scrollTop -= bounds.top - item.top;
                    else if (item.bottom > bounds.bottom)
                      list.scrollTop += item.bottom - bounds.bottom;
                  }
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
  const ref = useRef<HTMLDetailsElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const placement = useRef<DOMRect | null>(null);
  const pendingDirection = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);
  const close = (restore = false) => {
    popup.current?.hidePopover();
    ref.current?.removeAttribute("open");
    setOpen(false);
    if (restore) ref.current?.querySelector<HTMLElement>("summary")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const resize = () => close();
    const scroll = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) return;
      const rect = ref.current
          ?.querySelector("summary")
          ?.getBoundingClientRect(),
        previous = placement.current;
      if (
        !rect ||
        !previous ||
        rect.top !== previous.top ||
        rect.left !== previous.left
      )
        close();
    };
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  return (
    <details
      ref={ref}
      className="actionmenu"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (ref.current?.open && popup.current) {
          popup.current.showPopover();
          placePopover(
            ref.current.querySelector("summary")!,
            popup.current,
            152,
            320,
            true,
          );
          placement.current = ref.current
            .querySelector("summary")!
            .getBoundingClientRect();
          setOpen(true);
          const buttons = popup.current.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          );
          buttons[
            pendingDirection.current === "last" ? buttons.length - 1 : 0
          ]?.focus({ preventScroll: true });
          pendingDirection.current = "first";
        } else close();
      }}
    >
      <summary
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        title={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            pendingDirection.current =
              event.key === "ArrowUp" ? "last" : "first";
            ref.current!.open = true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close(true);
          }
        }}
      >
        •••
      </summary>
      <div
        ref={popup}
        popover="auto"
        className="actionitems"
        onToggle={(event) => {
          if (
            event.target === event.currentTarget &&
            event.newState === "closed"
          ) {
            ref.current?.removeAttribute("open");
            setOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (!popup.current?.contains(event.target as Node)) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(
              popup.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ) ?? [],
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            buttons[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length
            ]?.focus();
          }
          if (event.key === "Tab") close(true);
        }}
        onClick={(event) => {
          if (!popup.current?.contains(event.target as Node)) return;
          if ((event.target as Element).closest("button:not(:disabled)"))
            close(Boolean(popup.current?.contains(document.activeElement)));
        }}
      >
        {children}
      </div>
    </details>
  );
}

/** Resource controls share accessible labels, clear behavior and visual tokens. */
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
  clearLabel,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  clearLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="searchfield">
      <Icon name="search" size={15} />
      <input
        ref={input}
        type="text"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <Button
          type="button"
          aria-label={clearLabel ?? `清空${label}`}
          onClick={() => {
            onChange("");
            input.current?.focus({ preventScroll: true });
          }}
        >
          <Icon name="close" size={13} />
        </Button>
      ) : null}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  icon = "nodes",
  children,
  compact = false,
}: {
  title: string;
  description?: string;
  icon?: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`emptystate ${compact ? "compactempty" : "resourceempty"}`}>
      <span className="emptyglyph">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {children}
    </div>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
  wrap = false,
}: {
  children: ReactNode;
  wrap?: boolean;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`badge badge-${tone} ${wrap ? "badge-wrap" : ""}`}>
      {children}
    </span>
  );
}
export function Disclosure({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`disclosure ${className}`}>
      <summary>
        <Icon name="chevron" size={12} />
        <span>{title}</span>
      </summary>
      <div className="disclosurebody">{children}</div>
    </details>
  );
}
