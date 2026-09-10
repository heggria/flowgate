import { createPortal } from "react-dom";
import { Button, focusReturnTarget, restoreFocus } from "./components";
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
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
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
      </Button>
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
              <Button
                autoFocus
                className="secondary"
                pending={Boolean(pending)}
                onClick={() => dialog.current?.close()}
              >
                取消
              </Button>
              <Button
                className="dangerbutton"
                pending={Boolean(pending)}
                onClick={async () => {
                  if (active.current) return;
                  active.current = true;
                  setError("");
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
                    active.current = false;
                    setPending(false);
                  }
                }}
              >
                {pending ? "处理中…" : `确认${label}`}
              </Button>
            </footer>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
