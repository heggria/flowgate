export function isContextReplacementError(error: unknown): boolean;
export function waitForAsyncPredicate(
  read: () => Promise<boolean>,
  options?: {
    timeout?: number;
    polling?: number;
    retryOnError?: (error: unknown) => boolean;
  },
): Promise<void>;
