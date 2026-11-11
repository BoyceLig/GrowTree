<script setup lang="ts">
import { computed, ref } from 'vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import { fmtGrowthDate } from '@/utils/growth';
import {
  groupByMonth,
  mediaSummary,
  relativeDay,
  weekdayOf,
  type Diary,
  type DiaryMedia,
} from '@/utils/diary';

/**
 * 成长日记时间轴。
 *
 * 家长端（canEdit）与孩子端（只读）共用同一个组件：时间轴的排版规则、
 * 图片视频的展示方式、空状态文案一旦分头写，两边迟早长得不一样。
 * 唯一的差别就是「有没有编辑/删除按钮」，所以只留一个 canEdit 开关。
 */
const props = withDefaults(
  defineProps<{
    items: Diary[];
    /** 家长端 = true，孩子端只读 = false */
    canEdit?: boolean;
    loading?: boolean;
    /** 是否处于筛选状态（决定空状态说「还没有日记」还是「没找到符合条件的日记」） */
    filtered?: boolean;
    /** 多孩子合并展示时（家长没选具体孩子）在卡片上标出是谁的日记 */
    showChild?: boolean;
    today: string;
    emptyText?: string;
    emptyHint?: string;
  }>(),
  {
    canEdit: false,
    loading: false,
    filtered: false,
    showChild: false,
    emptyText: '还没有成长日记',
    emptyHint: '把今天发生的小事记下来吧~',
  }
);

const emit = defineEmits<{
  edit: [d: Diary];
  remove: [d: Diary];
}>();

const groups = computed(() => groupByMonth(props.items));

/** 点开的附件（图片走灯箱，视频直接在内联播放器里看） */
const preview = ref<DiaryMedia | null>(null);
</script>

<template>
  <div class="tl-wrap">
    <EmptyState
      v-if="!loading && items.length === 0"
      emoji="📖"
      :text="filtered ? '没找到符合条件的日记' : emptyText"
      :hint="filtered ? '换个时间范围或者关键词试试' : emptyHint"
    />

    <div v-else class="timeline">
      <section v-for="g in groups" :key="g.month" class="tl-month">
        <div class="month-bar">
          <span class="month-label">{{ g.label }}</span>
          <span class="month-count">{{ g.items.length }} 篇</span>
        </div>

        <div v-for="d in g.items" :key="d.id" class="tl-item">
          <!-- 左侧轨道：圆点 + 日期。日期放在轨道上而不是卡片里，
               这样纵向扫一眼就是一条时间线，而不是一叠卡片 -->
          <div class="rail" aria-hidden="true">
            <span class="dot"></span>
          </div>

          <div class="tl-side">
            <div class="side-date">{{ fmtGrowthDate(d.diary_date) }}</div>
            <div class="side-sub">
              {{ relativeDay(d.diary_date, today) || weekdayOf(d.diary_date) }}
            </div>
          </div>

          <article class="diary-card">
            <header class="dc-head">
              <h3 v-if="d.title" class="dc-title">{{ d.title }}</h3>
              <div class="dc-meta">
                <template v-if="showChild && d.child_name">
                  <ZodiacAvatar :zodiac="d.child_avatar || 'rat'" :size="18" />
                  <span class="dc-child">{{ d.child_name }}</span>
                </template>
                <span v-if="d.creator_name" class="dc-by">{{ d.creator_name }} 记录</span>
                <span v-if="d.updated_at" class="dc-edited">已编辑</span>
              </div>
            </header>

            <p v-if="d.content" class="dc-content">{{ d.content }}</p>

            <div v-if="d.media.length" class="dc-media" :class="{ many: d.media.length > 3 }">
              <template v-for="(m, i) in d.media" :key="i">
                <button
                  v-if="m.type === 'image'"
                  class="media-cell"
                  type="button"
                  :aria-label="`放大第 ${i + 1} 张照片`"
                  @click="preview = m"
                >
                  <img :src="m.url" alt="" loading="lazy" />
                </button>
                <div v-else class="media-cell video">
                  <video :src="m.url" controls playsinline preload="metadata"></video>
                </div>
              </template>
            </div>

            <footer v-if="canEdit" class="dc-foot">
              <span class="dc-count">{{ mediaSummary(d.media) }}</span>
              <span class="spacer"></span>
              <button class="mini-btn" type="button" @click="emit('edit', d)">✏️ 编辑</button>
              <button class="mini-btn danger" type="button" @click="emit('remove', d)">🗑️ 删除</button>
            </footer>
          </article>
        </div>
      </section>
    </div>

    <!-- 图片灯箱：点空白处关闭（不看 video，视频自带控件就地播放） -->
    <Teleport to="body">
      <Transition name="lb-fade">
        <div v-if="preview" class="lb-overlay" @click="preview = null">
          <img class="lb-img" :src="preview.url" alt="" @click.stop />
          <p class="lb-hint">点击空白处关闭</p>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--space-18);
}

.month-bar {
  display: flex;
  align-items: baseline;
  gap: var(--space-8);
  margin: 0 0 var(--space-10) 34px;
}
.month-label {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  color: var(--text-primary);
  padding: var(--space-2) var(--space-10);
  border-radius: var(--r-pill);
  background: rgba(255, 209, 102, 0.28);
}
.month-count { font-size: var(--fs-xs); color: var(--text-muted); }

.tl-item {
  display: grid;
  /* 轨道 20px + 日期 62px + 卡片自适应：三段写死，卡片才能一列整齐 */
  grid-template-columns: 20px 62px minmax(0, 1fr);
  gap: var(--space-8);
  position: relative;
  padding-bottom: var(--space-12);
}
/* 竖线画在轨道格子里，最后一条不再往下连（否则时间轴会多出一截尾巴） */
.tl-item::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 14px;
  bottom: 0;
  width: 2px;
  background: rgba(255, 209, 102, 0.4);
}
.tl-item:last-child::before { display: none; }

.rail { display: flex; justify-content: center; padding-top: 12px; }
.dot {
  width: 12px;
  height: 12px;
  border-radius: var(--r-full);
  background: var(--accent-orange);
  box-shadow: 0 0 0 3px rgba(255, 180, 84, 0.22);
  flex-shrink: 0;
}

.tl-side { padding-top: 8px; text-align: right; }
.side-date {
  font-family: var(--font-cute);
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
}
.side-sub { font-size: var(--fs-xs); color: var(--text-muted); }

.diary-card {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  padding: var(--space-12) var(--space-14);
  min-width: 0;
}

.dc-head { display: flex; flex-direction: column; gap: var(--space-4); }
.dc-title {
  font-family: var(--font-cute);
  font-size: var(--fs-md);
  line-height: 1.35;
}
.dc-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-6);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.dc-child { color: var(--text-on-orange); }
.dc-by { color: var(--text-muted); }
.dc-edited {
  padding: 0 var(--space-6);
  border-radius: var(--r-xs);
  background: var(--glass-bg-strong);
}

/* 正文保留换行：家长分段写的日记不能挤成一坨 */
.dc-content {
  margin-top: var(--space-8);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

.dc-media {
  margin-top: var(--space-10);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: var(--space-6);
}
/* 视频横跨两列，16:9 的片子在小格子里看不清 */
.dc-media .media-cell.video {
  grid-column: span 2;
  aspect-ratio: 16 / 9;
}
.media-cell {
  display: block;
  position: relative;
  padding: 0;
  border-radius: var(--r-md);
  overflow: hidden;
  aspect-ratio: 1;
  background: rgba(90, 58, 74, 0.06);
  cursor: pointer;
}
.media-cell img,
.media-cell video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.media-cell.video { cursor: default; }

.dc-foot {
  margin-top: var(--space-10);
  padding-top: var(--space-8);
  border-top: 1px dashed var(--glass-border);
  display: flex;
  align-items: center;
  gap: var(--space-8);
}
.dc-count { font-size: var(--fs-xs); color: var(--text-muted); }
.spacer { flex: 1; }
.mini-btn {
  padding: var(--space-4) var(--space-10);
  border-radius: var(--r-pill);
  background: var(--glass-bg-strong);
  font-size: var(--fs-xs);
  transition: background var(--dur-fast);
}
.mini-btn:hover { background: rgba(255, 209, 102, 0.3); }
.mini-btn.danger:hover { background: rgba(255, 107, 107, 0.2); }

/* 灯箱 */
.lb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 16, 12, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-12);
  z-index: 1600;
  padding: var(--space-24);
}
.lb-img {
  max-width: 100%;
  max-height: 80vh;
  border-radius: var(--r-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}
.lb-hint { color: rgba(255, 255, 255, 0.65); font-size: var(--fs-xs); }
.lb-fade-enter-active,
.lb-fade-leave-active { transition: opacity var(--dur-base); }
.lb-fade-enter-from,
.lb-fade-leave-to { opacity: 0; }

/* 窄屏：日期列收窄，别把卡片挤成一条 */
@media (max-width: 560px) {
  .tl-item { grid-template-columns: 16px 50px minmax(0, 1fr); gap: var(--space-6); }
  .tl-item::before { left: 7px; }
  .month-bar { margin-left: 22px; }
  .side-date { font-size: var(--fs-xs); }
}
</style>
