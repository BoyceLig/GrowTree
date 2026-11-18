import { useAuthStore } from '@/stores/auth';
import { serverBaseOrigin } from '@/utils/server';

// 动态 base：配置了服务器地址时指向远端，否则走同源相对路径
function getBase(): string {
  const origin = serverBaseOrigin();
  return origin ? `${origin}/api` : '/api';
}

export async function request<T = any>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const auth = useAuthStore();
  // 只有真的带 body 才声明 Content-Type：DELETE/GET 这类无 body 请求若带
  // application/json，Fastify 会直接报 "Body cannot be empty when content-type is set to 'application/json'"
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body !== undefined && options.body !== null) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }
  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  const res = await fetch(`${getBase()}${path}`, {
    ...options,
    headers,
  });

  // 登录接口的 401 是账号/密码错误，不能把已有身份踢下线
  const isLoginCall = path === '/auth/parent-login' || path === '/auth/child-login';
  if (res.status === 401 && !isLoginCall) {
    auth.logout();
    throw new Error('未登录或登录已过期');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 开发环境把状态码和后端返回打到控制台，排查时 F12 就能看到
    if (import.meta.env.DEV) {
      console.error(`[api] ${options.method || 'GET'} ${path} → ${res.status}`, data);
    }
    const err = new Error((data as any).message || `请求失败 (${res.status})`) as Error & { status?: number; payload?: any };
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data as T;
}

/** multipart 文件上传（FormData 不能手工设 Content-Type，边界让浏览器自己带） */
export async function uploadFile(path: string, file: File): Promise<any> {
  const auth = useAuthStore();
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${getBase()}${path}`, { method: 'POST', headers, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as any).detail || (data as any).error || `上传失败 (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}
export const api = {
  get: <T = any>(p: string) => request<T>(p),
  post: <T = any>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T = any>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T = any>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: <T = any>(p: string) => request<T>(p, { method: 'DELETE' }),
};
