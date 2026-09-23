/**
 * 全局状态（AGENTS.md §10：共享状态统一 Zustand；主题本地持久化；服务端事实以 API 返回为准）。
 * 轮询：页面可见 8s，失败退避 30s（spec 失败路径）；轮询仅刷新投影，不持有状态机所有权。
 */
import { create } from 'zustand';
import { api, onUnauthorized } from '../api/client';
import type { ApiAction, ApiUser } from '../api/types';
import type { UserRole } from '../lib/governance';

export type View = 'login' | 'board' | 'console' | 'assets' | 'usage' | 'audit';
export type Theme = 'light' | 'dark';

interface AppState {
  view: View;
  user: ApiUser | undefined;
  theme: Theme;
  actions: readonly ApiAction[];
  boardError: string | undefined;
  loading: boolean;
  booted: boolean;

  boot: () => Promise<void>;
  navigate: (view: View) => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  toggleTheme: () => void;
  refreshBoard: () => Promise<void>;
}

const THEME_KEY = 'skyport-theme';

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('theme-dark', theme === 'dark');
  document.documentElement.classList.toggle('theme-light', theme !== 'dark');
}

export const useApp = create<AppState>((set, get) => ({
  view: 'login',
  user: undefined,
  theme: 'light',
  actions: [],
  boardError: undefined,
  loading: false,
  booted: false,

  boot: async () => {
    applyTheme(get().theme);
    try {
      const { user } = await api.me();
      set({ user: user ?? undefined, view: user === null ? 'login' : 'board', booted: true });
      if (user !== null) await get().refreshBoard();
    } catch {
      set({ view: 'login', booted: true });
    }
  },

  navigate: (view) => {
    set({ view });
    const path = view === 'login' ? '/login' : view === 'assets' ? '/assets' : view === 'usage' ? '/usage' : view === 'console' ? '/console' : view === 'audit' ? '/audit' : '/';
    history.pushState(null, '', path);
  },

  login: async (username, password) => {
    const { user } = await api.login(username, password);
    set({ user, view: 'board', boardError: undefined });
    history.pushState(null, '', '/');
    await get().refreshBoard();
  },

  logout: async () => {
    await api.logout().catch(() => undefined);
    set({ user: undefined, view: 'login', actions: [] });
    history.pushState(null, '', '/login');
  },

  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  refreshBoard: async () => {
    if (document.visibilityState === 'hidden') return;
    set({ loading: true });
    try {
      const page = await api.listActions();
      set({ actions: page.actions, boardError: undefined, loading: false });
    } catch (error) {
      set({ loading: false, boardError: error instanceof Error ? error.message : '刷新失败' });
    }
  },
}));

/** 启动时恢复主题 + 注册 401 全局跳登录（防回环：login 端点自身不触发） */
export function initStore(): void {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') {
    useApp.setState({ theme: saved });
    applyTheme(saved);
  } else {
    applyTheme('light');
  }
  onUnauthorized(() => useApp.setState({ user: undefined, view: 'login' }));
}

/** 角色便捷读取（viewer 起步；未登录视为无角色） */
export function currentRole(): UserRole | undefined {
  return useApp.getState().user?.role;
}
