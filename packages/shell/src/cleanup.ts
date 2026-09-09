export async function cleanupStages(
  stages: { name: string; run: () => Promise<void> }[],
) {
  const failures: Error[] = [];
  for (const stage of stages) {
    try {
      await stage.run();
    } catch (cause) {
      failures.push(new Error(`Cleanup failed: ${stage.name}`, { cause }));
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "退出清理未全部完成，可以重试");
}
