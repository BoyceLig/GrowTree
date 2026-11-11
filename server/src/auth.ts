import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

const secret = new TextEncoder().encode(config.jwtSecret);

export interface JwtPayload {
  sub: number;          // user id
  role: 'parent' | 'child';
  name: string;
  /**
   * 「代看」标记：家长一键切到孩子视角时签发，值是那位家长的 userId。
   * 孩子自己登录拿到的 token 没有这个字段。
   *
   * 为什么必须放进 token 而不是别处：切视角后发出去的是**一个普通的 child token**，
   * 服务端从请求本身看不出它属于家长代看还是孩子本人。而运营后台要统计
   * 「孩子真实用了多久」——家长在自己手机上翻孩子界面也会产生请求和心跳，
   * 不区分的话那部分时长会被算成孩子的使用，数据就废了。
   */
  act?: number;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signToken(payload: JwtPayload): Promise<string> {
  const claims: Record<string, unknown> = { role: payload.role, name: payload.name };
  // 只有代看时才写：普通 token 与加了这行之前的完全一致（不改变既有 token 的形状）
  if (payload.act) claims.act = payload.act;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(config.jwtExpiresIn)
    .setSubject(String(payload.sub))
    .sign(secret);
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return {
      sub: Number(payload.sub),
      role: payload.role as 'parent' | 'child',
      name: payload.name as string,
      act: typeof payload.act === 'number' ? payload.act : undefined,
    };
  } catch {
    return null;
  }
}

// 校验PIN：4-6位数字
export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}
