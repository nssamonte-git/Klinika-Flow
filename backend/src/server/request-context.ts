import { AsyncLocalStorage } from "node:async_hooks";
const context = new AsyncLocalStorage<{ userId: string | null; check: () => void }>();
export const usageActor = () => context.getStore();
export function assertRequestAccess() { context.getStore()?.check(); }
export function withRequestActor<T>(userId: string | null, check: () => void, task: () => T): T { return context.run({ userId, check }, task); }
