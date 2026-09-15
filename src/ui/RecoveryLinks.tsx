import {
  adviseFailure,
  navigateToRecovery,
  problems,
  safeMessage,
} from "../../packages/client/src/problems";
import { useState } from "react";
import { client, shellRequest } from "../../packages/client/src/index";
import {
  RECOVERY_DISCONNECT_OPERATION_ID,
  type AppSnapshot,
  type KernelState,
} from "../../packages/contracts/src/index";
export function RecoveryLinks({ message }: { message: string }) {
  const advice = adviseFailure(message);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const state = await shellRequest<KernelState>("recovery.disconnect");
      if (
        state.status !== "stopped" ||
        state.operationId !== RECOVERY_DISCONNECT_OPERATION_ID
      )
        throw new Error("断开结果尚未明确，请稍后重新核对");
      await client.request("operation.get", {
        id: RECOVERY_DISCONNECT_OPERATION_ID,
      });
      const current = await client.request<AppSnapshot>("snapshot");
      if (
        current.operations.some(
          (operation) =>
            operation.state === "unknown" &&
            ["proxy.connect", "proxy.disconnect"].includes(operation.kind),
        )
      )
        throw new Error(
          "旧的辅助服务结果仍无法核实，请在设置中检查辅助服务后重试",
        );
      setFeedback("已断开并核对，可以重新连接。");
    } catch (error) {
      const detail = safeMessage(error);
      setFeedback(detail);
      if (
        !problems
          .snapshot()
          .some((problem) => !problem.resolved && problem.message === detail)
      )
        problems.report("recovery.disconnect", error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="recoverylinks">
      <button
        type="button"
        className="quiet"
        onClick={() => navigateToRecovery(advice.target)}
      >
        {advice.label}
      </button>
      {advice.code === "STATE_UNKNOWN" ? (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void disconnect()}
        >
          {busy ? "正在断开并核对…" : "断开并重新核对"}
        </button>
      ) : null}
      {feedback ? <span role="status">{feedback}</span> : null}
    </span>
  );
}
