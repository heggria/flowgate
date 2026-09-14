import {
  adviseFailure,
  navigateToRecovery,
} from "../../packages/client/src/problems";
export function RecoveryLinks({ message }: { message: string }) {
  const advice = adviseFailure(message);
  return (
    <span className="recoverylinks">
      <button
        type="button"
        className="quiet"
        onClick={() => navigateToRecovery(advice.target)}
      >
        {advice.label}
      </button>
    </span>
  );
}
