import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceContext } from "../../contracts/src/index";
// One scope per asynchronous call chain; sibling operations never share context.
export const requestTrace = new AsyncLocalStorage<TraceContext>();
