/**
 * 正在进行的 AI 回合状态（内存）。
 *
 * 用途：用户切走再回到 AI 页面时，前端能立刻恢复「这个会话还在跑」的状态
 * （思考中 / 正在回答 / 正在执行某工具），而不是看起来什么都没发生、再发消息又报 409。
 *
 * 只存"当前这一回合"，回合结束/异常都会被清掉；进程重启即清空（那次回合也随之中断）。
 */

export type TurnPhase = 'thinking' | 'writing' | 'tool';

export type PlanStep = { title: string; status: 'pending' | 'in_progress' | 'done' };

export type TurnState = {
  sessionId: number;
  userId: number;
  taskId: string;
  phase: TurnPhase;
  /** phase='tool' 时的工具名 */
  tool?: string;
  /** 回合开始时间（毫秒），前端用它恢复计时 */
  startedAt: number;
  /** 本回合已执行过的工具（按顺序，最多 8 个）：切走再回来时能继续看到「步骤」 */
  steps: string[];
  /** 模型自己列的步骤计划（update_plan 工具维护），用于展示整体进度 */
  plan: PlanStep[];
};

const turns = new Map<number, TurnState>();

export function startTurn(sessionId: number, userId: number, taskId: string): void {
  turns.set(sessionId, { sessionId, userId, taskId, phase: 'thinking', startedAt: Date.now(), steps: [], plan: [] });
}

export function setPlan(sessionId: number, taskId: string, plan: PlanStep[]): void {
  const turn = turns.get(sessionId);
  if (!turn || turn.taskId !== taskId) return;
  turn.plan = plan;
}

export function updateTurn(sessionId: number, taskId: string, phase: TurnPhase, tool?: string): void {
  const turn = turns.get(sessionId);
  if (!turn || turn.taskId !== taskId) return;
  turn.phase = phase;
  turn.tool = tool;
  if (phase === 'tool' && tool && turn.steps[turn.steps.length - 1] !== tool) {
    turn.steps.push(tool);
    if (turn.steps.length > 8) turn.steps.splice(0, turn.steps.length - 8);
  }
}

export function endTurn(sessionId: number, taskId: string): void {
  const turn = turns.get(sessionId);
  if (turn && turn.taskId === taskId) turns.delete(sessionId);
}

export type TurnStateView = Omit<TurnState, 'userId'>;

export function listTurns(userId: number): TurnStateView[] {
  const out: TurnStateView[] = [];
  for (const turn of turns.values()) {
    if (turn.userId !== userId) continue;
    out.push({
      sessionId: turn.sessionId,
      taskId: turn.taskId,
      phase: turn.phase,
      tool: turn.tool,
      startedAt: turn.startedAt,
      steps: [...turn.steps],
      plan: turn.plan.map((p) => ({ ...p })),
    });
  }
  return out;
}