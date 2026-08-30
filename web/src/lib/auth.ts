import type { RbacRole } from './types';

const ACCESS_KEY = 'cronmon.access';
const REFRESH_KEY = 'cronmon.refresh';
const USER_KEY = 'cronmon.user';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roles: RbacRole[];
}

export const authStore = {
  accessToken: (): string | null => localStorage.getItem(ACCESS_KEY),
  refreshToken: (): string | null => localStorage.getItem(REFRESH_KEY),
  user: (): AuthUser | null => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  },
  set: (session: { accessToken: string; refreshToken: string; user: AuthUser }): void => {
    localStorage.setItem(ACCESS_KEY, session.accessToken);
    localStorage.setItem(REFRESH_KEY, session.refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(session.user));
    window.dispatchEvent(new Event('cronmon:auth'));
  },
  setAccess: (accessToken: string, refreshToken: string): void => {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear: (): void => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new Event('cronmon:auth'));
  },
  isAuthed: (): boolean => localStorage.getItem(ACCESS_KEY) != null,
};
