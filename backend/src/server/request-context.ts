import { AsyncLocalStorage } from "node:async_hooks";
const context = new AsyncLocalStorage<{ userId: string | null; check: () => void }>();
const reservations = new AsyncLocalStorage<(id: string) => void>();
const agentGuard = new AsyncLocalStorage<() => void>();
export function withAgentGuard<T>(guard: () => void, task: () => T): T { return agentGuard.run(guard, task); }
export const observeReservation = (id: string) => reservations.getStore()?.(id);
export function withReservationObserver<T>(observer: (id: string) => void, task: () => T): T { return reservations.run(observer, task); }
export const usageActor = () => context.getStore();
export function assertRequestAccess() { context.getStore()?.check(); agentGuard.getStore()?.(); }
export function withRequestActor<T>(userId: string | null, check: () => void, task: () => T): T { return context.run({ userId, check }, task); }
