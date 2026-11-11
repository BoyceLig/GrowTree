<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import GlassCard from '@/components/GlassCard.vue';
import EmptyState from '@/components/EmptyState.vue';
import GrowthChart from '@/components/GrowthChart.vue';
import DiaryTimeline from '@/components/DiaryTimeline.vue';
import { todayStr } from '@/utils/growth';
import type { Diary } from '@/utils/diary';
import {
  ageInYears,
  heightPercentile,
  heightPercentileText,
  heightLevelTextChild,
  calcBmi,
  bmiLevel,
  bmiPercentile,
  bmiLevelTextChild,
  type Sex,
} from '@/utils/growth-standards';

const router = useRouter();

interface Profile {
  id: number;
  name: string;
  birthday: string | null;
  sex: string | null;
  /** 成长日记对当前孩子是否可见：1=可见，0=家长收起来了（后端也不下发内容） */
  diary_visible?: number | null;
}
interface GrowthRecord {
  id: number;
  record_date: string;
  height_cm: number | null;
  weight_kg: number | null;
  note: string | null;
  created_at: number;
}

const profile = ref<Profile | null>(null);
const records = ref<GrowthRecord[]>([]);
const loading = ref(true);

// 成长日记（只读）：家长写、孩子看。
// 家长可以按孩子关掉可见性（「家长端 → 成长记录 → 成长日记 → 眼睛开关」）：
// 关掉时整块不渲染 —— 后端此时也不下发任何内容，前端只是不做无谓的请求。
const diaries = ref<Diary[]>([]);
const diaryLoading = ref(false);
const today = todayStr();

/** 默认可见：老接口没有这个字段时不能把日记藏了（会显得功能凭空消失） */
const showDiary = computed(() => profile.value?.diary_visible !== 0);

async function loadDiaries() {
  if (!showDiary.value) {
    diaries.value = [];
    return;
  }
  diaryLoading.value = true;
  try {
    const res = await api.get<{ diaries: Diary[]; visible?: boolean }>('/growth/diaries?limit=200');
    // 服务端也可能因为开关刚被关掉而回空列表：以它的 visible 为准，两边不打架
    if (res.visible === false && profile.value) profile.value.diary_visible = 0;
    diaries.value = res.diaries;
  } catch {
    // 失败保持旧数据：日记读不到不该让整页变成错误页
  } finally {
    diaryLoading.value = false;
  }
}

const heightSeries = computed(() => records.value.filter((r) => r.height_cm != null));
const latestHeight = computed(() =>
  heightSeries.value.length ? heightSeries.value[heightSeries.value.length - 1] : null
);
const prevHeight = computed(() =>
  heightSeries.value.length > 1 ? heightSeries.value[heightSeries.value.length - 2] : null
);
const growSincePrev = computed(() => {
  if (!latestHeight.value || !prevHeight.value) return null;
  return latestHeight.value.height_cm! - prevHeight.value.height_cm!;
});

const latestWeight = computed(() => {
  for (let i = records.value.length - 1; i >= 0; i--) {
    if (records.value[i].weight_kg != null) return records.value[i];
  }
  return null;
});

const currentBmi = computed(() => {
  const w = latestWeight.value?.weight_kg;
  const h = latestHeight.value?.height_cm;
  if (w == null || h == null) return null;
  return calcBmi(h, w);
});

/** 身高百分位（需生日 + 性别） */
const heightEval = computed(() => {
  const p = profile.value;
  const r = latestHeight.value;
  if (!p?.birthday || !p.sex || !r?.height_cm) return null;
  const age = ageInYears(p.birthday, r.record_date);
  if (age == null) return null;
  const pc = heightPercentile(p.sex as Sex, age, r.height_cm);
  if (pc == null) return null;
  return {
    percentile: pc,
    text: heightPercentileText(pc),
    level: heightLevelTextChild(pc),
  };
});

const bmiEval = computed(() => {
  const p = profile.value;
  const bmi = currentBmi.value;
  if (!p?.birthday || !p.sex || bmi == null) return null;
  const r = latestWeight.value ?? latestHeight.value;
  if (!r) return null;
  const age = ageInYears(p.birthday, r.record_date);
  if (age == null) return null;
  // 6 岁以上用 WS/T 586 分级；更小的孩子用 WS/T 423 的 BMI 百分位
  const level = bmiLevel(p.sex as Sex, age, bmi);
  if (level) return { text: bmiLevelTextChild(level) };
  const pc = bmiPercentile(p.sex as Sex, age, bmi);
  return pc === null ? null : { text: heightPercentileText(pc) };
});

/** 长大一点点的小鼓励 */
const cheer = computed(() => {
  if (growSincePrev.value === null) return '记录下第一次身高吧~';
  if (growSincePrev.value > 0) return `最近长高了 ${growSincePrev.value.toFixed(1)}cm，厉害！`;
  if (growSincePrev.value === 0) return '这次身高没变，下次再量量看~';
  return '数据有更新，继续加油长高高！';
});

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ profile: Profile; records: GrowthRecord[] }>('/growth/mine');
    profile.value = res.profile;
    records.value = res.records;
  } catch {
    // 失败时保持旧数据，不让页面白屏
  } finally {
    loading.value = false;
  }
}

/** 图表用的实测点：{ 日期, 数值 } */
const heightPoints = computed(() =>
  heightSeries.value.map((r) => ({ date: r.record_date, value: r.height_cm as number }))
);

function openDetail() {
  // 卡片和图表都会触发，加个守卫避免重复跳转
  if (router.currentRoute.value.path === '/child/growth/detail') return;
  router.push('/child/growth/detail');
}

function fmtDate(s: string): string {
  const [, m, d] = s.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

// 家长录入新记录后自动刷新
function onGrowthRecorded() {
  load();
}

// 家长写了/改了日记后自动刷新
function onDiaryChanged() {
  loadDiaries();
}

// 家长按下了「这个孩子能不能看成长日记」的开关：立刻跟着变，
// 不用等孩子自己刷新页面（家长多半是在另一个房间操作的）
function onDiaryVisibility(e: Event) {
  const detail = (e as CustomEvent).detail as { visible?: boolean } | undefined;
  if (profile.value) profile.value.diary_visible = detail?.visible ? 1 : 0;
  if (showDiary.value) loadDiaries();
  else { diaries.value = []; diaryLoading.value = false; }
}

onMounted(() => {
  load();
  loadDiaries();
  window.addEventListener('ws:growth_recorded', onGrowthRecorded);
  window.addEventListener('ws:diary_changed', onDiaryChanged);
  window.addEventListener('ws:diary_visibility_changed', onDiaryVisibility);
});

onUnmounted(() => {
  window.removeEventListener('ws:growth_recorded', onGrowthRecorded);
  window.removeEventListener('ws:diary_changed', onDiaryChanged);
  window.removeEventListener('ws:diary_visibility_changed', onDiaryVisibility);
});
</script>

<template>
  <div class="page">
    <h1 class="title">我的成长 📏</h1>

    <EmptyState
      v-if="!loading && records.length === 0"
      emoji="📏"
      text="还没有测量记录"
      hint="让爸爸妈妈帮你量一量身高吧~"
    />

    <template v-else>
      <!-- 身高主卡 -->
      <GlassCard v-if="latestHeight" class="hero" padding="24px 20px">
        <div class="hero-emoji">🌱</div>
        <div class="hero-num">
          {{ latestHeight.height_cm!.toFixed(1) }}
          <span class="unit">cm</span>
        </div>
        <div class="hero-label">我现在的身高</div>
        <div v-if="growSincePrev !== null && growSincePrev > 0" class="grow-tag">
          🎉 比上次 +{{ growSincePrev.toFixed(1) }}cm
        </div>
        <div v-else-if="growSincePrev !== null" class="grow-tag flat">
          和上次一样高
        </div>
      </GlassCard>

      <p class="cheer">{{ cheer }}</p>

      <!-- 百分位 / 体重 / BMI -->
      <div class="stat-row">
        <GlassCard padding="14px 12px" class="stat-card">
          <div class="stat-emoji">📊</div>
          <div class="stat-value">{{ heightEval ? heightEval.text : '--' }}</div>
          <div class="stat-label">{{ heightEval ? heightEval.level : '需填生日性别' }}</div>
        </GlassCard>

        <GlassCard padding="14px 12px" class="stat-card">
          <div class="stat-emoji">⚖️</div>
          <div class="stat-value">
            {{ latestWeight ? latestWeight.weight_kg!.toFixed(1) : '--' }}
            <span class="unit-sm">kg</span>
          </div>
          <div class="stat-label">我的体重</div>
        </GlassCard>

        <GlassCard padding="14px 12px" class="stat-card">
          <div class="stat-emoji">💪</div>
          <div class="stat-value">{{ bmiEval ? bmiEval.text : '--' }}</div>
          <div class="stat-label">
            {{ currentBmi !== null ? `BMI ${currentBmi.toFixed(1)}` : '暂无 BMI' }}
          </div>
        </GlassCard>
      </div>

      <!-- 身高曲线：点一下进详情页看和同龄人的对比 -->
      <GlassCard
        padding="16px 14px 10px"
        class="chart-card"
        hover
        clickable
        label="查看身高曲线与同龄人对比"
        @click="openDetail"
      >
        <div class="chart-head">
          <span class="chart-title">📈 我的身高曲线</span>
          <span class="chart-more">点开看对比 ›</span>
        </div>
        <!-- interactive=false：外层卡片已经是 role="button"，
             图表不能再自报一次按钮语义（SVG 里还有一堆轴刻度文字，
             否则会被算进可访问名）-->
        <GrowthChart
          metric="height"
          :points="heightPoints"
          :sex="(profile?.sex as Sex | null) ?? null"
          :birthday="profile?.birthday ?? null"
          mode="compact"
          :chart-height="180"
          :interactive="false"
          @open-detail="openDetail"
        />
      </GlassCard>

      <!-- 最近记录 -->
      <h2 class="section-title">量过的身高</h2>
      <div class="record-list">
        <GlassCard
          v-for="r in [...records].reverse().slice(0, 8)"
          :key="r.id"
          padding="11px 14px"
          class="record-item"
        >
          <span class="r-date">{{ fmtDate(r.record_date) }}</span>
          <span v-if="r.height_cm != null" class="r-val">📏 {{ r.height_cm.toFixed(1) }} cm</span>
          <span v-if="r.weight_kg != null" class="r-val">⚖️ {{ r.weight_kg.toFixed(1) }} kg</span>
        </GlassCard>
      </div>

      <p v-if="!heightEval" class="foot-note">
        💡 想看「在同龄人里排第几」？让爸爸妈妈在账号里填上生日和性别就好啦
      </p>
    </template>

    <!-- 成长日记（只读）：和上面的测量记录彼此独立 —— 没量过身高也可以有日记，
         所以不复用上面那个空态判断，自己带一份空状态。
         家长可以把「成长日记可见」按孩子关掉，关掉时整块连标题一起不出现。 -->
    <template v-if="showDiary">
      <h2 class="section-title diary-title">📖 爸爸妈妈写的成长日记</h2>
      <DiaryTimeline
        :items="diaries"
        :today="today"
        :loading="diaryLoading"
        empty-text="还没有成长日记"
        empty-hint="让爸爸妈妈记下今天发生的事吧~"
      />
    </template>
  </div>
</template>

<style scoped>
.page { padding-bottom: var(--space-8); }
.title {
  font-size: var(--fs-3xl);
  text-align: center;
  margin-bottom: var(--space-16);
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-10);
  text-align: center;
}
.hero-emoji { font-size: var(--fs-5xl); }
.hero-num {
  font-family: var(--font-cute);
  font-size: var(--fs-7xl);
  line-height: 1.1;
  /* 兜底：不支持 background-clip:text 时退化为深色实字，避免身高数字消失 */
  color: var(--text-on-mint);
}
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .hero-num {
    /* 同 Home 的余额数字：端点改用压暗版（4.23:1 → 4.62:1），
       原因见 main.css 的 --grad-num-* 注释 */
    background: linear-gradient(135deg, var(--grad-num-cool-from), var(--grad-num-cool-to));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
}
.hero-num .unit { font-size: var(--fs-xl); }
.hero-label { font-size: var(--fs-sm); color: var(--text-muted); }
.grow-tag {
  margin-top: var(--space-8);
  padding: var(--space-6) var(--space-14);
  border-radius: var(--r-pill);
  background: rgba(255, 209, 102, 0.22);
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
}
.grow-tag.flat { background: var(--glass-bg); color: var(--text-muted); }

.cheer {
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-14);
}

.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-10);
  margin-bottom: var(--space-14);
}
.stat-card {
  text-align: center;
  border: 1px solid var(--glass-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.stat-emoji { font-size: var(--fs-xl); }
.stat-value {
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
  line-height: 1.3;
}
.unit-sm { font-size: var(--fs-xs); color: var(--text-muted); }
.stat-label { font-size: var(--fs-xs); color: var(--text-muted); }

.chart-card { margin-bottom: var(--space-18); }
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-6);
  padding: 0 var(--space-2);
}
.chart-title { font-family: var(--font-cute); font-size: var(--fs-md); }
.chart-more { font-size: var(--fs-xs); color: var(--text-muted); }

.section-title { font-size: var(--fs-lg); margin-bottom: var(--space-10); }
/* 日记标题要和上面「量过的身高」拉开距离：两段内容视觉上不能连成一片 */
.diary-title { margin-top: var(--space-20); }

.record-list { display: flex; flex-direction: column; gap: var(--space-8); }
.record-item {
  display: flex;
  align-items: center;
  gap: var(--space-14);
  border: 1px solid var(--glass-border);
}
.r-date {
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
  width: 58px;
  flex-shrink: 0;
}
.r-val { font-size: var(--fs-sm); color: var(--text-secondary); }

.foot-note {
  margin-top: var(--space-16);
  font-size: var(--fs-xs);
  color: var(--text-muted);
  text-align: center;
  line-height: 1.6;
}
</style>
