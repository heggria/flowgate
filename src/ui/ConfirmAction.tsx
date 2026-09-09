import { createPortal } from "react-dom";
import { focusReturnTarget, restoreFocus } from "./components";
import { useId, useRef, useState } from "react";

/** Native dialog supplies focus containment, Escape and focus restoration. */
export function ConfirmAction({
  label,
  title,
  description,
  onConfirm,
  disabled = false,
}: {
  label: string;
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const titleId = useId(),
    descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    returnTarget = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="quiet dangertext"
        disabled={disabled}
        type="button"
        onClick={(event) => {
          returnTarget.current = focusReturnTarget(event.currentTarget);
          setError("");
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          onClose={() => restoreFocus(returnTarget.current)}
          className="taskdialog confirmdialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <header className="dialogheading">
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </header>
          <div className="dialogcontent">
            {error ? (
              <p className="taskerror" role="alert">
                {error}
              </p>
            ) : null}
            <footer className="dialogfooter">
              <button
                autoFocus
                className="secondary"
                disabled={pending}
                onClick={() => dialog.current?.close()}
              >
                取消
              </button>
              <button
                className="dangerbutton"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    const result = await onConfirm();
                    if (result === false)
                      setError("未能移除，请检查应用提示后重试。");
                    else dialog.current?.close();
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "操作失败，请重试。",
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? "处理中…" : `确认${label}`}
              </button>
            </footer>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
