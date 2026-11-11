import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useAuthStore } from './auth';
import { useToastStore } from './toast';
import { serverBaseOrigin } from '@/utils/server';

// 这里**故意不再维护**一份"待审核数量"。
// R3 之前本文件有一个模块级 pendingCount（由 refreshPendingCount 初始化、
// new_exchange_request 自增、decPending 自减），但它只数兑换、而且全项目没有任何地方渲染它 ——
// 真正驱动徽标的一直是 parent/Layout.vue 从 /dashboard 的 pendingReview.total 拉的那份。
// 两份计数并存意味着迟早会显示不一致（一个数兑换一个数全部），所以 R3 把它删掉了，
// 只保留"喊一声去重拉"的事件通道（见下面 handleMessage 里的 window.dispatchEvent）。

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let manualClose = false;

export function useWsStore() {
  const connected = ref(false);

  function connect() {
    const auth = useAuthStore();
    if (!auth.user) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    // 配置了服务器地址时按配置走（App 内网），否则使用当前页面同源（Web 部署）
    const origin = serverBaseOrigin();
    const proto = origin?.startsWith('https') ? 'wss' : 'ws';
    const host = origin ? new URL(origin).host : location.host;
    const url = `${proto}://${host}/ws?userId=${auth.user.id}&role=${auth.user.role}`;
    manualClose = false;
    ws = new WebSocket(url);

    ws.onopen = () => {
      connected.value = true;
      startHeartbeat();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      connected.value = false;
      stopHeartbeat();
      if (!manualClose) scheduleReconnect();
    };

    ws.onerror = () => {
      connected.value = false;
    };
  }

  function disconnect() {
    manualClose = true;
    stopHeartbeat();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
    connected.value = false;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function handleMessage(msg: any) {
    const toast = useToastStore();
    const auth = useAuthStore();

    if (msg.type === 'pong') return;

    // 家长端：新兑换申请
    if (msg.type === 'new_exchange_request' && auth.user?.role === 'parent') {
      const itemText = msg.exchangeType === 'cash'
        ? `现金 ${msg.amount}元`
        : `商品「${msg.productName}」`;
      toast.info(`🔔 ${msg.userName} 申请兑换${itemText}（-${msg.points}分）`);
      window.dispatchEvent(new CustomEvent('ws:new_exchange_request', { detail: msg }));
    }

    // 小孩端：审核结果
    if (msg.type === 'exchange_reviewed' && auth.user?.role === 'child') {
      const itemText = msg.exchangeType === 'cash'
        ? `${msg.amount}元现金`
        : `「${msg.productName}」`;
      if (msg.status === 'approved') {
        toast.success(`✅ 你的${itemText}兑换已通过！剩余 ${msg.newBalance} 分`);
      } else {
        toast.warning(`❌ 你的${itemText}兑换被拒绝${msg.reason ? '：' + msg.reason : ''}`);
      }
      window.dispatchEvent(new CustomEvent('ws:exchange_reviewed', { detail: msg }));
    }

    // 家长端：小孩接受全员任务
    if (msg.type === 'task_accepted' && auth.user?.role === 'parent') {
      toast.info(`🤝 ${msg.userName} 接受了任务`);
      window.dispatchEvent(new CustomEvent('ws:task_accepted', { detail: msg }));
    }

    // 家长端：小孩提交任务完成申请
    if (msg.type === 'task_completion_submitted' && auth.user?.role === 'parent') {
      toast.info(`📤 ${msg.userName} 提交了「${msg.taskName}」完成申请，待审核`);
      window.dispatchEvent(new CustomEvent('ws:task_completion_submitted', { detail: msg }));
    }

    // 小孩端：家长录入了新的身高体重
    if (msg.type === 'growth_recorded' && auth.user?.role === 'child') {
      const grow = Number(msg.growCm ?? 0);
      if (grow > 0) {
        const bonus = msg.awarded > 0 ? `　+${msg.awarded} 分 🎉` : '';
        toast.success(`📏 你长高啦 +${grow.toFixed(1)}cm！${bonus}`);
      } else {
        toast.info('📏 爸爸妈妈更新了你的成长记录');
      }
      window.dispatchEvent(new CustomEvent('ws:growth_recorded', { detail: msg }));
    }

    // 小孩端：任务审核结果
    if (msg.type === 'task_review' && auth.user?.role === 'child') {
      if (msg.status === 'approved') {
        toast.success(`✅ 任务审核通过！+${msg.points} 分`);
      } else {
        toast.warning(`❌ 任务被拒绝${msg.reason ? '：' + msg.reason : ''}，可重新提交`);
      }
      window.dispatchEvent(new CustomEvent('ws:task_review', { detail: msg }));
    }

    // 家长端：小孩领取/提交周期任务
    if (msg.type === 'recurring_claim_submitted' && auth.user?.role === 'parent') {
      toast.info(`📤 ${msg.userName} 领取/提交了周期任务「${msg.taskName}」`);
      window.dispatchEvent(new CustomEvent('ws:recurring_claim_submitted', { detail: msg }));
    }

    // 小孩端：周期任务审核结果
    if (msg.type === 'recurring_review' && auth.user?.role === 'child') {
      if (msg.status === 'approved') {
        toast.success(`✅ 周期任务审核通过！+${msg.points} 分`);
      } else {
        toast.warning(`❌ 周期任务被拒绝${msg.reason ? '：' + msg.reason : ''}，可重新提交`);
      }
      window.dispatchEvent(new CustomEvent('ws:recurring_review', { detail: msg }));
    }

    // 家长端：另一台设备/另一个家长完成了审核 → 任务页三个标签静默重拉
    if (msg.type === 'recurring_review' && auth.user?.role === 'parent') {
      window.dispatchEvent(new CustomEvent('ws:recurring_tasks_changed', { detail: msg }));
    }

    // ── 下面是「数据变了，自己去重拉」的静默同步事件：两端都派发，页面各自监听 ──

    // 周期任务本身被新建/编辑/启停/删除（家长端操作）→ 孩子端「可领取」标签要立刻出现/消失
    if (msg.type === 'recurring_tasks_changed') {
      window.dispatchEvent(new CustomEvent('ws:recurring_tasks_changed', { detail: msg }));
    }

    // 周期任务的领取/完成记录被删除 → 家长端与孩子端的「已领取/已完成」标签都要重拉
    if (msg.type === 'recurring_claims_cleared') {
      window.dispatchEvent(new CustomEvent('ws:recurring_claims_cleared', { detail: msg }));
    }

    // 商品/规格/库存/汇率变化 → 两端商城页重拉
    if (msg.type === 'products_changed') {
      window.dispatchEvent(new CustomEvent('ws:products_changed', { detail: msg }));
    }

    // 积分项目被新建/编辑/删除（另一个家长的操作）→ 积分页重拉。
    // 少了这一条，两个人同时开着积分页时，后动手的那个会对着已经不存在的项目
    // 点删除，拿到「项目不存在」——提示没错，但本来不该让他点到。
    if (msg.type === 'point_items_changed') {
      window.dispatchEvent(new CustomEvent('ws:point_items_changed', { detail: msg }));
    }

    // 有人加分/扣分（一键加分、临时加减分）→ 两端首页的积分卡、排行榜、明细都要重拉
    if (msg.type === 'points_changed') {
      if (auth.user?.role === 'child' && msg.userId === auth.user.id) {
        const d = Number(msg.delta ?? 0);
        const name = msg.note ? `「${msg.note}」` : '';
        if (d > 0) toast.success(`🌟 ${name}${d > 0 ? '+' : ''}${d} 分！现在 ${msg.newBalance} 分`);
        else if (d < 0) toast.warning(`💧 ${name}${d} 分，现在 ${msg.newBalance} 分`);
      }
      window.dispatchEvent(new CustomEvent('ws:points_changed', { detail: msg }));
    }

    // 成长日记被写/改/删 → 两端成长页重拉时间轴（孩子端再补一句提示）
    if (msg.type === 'diary_changed') {
      // visible === false：家长关掉了这个孩子的日记可见，此时不该提示「有新日记」——
      // 提示了等于告诉孩子「有你看不到的东西」，开关就没意义了
      if (auth.user?.role === 'child' && msg.action === 'created' && msg.visible !== false) {
        toast.success('📖 爸爸妈妈写了一篇新的成长日记');
      }
      window.dispatchEvent(new CustomEvent('ws:diary_changed', { detail: msg }));
    }

    // 家长切换了「成长日记对这个孩子可见」→ 孩子端立刻整块显示/隐藏日记区
    if (msg.type === 'diary_visibility_changed') {
      if (auth.user?.role === 'child') {
        if (msg.visible) toast.success('📖 爸爸妈妈开放了成长日记，去看看吧');
        else toast.info('📖 成长日记暂时收起来了');
      }
      window.dispatchEvent(new CustomEvent('ws:diary_visibility_changed', { detail: msg }));
    }

    // 树洞信箱有新留言 → 首页卡片实时更新
    //
    // 两端都要按"这条消息跟当前登录的人相不相关"过一遍：
    // 家长收到的是全家所有孩子的留言推送，孩子只该看到自己那条。
    // 同时跳过自己发的那条 —— 服务端会把消息回推给发送方（含其它设备），
    // 不判 senderId 的话，自己发完立刻会收到一条"你有新留言"的假提示。
    if (msg.type === 'mailbox_message') {
      const mine = msg.senderId === auth.user?.id;
      const relevant = auth.user?.role === 'child' ? msg.childId === auth.user.id : true;
      if (relevant && !mine) {
        if (auth.user?.role === 'child') toast.info('💌 爸爸妈妈往树洞里放了一句话');
        else toast.info('💌 收到一条新的树洞留言');
      }
      if (relevant) window.dispatchEvent(new CustomEvent('ws:mailbox_message', { detail: msg }));
    }
  }

  return {
    connected,
    connect,
    disconnect,
  };
}
