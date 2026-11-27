// Talking to the program through the one allowed door (see src/main/apiHost.ts).
interface Result { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }
declare global {
  interface Window { api: { invoke(method: string, args: unknown[]): Promise<Result> } }
}
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}
export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const r = await window.api.invoke(method, args);
  if (!r.ok) throw new ApiError(r.error?.message ?? 'Something went wrong', r.error?.code ?? 'INTERNAL', r.error?.details);
  return r.data as T;
}
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface User { id: number; username: string; displayName: string; role: 'OWNER' | 'EMPLOYEE'; mustChangePassword: boolean; permissions: string[] }
export const can = (u: User, ...perms: string[]): boolean => u.role === 'OWNER' || perms.some((p) => u.permissions.includes(p));
