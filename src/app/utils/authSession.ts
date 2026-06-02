import type { Role, User } from "../store";

const AUTH_SESSION_KEY = "fishroom-auth-session";
export const AUTH_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

type AuthSession = {
  username: string;
  role: Role;
  expiresAt: number;
};

function readSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Partial<AuthSession>;
    if (
      typeof session.username !== "string" ||
      (session.role !== "admin" && session.role !== "staff") ||
      typeof session.expiresAt !== "number"
    ) {
      clearAuthSession();
      return null;
    }
    return session as AuthSession;
  } catch {
    clearAuthSession();
    return null;
  }
}

export function saveAuthSession(user: NonNullable<User>) {
  const session: AuthSession = {
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  };
  window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

export function clearAuthSession() {
  window.localStorage.removeItem(AUTH_SESSION_KEY);
}

export function getValidAuthSession(): AuthSession | null {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    clearAuthSession();
    return null;
  }
  return session;
}

export function getAuthSessionExpiresAt() {
  return getValidAuthSession()?.expiresAt ?? null;
}
