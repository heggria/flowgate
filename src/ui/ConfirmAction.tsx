import { useRef, useState } from "react";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="quiet dangertext"
        disabled={disabled}
        onClick={() => {
          setError("");
          dialog.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="confirmdialog"
        aria-label={title}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2>{title}</h2>
        <p>{description}</p>
        {error ? (
          <p className="taskerror" role="alert">
            {error}
          </p>
        ) : null}
        <div className="formactions">
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
                  error instanceof Error ? error.message : "操作失败，请重试。",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "处理中…" : `确认${label}`}
          </button>
        </div>
      </dialog>
    </>
  );
}
