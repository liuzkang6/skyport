/**
 * 全局状态（AGENTS.md §10：共享状态统一 Zustand；主题本地持久化；服务端事实以 API 返回为准）。
 * 轮询：页面可见 8s，失败退避 30s（spec 失败路径）；轮询仅刷新投影，不持有状态机所有权。
 */
import { create } from 'zustand';
import { api, onUnauthorized } from '../api/client';
import type { ApiAction, ApiUser } from '../api/types';
import type { UserRole } from '../lib/governance';

export type View = 'login' | 'board' | 'console' | 'assets' | 'usage' | 'audit' | 'settings' | 'inbox' | 'incidents' | 'knowledge' | 'mine' | 'governance';
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

/** 视图 ↔ URL 单一映射表（navigate 推入 / boot 深链读取，两处不再各写一遍） */
const VIEW_PATHS: Readonly<Record<View, string>> = {
  login: '/login', board: '/', console: '/console', assets: '/assets', usage: '/usage',
  audit: '/audit', settings: '/settings', inbox: '/inbox', incidents: '/incidents',
  knowledge: '/knowledge', mine: '/mine', governance: '/governance',
};

function pathOfView(view: View): string {
  return VIEW_PATHS[view];
}

/** URL → 视图（boot 深链 + popstate 共用；未知路径落看板） */
export function viewFromPath(pathname: string): View {
  const found = (Object.keys(VIEW_PATHS) as View[]).find((v) => VIEW_PATHS[v] === pathname);
  return found ?? 'board';
}

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
      // 初始路由：直接访问 /assets 等深链时跟随 URL，而非一律落看板
      const fromUrl = viewFromPath(location.pathname);
      set({ user: user ?? undefined, view: user === null ? 'login' : fromUrl, booted: true });
      if (user !== null) await get().refreshBoard();
    } catch {
      set({ view: 'login', booted: true });
    }
  },

  navigate: (view) => {
    set({ view });
    history.pushState(null, '', pathOfView(view));
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
