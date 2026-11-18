import { randomBytes } from 'node:crypto';

/**
 * 「Ask Question」面板的服务端部分：AI 在回合中间向家长提问时，
 * 这里开一张「待答问题」单子（token + 超时 + 归属人），
 * agent 循环 await 它，前端拿到 token 弹面板，家长提交后 resolve 继续跑。
 *
 * 设计要点：
 *   - 只存在内存里：问答是"当前回合"的一部分，进程重启/回合结束就该消失；
 *   - token 与 userId 绑定，别的家长拿 token 也答不了；
 *   - 有超时（默认 5 分钟），超时按「跳过」处理，避免回合永久挂住；
 *   - 返回值按「发出去的题目顺序」归一化，不信任前端回传的题面文字。
 */

export type AskOption = { label: string; description?: string };

export type AskQuestion = {
  /** 完整问题 */
  question: string;
  /** 可选，短标题（面板上的小标签） */
  header?: string;
  /** 可选，2~4 个候选项 */
  options?: AskOption[];
  /** 是否允许多选 */
  multi?: boolean;
};

export type AskAnswer = { question: string; answers: string[] };

/** 面板长期有效：用户可能暂时不在界面（切页面/断网/锁屏），10 分钟后再回来也能继续答 */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

/** 给前端的"当前待答问题"视图（用于刷新/重连后重新弹面板） */
export type PendingQuestionView = {
  token: string;
  sessionId: number;
  questions: AskQuestion[];
  createdAt: number;
  expiresAt: number;
};
const MAX_PENDING = 50;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

type Pending = {
  token: string;
  userId: number;
  sessionId: number;
  questions: AskQuestion[];
  resolve: (answers: AskAnswer[] | null) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
};

const pending = new Map<string, Pending>();

/** 模型给的结构不一定干净：裁剪题数/选项数/长度，丢掉空题 */
export function sanitizeQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const question = String(r.question ?? '').trim().slice(0, 200);
    if (!question) continue;
    const options: AskOption[] = [];
    if (Array.isArray(r.options)) {
      for (const opt of r.options.slice(0, MAX_OPTIONS)) {
        if (!opt || typeof opt !== 'object') continue;
        const label = String((opt as Record<string, unknown>).label ?? '').trim().slice(0, 60);
        if (!label) continue;
        const description = String((opt as Record<string, unknown>).description ?? '').trim().slice(0, 160);
        options.push({ label, ...(description ? { description } : {}) });
      }
    }
    out.push({
      question,
      ...(String(r.header ?? '').trim() ? { header: String(r.header).trim().slice(0, 20) } : {}),
      ...(options.length ? { options } : {}),
      ...(r.multi === true ? { multi: true } : {}),
    });
  }
  return out;
}

/** 按服务端保存的题面归一化答案：每题最多 5 条、每条最多 500 字 */
function normalizeAnswers(questions: AskQuestion[], raw: unknown): AskAnswer[] {
  const list = Array.isArray(raw) ? raw : [];
  return questions.map((q, i) => {
    const item = list[i] as unknown;
    const answersRaw = Array.isArray(item)
      ? item
      : item && typeof item === 'object'
        ? (item as Record<string, unknown>).answers
        : null;
    const answers = Array.isArray(answersRaw)
      ? answersRaw
          .map((a) => String(a ?? '').trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    return { question: q.question, answers };
  });
}

function dropOldestIfNeeded(): void {
  if (pending.size < MAX_PENDING) return;
  let oldest: Pending | null = null;
  for (const p of pending.values()) {
    if (!oldest || p.createdAt < oldest.createdAt) oldest = p;
  }
  if (oldest) {
    clearTimeout(oldest.timer);
    pending.delete(oldest.token);
    oldest.resolve(null);
  }
}

/**
 * 开一个问题单并返回 token + 等待中的 promise。
 * promise resolve null = 跳过/超时/被取消。
 */
export function openQuestion(input: {
  userId: number;
  sessionId: number;
  questions: unknown;
}):
  | { token: string; questions: AskQuestion[]; promise: Promise<AskAnswer[] | null> }
  | null {
  const questions = sanitizeQuestions(input.questions);
  if (!questions.length) return null;

  dropOldestIfNeeded();
  const token = randomBytes(12).toString('hex');
  const promise = new Promise<AskAnswer[] | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(token);
      resolve(null);
    }, QUESTION_TIMEOUT_MS);
    // 不要把定时器挂在事件循环上：回合结束后进程仍可退出
    timer.unref?.();
    pending.set(token, {
      token,
      userId: input.userId,
      sessionId: input.sessionId,
      questions,
      resolve,
      timer,
      createdAt: Date.now(),
    });
  });
  return { token, questions, promise };
}

/** 家长提交答案；answers 为空/非数组 = 主动跳过 */
export function answerQuestion(
  token: string,
  userId: number,
  answers: unknown
): { ok: true } | { ok: false; error: string } {
  const p = pending.get(token);
  if (!p) return { ok: false, error: '这个问题已经关闭（超时或已回答）' };
  if (p.userId !== userId) return { ok: false, error: '只有发起提问的家长可以回答' };
  clearTimeout(p.timer);
  pending.delete(token);
  p.resolve(Array.isArray(answers) ? normalizeAnswers(p.questions, answers) : null);
  return { ok: true };
}

/** 主动取消（回合异常结束时清理，避免定时器空转） */
export function cancelQuestion(token: string): boolean {
  const p = pending.get(token);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(token);
  p.resolve(null);
  return true;
}

/** 会话里是否还有没回答的问题（调试/测试用） */
export function hasPendingQuestion(sessionId: number): boolean {
  for (const p of pending.values()) if (p.sessionId === sessionId) return true;
  return false;
}

/** 当前用户所有待答问题（按发起时间从早到晚），供刷新/重连后补弹面板 */
export function listQuestions(userId: number): PendingQuestionView[] {
  const out: PendingQuestionView[] = [];
  for (const p of pending.values()) {
    if (p.userId !== userId) continue;
    out.push({
      token: p.token,
      sessionId: p.sessionId,
      questions: p.questions,
      createdAt: p.createdAt,
      expiresAt: p.createdAt + QUESTION_TIMEOUT_MS,
    });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out.slice(0, 10);
}

/** 会话被删除 / 回合异常结束时清掉它的问题单，避免定时器空转与"僵尸回合" */
export function cancelSessionQuestions(sessionId: number): number {
  let count = 0;
  for (const p of [...pending.values()]) {
    if (p.sessionId !== sessionId) continue;
    clearTimeout(p.timer);
    pending.delete(p.token);
    p.resolve(null);
    count++;
  }
  return count;
}