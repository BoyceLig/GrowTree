<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ZodiacAvatar from '@/components/ZodiacAvatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import VideoPlayerModal from '@/components/VideoPlayerModal.vue';
import { downloadMedia } from '@/utils/mediaDownload';
import { fmtGrowthDate } from '@/utils/growth';
import { layoutAllRows, bindPendingImageLoads } from '@/utils/diaryImageLayout';
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

// 富文本里的视频卡片：点击播放键 → 独立播放浮层
const videoPlayerOpen = ref(false);
const videoPlayerSrc = ref('');
const videoPlayerPoster = ref('');
/** 视频原始文件名：下载时用它，而不是磁盘上的随机 ID */
const videoPlayerName = ref('');

function onContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;

  // 富文本里的图片：点开灯箱（顺带提供「下载原图」，文件名是上传时的原名）
  const img = target?.closest('img.diary-inline-image') as HTMLImageElement | null;
  if (img && !img.classList.contains('ProseMirror-separator')) {
    const url = img.getAttribute('src') || '';
    if (url) {
      preview.value = { type: 'image', url, name: img.getAttribute('data-name') };
      return;
    }
  }

  const play = target?.closest('.dv-play') as HTMLElement | null;
  if (!play) return;
  const card = play.closest('.diary-video') as HTMLElement | null;
  const src = card?.dataset.src || '';
  if (!src) return;
  e.preventDefault();
  videoPlayerSrc.value = src;
  videoPlayerPoster.value = card?.dataset.poster || '';
  videoPlayerName.value = card?.dataset.name || '';
  videoPlayerOpen.value = true;
}

function hasHtml(s: string | null | undefined): boolean {
  if (!s) return false;
  return /<\/?[a-z][\s\S]*>/i.test(s);
}

/**
 * 并排图片布局。
 *
 * v-html 渲染出来的结构是「一个段落里塞了多张行内图片」，纯 CSS 没法知道
 * 每张图的宽高比，也做不了「行高跌破最小值就换行」的分行。
 * 算法与编辑器共用 web/src/utils/diaryImageLayout.ts（飞书式）：
 * 逐张累加分行、同一行等高、顶边对齐、data-flex 持久化用户拖出来的占比。
 */
const rootEl = ref<HTMLElement | null>(null);

function layoutRowImages() {
  const root = rootEl.value;
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.dc-content').forEach((content) => {
    layoutAllRows(content, { minHeight: 76, maxHeight: 300, gap: 4 });
    // 图片还没加载完（宽高比未知）→ 加载完重排一次
    bindPendingImageLoads(content, scheduleLayoutRows);
  });
}

let layoutRaf = 0;
function scheduleLayoutRows() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    layoutRowImages();
  });
}

onMounted(() => {
  nextTick(layoutRowImages);
  // 窗口宽度变化 → 卡片宽度变化 → 重新分行
  window.addEventListener('resize', scheduleLayoutRows);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleLayoutRows);
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
});
watch(() => props.items, () => nextTick(layoutRowImages));
</script>

<template>
  <div ref="rootEl" class="tl-wrap" @click="onContentClick">
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
                <span v-if="d.creator_name" class="dc-by">
                  {{ d.creator_name }}<template v-if="d.creator_identity">（{{ d.creator_identity }}）</template>
                  <template v-if="d.editor_name">、{{ d.editor_name }}<template v-if="d.editor_identity">（{{ d.editor_identity }}）</template></template>
                  记录
                </span>
                <span v-if="d.updated_at" class="dc-edited">已编辑</span>
              </div>
            </header>

            <!-- 富文本正文：v-html 渲染 Tiptap 输出的 HTML；老日记纯文本不含标签也能正常显示 -->
            <div
              v-if="d.content"
              class="dc-content"
              :class="{ 'is-plain-text': !hasHtml(d.content) }"
              v-html="d.content"
            ></div>

            <!-- 独立 media 区：仅老日记（content 为纯文本）时才渲染，新富文本日记的媒体都内嵌到 HTML 里 -->
            <div v-if="d.media.length && !hasHtml(d.content)" class="dc-media" :class="{ many: d.media.length > 3 }">
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
              <span v-if="d.media.length && !hasHtml(d.content)" class="dc-count">{{ mediaSummary(d.media) }}</span>
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
          <div class="lb-bar" @click.stop>
            <button
              class="lb-dl"
              type="button"
              @click="downloadMedia(preview!.url, preview!.name)"
            >
              ⬇ 下载原图
            </button>
          </div>
          <p class="lb-hint">点击空白处关闭</p>
        </div>
      </Transition>
    </Teleport>

    <!-- 富文本视频的独立播放浮层 -->
    <VideoPlayerModal
      v-model="videoPlayerOpen"
      :src="videoPlayerSrc"
      :poster="videoPlayerPoster"
      :name="videoPlayerName"
    />
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
  /* 比正文 H1（1.5em ≈ 21px）更大，凸显卡片标题 */
  font-size: 24px;
  font-weight: 700;
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
/* 与标题同色、50% 透明度，视觉上偏白变淡 */
.dc-by { color: var(--text-primary); opacity: 0.5; }
.dc-edited {
  padding: 0 var(--space-6);
  border-radius: var(--r-xs);
  background: var(--glass-bg-strong);
}

/* 正文：富文本样式 + 老日记纯文本兼容 */
.dc-content {
  margin-top: var(--space-8);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  line-height: 1.75;
  word-break: break-word;
}
/* 老日记纯文本保留换行 */
.dc-content.is-plain-text {
  white-space: pre-wrap;
}
/* 富文本：标题 */
.dc-content :deep(h1) {
  font-size: 1.5em; font-weight: 700;
  margin: 0.6em 0 0.3em; color: var(--text-primary); line-height: 1.3;
}
.dc-content :deep(h2) {
  font-size: 1.3em; font-weight: 700;
  margin: 0.5em 0 0.25em; color: var(--text-primary); line-height: 1.35;
}
.dc-content :deep(h3) {
  font-size: 1.15em; font-weight: 600;
  margin: 0.4em 0 0.2em; color: var(--text-primary); line-height: 1.4;
}
.dc-content :deep(h4) {
  font-size: 1.05em; font-weight: 600;
  margin: 0.3em 0 0.15em; color: var(--text-secondary); line-height: 1.4;
}
.dc-content :deep(p) { margin: 0.25em 0; }
.dc-content :deep(ul),
.dc-content :deep(ol) {
  padding-left: 1.5em; margin: 0.3em 0;
}
.dc-content :deep(ul) { list-style: disc; }
.dc-content :deep(ol) { list-style: decimal; }
.dc-content :deep(li) { margin: 0.1em 0; }
.dc-content :deep(blockquote) {
  border-left: 3px solid var(--accent-orange);
  padding: 0.3em 0.8em; margin: 0.4em 0;
  background: rgba(255, 209, 102, 0.12);
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
  color: var(--text-secondary); font-style: italic;
}
.dc-content :deep(hr) {
  border: none; border-top: 1px solid rgba(0, 0, 0, 0.18); margin: 0.8em 0;
}
.dc-content :deep(strong) { font-weight: 700; }
.dc-content :deep(em) { font-style: italic; }
.dc-content :deep(s) { text-decoration: line-through; opacity: 0.7; }
.dc-content :deep(a) { color: var(--text-on-orange); text-decoration: underline; }
/* 富文本内嵌图片 */
.dc-content :deep(img.diary-inline-image),
.dc-content :deep(img) {
  display: block; max-width: 100%; height: auto;
  border-radius: var(--r-md); margin: 0.5em auto;
}
/* 并排图片（飞书式行布局）：与编辑器共用 diaryImageLayout 算法。
   flex-wrap 换行 + JS 写的 flex-basis(px)：同一行等高、顶边对齐、
   图片再多也自动分行。data-flex 是用户在编辑器里拖出来的占比。 */
.dc-content :deep(p.img-row) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: flex-start;
}
.dc-content :deep(p.img-row > img) {
  display: block;
  flex-grow: 0;
  flex-shrink: 1;
  min-width: 0;
  width: auto;
  height: auto;
  max-width: none;
  margin: 0;
}
/* 富文本内嵌视频：16:9 自适应容器（兼容老日记的原生 video） */
.dc-content :deep(video) {
  display: block; max-width: 100%; height: auto;
  aspect-ratio: 16 / 9; object-fit: cover;
  border-radius: var(--r-md); margin: 0.5em auto;
  background: #000;
}

/* ─── 分栏表格（横向混排：图片 / 视频 / 文字）─── */
.dc-content :deep(.tableWrapper) {
  overflow-x: auto;
  margin: 0.6em 0;
}
.dc-content :deep(table.diary-table) {
  width: 100% !important;
  min-width: 0 !important;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}
/* 阅读端只留 2px 内边距：一行多图严格顶到左右两边、等高铺满 */
.dc-content :deep(table.diary-table td),
.dc-content :deep(table.diary-table th) {
  vertical-align: top;
  padding: 0 2px;
  border: none;
}
.dc-content :deep(table.diary-table td > p),
.dc-content :deep(table.diary-table th > p) {
  margin: 0;
}
/* 单元格里单张图片占满整列（列宽变化时高度按比例自适应） */
.dc-content :deep(table.diary-table td img),
.dc-content :deep(table.diary-table th img) {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  margin: 0;
  border-radius: var(--r-md);
}
.dc-content :deep(table.diary-table td > .diary-video) {
  margin-top: 0;
  margin-bottom: 0;
}

/* ─── 视频缩略图卡片（点击播放键打开独立播放浮层）─── */
.dc-content :deep(.diary-video) {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 0.5em 0;
  border-radius: var(--r-md);
  overflow: hidden;
  background: #141414;
}
/* 编辑器里缩放过宽度的视频：宽度写成内联 style，这里只补居中 */
.dc-content :deep(.diary-video[data-width]) {
  margin-left: auto;
  margin-right: auto;
}
/* 左 / 右对齐（编辑器工具栏写入的 data-align） */
.dc-content :deep(.diary-video[data-align='left']) {
  margin-left: 0;
  margin-right: auto;
}
.dc-content :deep(.diary-video[data-align='right']) {
  margin-left: auto;
  margin-right: 0;
}
.dc-content :deep(.diary-video .dv-thumb) {
  position: absolute;
  inset: 0;
}
.dc-content :deep(.diary-video .dv-thumb img) {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  margin: 0;
  object-fit: cover;
  border-radius: 0;
}
.dc-content :deep(.dv-thumb-empty) {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255, 255, 255, 0.5);
  font-size: var(--fs-sm);
  letter-spacing: 2px;
}
.dc-content :deep(.dv-play) {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(0, 0, 0, 0.52);
  color: #fff;
  font-size: 18px;
  line-height: 1;
  backdrop-filter: blur(4px);
  cursor: pointer;
}
.dc-content :deep(.dv-play:hover) {
  background: rgba(0, 0, 0, 0.72);
}
.dc-content :deep(.dv-name) {
  position: absolute;
  left: 10px;
  bottom: 8px;
  max-width: 72%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 11px;
}
/* 对齐样式（Tiptap TextAlign 输出） */
.dc-content :deep(.text-align-center) { text-align: center; }
.dc-content :deep(.text-align-right) { text-align: right; }

/* ─── 高亮块（Callout）─── */
.dc-content :deep(.callout) {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  margin: 0.6em 0;
  border-radius: var(--r-md);
  background: rgba(255, 209, 102, 0.12);
  border: 1px solid rgba(255, 209, 102, 0.35);
}
.dc-content :deep(.callout-emoji) {
  flex-shrink: 0;
  font-size: 20px;
  line-height: 1.4;
}
.dc-content :deep(.callout-content) { flex: 1; min-width: 0; }
.dc-content :deep(.callout-content p) { margin: 0; }

/* ─── 任务列表（Task List）─── */
.dc-content :deep(ul[data-type="taskList"]) {
  list-style: none; padding: 0; margin: 0.5em 0;
}
/* Tiptap v3 的 li 只带 data-checked，用父级 ul 定位 */
.dc-content :deep(ul[data-type="taskList"] > li) {
  display: flex; align-items: flex-start; gap: 8px; margin: 4px 0;
}
.dc-content :deep(ul[data-type="taskList"] > li > label) {
  flex-shrink: 0; display: flex; align-items: center; height: 1.7em;
}
.dc-content :deep(ul[data-type="taskList"] > li input[type="checkbox"]) {
  width: 16px; height: 16px; margin: 0; accent-color: var(--accent-yellow);
}
.dc-content :deep(ul[data-type="taskList"] > li > div) { flex: 1; min-width: 0; }
.dc-content :deep(ul[data-type="taskList"] > li > div p) { margin: 0; line-height: 1.7; }
.dc-content :deep(ul[data-type="taskList"] > li[data-checked="true"] > div p) {
  text-decoration: line-through; color: var(--text-muted);
}
/* 复选框跟随文字对齐方式（TextAlign 把 text-align 写在 p 的内联样式上） */
.dc-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: center"])) {
  justify-content: center;
}
.dc-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: right"])) {
  justify-content: flex-end;
}
.dc-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: center"]) > div),
.dc-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: right"]) > div) {
  flex: 0 1 auto;
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
.lb-bar { display: flex; gap: var(--space-8); }
.lb-dl {
  padding: 7px 16px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.92);
  color: #1f1f1f;
  font-size: var(--fs-sm);
  font-weight: 600;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.lb-dl:hover { background: #fff; }
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
