import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '@/api/client';

export interface AuthUser {
  id: number;
  name: string;
  nickname?: string | null;
  role: 'parent' | 'child';
  avatar?: string;
  identity?: string | null;
  isPrimary?: boolean;
  totalPoints?: number;
}

type Role = 'parent' | 'child';

/**
 * 家长和孩子各自保存一份登录态：
 *   · 同一个浏览器可以同时登录家长和孩子，互不覆盖
 *   · 当前用哪份 token 由路由决定（/parent/* 用家长，/child/* 用孩子）
 *   · 退出只清当前角色，另一个身份仍然保持登录
 */
const KEYS: Record<Role, { token: string; user: string }> = {
  parent: { token: 'mj_parent_token', user: 'mj_parent_user' },
  child: { token: 'mj_child_token', user: 'mj_child_user' },
};

/** 老版本只有一个 mj_token/mj_user，升级后按角色搬过去 */
function migrateLegacy() {
  const token = localStorage.getItem('mj_token');
  const rawUser = localStorage.getItem('mj_user');
  if (!token || !rawUser) return;
  try {
    const parsed = JSON.parse(rawUser) as AuthUser;
    const role: Role = parsed.role === 'child' ? 'child' : 'parent';
    const keys = KEYS[role];
    if (!localStorage.getItem(keys.token)) localStorage.setItem(keys.token, token);
    if (!localStorage.getItem(keys.user)) localStorage.setItem(keys.user, rawUser);
  } catch {
    /* 老的 user 数据坏了就放弃迁移 */
  }
  localStorage.removeItem('mj_token');
  localStorage.removeItem('mj_user');
}

function readUser(role: Role): AuthUser | null {
  try {
    return JSON.parse(localStorage.getItem(KEYS[role].user) || 'null');
  } catch {
    return null;
  }
}

migrateLegacy();

export const useAuthStore = defineStore('auth', () => {
  const parentToken = ref<string | null>(localStorage.getItem(KEYS.parent.token));
  const parentUser = ref<AuthUser | null>(readUser('parent'));
  const childToken = ref<string | null>(localStorage.getItem(KEYS.child.token));
  const childUser = ref<AuthUser | null>(readUser('child'));

  /** 当前页面所属角色；由路由守卫在每次跳转前设置 */
  const activeRole = ref<Role | null>(null);

  const token = computed(() =>
    activeRole.value === 'parent'
      ? parentToken.value
      : activeRole.value === 'child'
        ? childToken.value
        : null
  );
  const user = computed(() =>
    activeRole.value === 'parent'
      ? parentUser.value
      : activeRole.value === 'child'
        ? childUser.value
        : null
  );

  const isAuthenticated = computed(() => !!token.value && !!user.value);
  const hasParent = computed(() => !!parentToken.value && !!parentUser.value);
  const hasChild = computed(() => !!childToken.value && !!childUser.value);

  /** 切换当前角色，并从 localStorage 重新读一次（另一个标签页刚登录也能同步） */
  function activate(role: Role | null): boolean {
    activeRole.value = role;
    if (!role) return true;
    if (role === 'parent') {
      parentToken.value = localStorage.getItem(KEYS.parent.token);
      parentUser.value = readUser('parent');
    } else {
      childToken.value = localStorage.getItem(KEYS.child.token);
      childUser.value = readUser('child');
    }
    return !!(token.value && user.value);
  }

  function setAuth(role: Role, t: string, u: AuthUser) {
    const keys = KEYS[role];
    if (role === 'parent') {
      parentToken.value = t;
      parentUser.value = u;
    } else {
      childToken.value = t;
      childUser.value = u;
    }
    activeRole.value = role;
    localStorage.setItem(keys.token, t);
    localStorage.setItem(keys.user, JSON.stringify(u));
  }

  function saveActiveUser(u: AuthUser) {
    const role = activeRole.value;
    if (!role) return;
    if (role === 'parent') parentUser.value = u;
    else childUser.value = u;
    localStorage.setItem(KEYS[role].user, JSON.stringify(u));
  }

  async function parentLogin(username: string, password: string) {
    const data = await api.post<{ token: string; user: AuthUser }>(
      '/auth/parent-login',
      { username, password }
    );
    setAuth('parent', data.token, data.user);
  }

  async function childLogin(userId: number, pin: string) {
    const data = await api.post<{ token: string; user: AuthUser }>(
      '/auth/child-login',
      { userId, pin }
    );
    setAuth('child', data.token, data.user);
  }

  async function fetchChildren() {
    return api.get<{ children: Array<{ id: number; name: string; avatar: string }> }>(
      '/auth/children'
    );
  }

  async function refreshMe() {
    const data = await api.get<{ user: AuthUser }>('/auth/me');
    if (data.user) {
      saveActiveUser(data.user);
    }
    return data.user;
  }

  // 家长更新自身资料（头像/昵称/身份/账号/密码），成功后同步本地 user
  async function updateMe(payload: {
    avatar?: string;
    nickname?: string;
    identity?: string;
    name?: string;
    password?: string;
  }) {
    const data = await api.patch<{ user: AuthUser }>('/auth/me', payload);
    if (data.user) {
      saveActiveUser(data.user);
    }
    return data.user;
  }

  /** 只退出指定角色（默认当前角色），另一个身份保持登录 */
  function logout(role: Role | null = activeRole.value) {
    if (!role) return;
    const keys = KEYS[role];
    localStorage.removeItem(keys.token);
    localStorage.removeItem(keys.user);
    if (role === 'parent') {
      parentToken.value = null;
      parentUser.value = null;
    } else {
      childToken.value = null;
      childUser.value = null;
    }
    if (activeRole.value === role) activeRole.value = null;
  }

  // 更新本地 user（用于小孩端设置后同步）
  function setUser(u: AuthUser) {
    saveActiveUser(u);
  }

  return {
    token,
    user,
    isAuthenticated,
    hasParent,
    hasChild,
    activeRole,
    activate,
    parentLogin,
    childLogin,
    fetchChildren,
    refreshMe,
    updateMe,
    setUser,
    logout,
  };
});
