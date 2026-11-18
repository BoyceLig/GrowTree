<script setup lang="ts">
/**
 * 日记富文本编辑器（Tiptap + 飞书风格块编辑）。
 *
 * 功能：
 *   - 四级标题（H1-H4）：输入 # / ## / ### / #### + 空格 自动转换（Markdown 快捷输入）
 *   - 有序/无序列表：输入 1. / - + 空格 自动转换
 *   - 粗体/斜体/下划线/删除线：工具栏按钮 + 快捷键 Cmd/Ctrl+B/I/U
 *   - 引用块：输入 > + 空格 自动转换
 *   - 分割线：--- + 空格
 *   - 图片：工具栏按钮选文件上传 → 插入光标位置；飞书式行布局（等高并排、多行自适应）；
 *     可拖动图片重排（并入别的行 / 拖到空白处换行），拖图片边缘调整占比（保持宽高比）
 *   - 视频：不限大小，拖拽/粘贴上传，左右充满
 *   - 撤销/重做：Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z
 *
 * 存储：通过 modelValue / update:modelValue 双向绑定 HTML 字符串
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor, type Editor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { TableKit } from '@tiptap/extension-table';
import { cellAround, columnResizingPluginKey, deleteColumn, deleteTable } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
// 注意：不再用 @tiptap/pm/state 的 NodeSelection
// 因为 ProseMirror 会把 inline 节点的 NodeSelection 自动降级为 TextSelection
// 选中态改为原生 DOM click + 手动 .img-selected class
import DiaryImage from './extensions/DiaryImage';
import Video, { isSupportedVideoFile, videoFormatHint } from './extensions/Video';
import Callout from './extensions/Callout';
import EmojiPicker from './EmojiPicker.vue';
import VideoPlayerModal from './VideoPlayerModal.vue';
import { uploadMedia } from '@/utils/mediaUpload';
import { downloadMedia } from '@/utils/mediaDownload';
import { compressImage } from '@/utils/imageCompress';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    /** 是否显示字数统计（编辑器内容的纯文本长度） */
    showCounter?: boolean;
  }>(),
  {
    placeholder: '今天发生了什么？试试输入 # 标题，1. 列表，> 引用…',
    showCounter: true,
  }
);

const emit = defineEmits<{
  'update:modelValue': [html: string];
  /** 编辑器内容变化时同时传出纯文本（给字数统计/搜索用） */
  change: [html: string, text: string];
}>();

/** 日记大图上传前的长边上限：铺满编辑区 / 放大看都不糊，又不必保留手机原图 */
const MAX_DIARY_IMAGE_EDGE = 1600;
// 视频不限大小：家庭场景的原始视频动辄几十上百 MB，20MB 上限太容易撞。
// 代价是超大文件走 base64 JSON 上传会占内存，后端 bodyLimit 已放到 512MB。

const editorEl = ref<InstanceType<typeof EditorContent> | null>(null);
/** 编辑区滚动容器：浮动工具条/选中框/拖拽指示线的可视边界 */
const scrollEl = ref<HTMLElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const videoInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
/** 图片上传进度（0-100），上传时在编辑器右下角显示小胶囊 */
const uploadPct = ref(0);
/** 当前选中的媒体（图片 / 视频卡片）用于浮动工具栏定位；null = 没有选中 */
const selectedMedia = ref<{
  kind: 'image' | 'video';
  pos: number;
  top: number;
  bottom: number;
  left: number;
} | null>(null);
// 拖拽状态：文件拖进编辑区时显示高亮边框
const isDraggingOver = ref(false);
let dragCounter = 0;

// Emoji 选择器状态（点击高亮块的 emoji 按钮时弹出）
const emojiPickerOpen = ref(false);
// 当前正在编辑 emoji 的高亮块 DOM 元素（用于定位选择器 + 更新 emoji）
const activeCalloutEl = ref<HTMLElement | null>(null);

// EmojiPicker 定位到被点击的 emoji 按钮下方
const emojiPickerStyle = computed(() => {
  if (!activeCalloutEl.value) return {};
  const rect = activeCalloutEl.value.getBoundingClientRect();
  const top = rect.bottom + 6;
  const left = rect.left;
  // 防止超出右边界
  const maxLeft = window.innerWidth - 360;
  return {
    position: 'fixed',
    top: `${top}px`,
    left: `${Math.min(left, maxLeft)}px`,
    zIndex: 9999,
  };
});

// ─── Tiptap 编辑器实例 ────────────────────────────────────────────────────
/** 编辑器最近一次通过 onUpdate 发出的 HTML；用于识别父组件原样传回的「回声」更新 */
let lastEmittedHtml = '';

const editor = useEditor({
  content: props.modelValue || '',
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // StarterKit 默认有 Undo/Redo，不需要额外加
      // 关闭 StarterKit 里的 strike 冲突（没冲突就不管）
    }),
    DiaryImage.configure({
      HTMLAttributes: {
        class: 'diary-inline-image',
      },
    }),
    Placeholder.configure({
      placeholder: props.placeholder,
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    // 任务列表（带复选框的待办列表）
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    // 自定义高亮块（Callout）：左边 emoji + 右边文本
    Callout,
    // tiptap-markdown：让编辑器识别 Markdown 输入规则（# 空格 → H1 等）
    Markdown.configure({
      html: true,           // 允许 HTML 标签混写（存回 HTML 不丢）
      transformPastedText: true,
      transformCopiedText: false,
    }),
    // 自定义 Video 节点：让视频也能内嵌到富文本里，突破独立 media 数组的数量限制
    Video,
    // 分栏（表格）容器：图片/视频/文字段落横向混排，列宽可拖动调整
    TableKit.configure({
      table: {
        resizable: true,
        // 最后一列不可拖边界：避免把表格拖得比编辑区还宽（出现横向滚动）
        lastColumnResizable: false,
        allowTableNodeSelection: true,
        handleWidth: 8,
        cellMinWidth: 40,
        HTMLAttributes: { class: 'diary-table' },
      },
    }),
  ],
  editorProps: {
    attributes: {
      class: 'diary-editor-body',
    },
    /**
     * 图片 / 视频不参与文字选择。
     *
     * 图片是 inline atom，如果把 mousedown 交给 ProseMirror，它会从按下点开始
     * 一段 TextSelection：拖一次之后整块内容进入「文字框选」状态，
     * 再拖就变成文本拖放（甚至跨过图片把相邻内容一起选中）。
     * 图片的选中与拖拽本来就由本组件的 pointer / click 逻辑处理，
     * 所以这里直接吞掉按下与浏览器原生拖动，只保留 click。
     */
    handleDOMEvents: {
      mousedown: (_view, event) => {
        if (!isMediaEventTarget(event.target)) return false;
        // 表格列宽热区：单元格里的图片铺满整格，按在线上时真实 target 是图片。
        // 这里必须放行，否则 mousedown 被吞掉，列宽手柄就拖不动了。
        if (isColumnResizeHotspot(event as MouseEvent)) return false;
        event.preventDefault();
        return true;
      },
      dragstart: (_view, event) => {
        if (!isMediaEventTarget(event.target)) return false;
        event.preventDefault();
        return true;
      },
      // 双击图片也不进入文字选择（否则会把图片连同相邻文字选成一段）
      dblclick: (_view, event) => {
        if (!isMediaEventTarget(event.target)) return false;
        event.preventDefault();
        return true;
      },
      // 点击图片只走本组件的选中逻辑，不让 PM 把光标/选区落到图片上
      click: (_view, event) => {
        if (!isMediaEventTarget(event.target)) return false;
        return true;
      },
    },
    /**
     * 删除键逻辑（与删除文字对齐）：
     *   - 有选中的媒体（图片 / 视频）+ Backspace / Delete → 删掉它；
     *   - 光标紧跟图片后面 + Backspace → 删这张图；
     *   - 光标紧贴图片前面 + Delete → 删这张图；
     *   - 光标在图片前面 + Backspace → 不拦截，按默认删图片前面的内容。
     *   - 表格某列删空后继续按删除 → 删当前列（原有逻辑兜底）。
     */
    handleKeyDown: (view, event) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      // 有选中的图片 / 视频 → 直接删掉它（默认行为会先「选中节点」再删一大片，误伤分栏内容）
      if (
        selectedMediaEl &&
        document.body.contains(selectedMediaEl) &&
        (selectedMedia.value?.pos ?? -1) >= 0
      ) {
        deleteSelectedMedia();
        return true;
      }
      if (event.key === 'Backspace') {
        // 光标紧跟图片后面 → 删这张图
        if (deleteAdjacentImage(view, -1)) return true;
      } else if (deleteAdjacentImage(view, 1)) {
        // 光标紧贴在图片前面 → Delete 正向删掉这张图
        return true;
      }
      return deleteEmptyColumnAtTopRow(view);
    },
  },
  onUpdate: ({ editor }) => {
    const html = editor.getHTML();
    lastEmittedHtml = html;
    const text = editor.getText();
    emit('update:modelValue', html);
    emit('change', html, text);
    editorTick.value++;
    scheduleOverlaySync();
  },
  onSelectionUpdate: () => {
    // DOM 可能重建 → 恢复选中态并重新定位悬浮元素
    editorTick.value++;
    scheduleOverlaySync();
  },
  onBlur: () => {
    clearMediaSelection();
  },
});

/** 当前选中媒体（图片 / 视频卡片）的 DOM 引用：选中框、缩放手柄、键盘删除共用 */
let selectedMediaEl: HTMLElement | null = null;

/** 媒体元素类型（图片 / 视频卡片） */
function mediaKindOf(el: HTMLElement | null): 'image' | 'video' | null {
  if (!el) return null;
  if (el instanceof HTMLImageElement) return 'image';
  if (el.classList.contains('diary-video')) return 'video';
  return null;
}

/**
 * 存活编辑器实例：销毁后返回 null。
 * tiptap v2 在 destroy 后访问 .view 会直接抛
 * "[tiptap error]: The editor view is not available"，
 * 而异步回调（上传完成、document 级指针监听）可能在弹窗关闭后才触发，
 * 所有延迟路径必须走这个守卫。
 */
function liveEditor(): Editor | null {
  const ed = editor.value;
  return ed && !ed.isDestroyed ? ed : null;
}

/** 事件目标是否落在图片 / 视频媒体上（含 NodeView 外壳） */
function isMediaEventTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.diary-video') || el.closest('.diary-img-shell')) return true;
  const img = el.closest('img.diary-inline-image');
  return !!img && !img.classList.contains('ProseMirror-separator');
}

/** 事件目标对应的可拖拽媒体元素（图片 / 视频卡片；播放键除外） */
function mediaElementAt(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  if (el.closest('.dv-play')) return null;
  const video = el.closest('.diary-video') as HTMLElement | null;
  if (video) return video;
  const img = el.closest('img.diary-inline-image') as HTMLImageElement | null;
  if (img && !img.classList.contains('ProseMirror-separator')) return img;
  return null;
}

/** shell 内 img 的文档位置（img 被 NodeView 外壳包裹，posAtDOM 要走外壳） */
function imgNodePos(view: any, img: HTMLImageElement): number {
  const shell = (img.closest('.diary-img-shell') as HTMLElement | null) || img;
  return view.posAtDOM(shell, 0);
}

/** 选中编辑器里的图片或视频卡片（共用一套选中框 + 缩放手柄） */
function selectMedia(el: HTMLElement) {
  const ed = liveEditor();
  if (!ed) return;
  const kind = mediaKindOf(el);
  if (!kind) return;
  const body = ed.view.dom;
  // 先清掉之前选中的
  body.querySelectorAll('.img-selected').forEach((node) => node.classList.remove('img-selected'));
  el.classList.add('img-selected');
  selectedMediaEl = el;
  // 计算位置 → 选中框 + 浮动工具栏
  const rect = el.getBoundingClientRect();
  const pos = mediaNodePos(ed, el);
  /**
   * 图片是行内原子：把 ProseMirror 的 selection 停在图片旁的段内位置。
   * 图片的按下/双击已被 handleDOMEvents 吞掉（避免变成文字框选），
   * 不补偿这一下的话，对齐/删除等命令会作用到上一次光标所在的段落。
   *
   * 视频是块级原子：不动 PM 选区（否则光标会被挤到相邻段落，
   * 后续 Backspace 容易误删旁边的内容）；删除/缩放都按节点位置算。
   */
  if (kind === 'image') {
    try {
      // 直接落在图片前的段内位置（不跨段落，保证对齐命令命中图片所在段落）
      const sel = TextSelection.create(ed.state.doc, pos);
      if (!ed.state.selection.eq(sel)) {
        ed.view.dispatch(ed.state.tr.setSelection(sel));
      }
    } catch {
      /* 结构正在变化 */
    }
  }
  // 媒体的 mousedown 被拦掉后浏览器不会自动聚焦，这里补上：
  // 选中后 Ctrl+Z、删除键仍然作用在编辑器上
  ed.view.focus();
  selectedMedia.value = {
    kind,
    pos,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left + rect.width / 2,
  };
  positionSelection();
  void measureToolBox();
}

/** 清除媒体选中态 */
function clearMediaSelection() {
  if (selectedMediaEl) {
    selectedMediaEl.classList.remove('img-selected');
    selectedMediaEl = null;
  }
  liveEditor()
    ?.view.dom.querySelectorAll('.img-selected')
    .forEach((node) => node.classList.remove('img-selected'));
  selectedMedia.value = null;
  selFrame.value = null;
}

/** DOM 重建后，如果之前有选中的媒体，按 src 在新 DOM 里找回它 */
function syncMediaSelectedClass() {
  const body = liveEditor()?.view.dom;
  if (!body) return;
  if (!selectedMediaEl) return; // 没有选中的，不用同步
  // 元素还在文档里（视频 NodeView 复用同一个 div）→ 只补回 class
  if (body.contains(selectedMediaEl)) {
    if (!selectedMediaEl.classList.contains('img-selected')) {
      selectedMediaEl.classList.add('img-selected');
    }
    return;
  }

  if (selectedMedia.value?.kind === 'video') {
    const src = selectedMediaEl.dataset.src;
    if (!src) return;
    const match = body.querySelector<HTMLElement>(`.diary-video[data-src="${CSS.escape(src)}"]`);
    if (match) {
      selectedMediaEl = match;
      match.classList.add('img-selected');
    }
    return;
  }

  const oldSrc = selectedMediaEl.getAttribute('src');
  if (!oldSrc) return;
  const match = body.querySelector<HTMLImageElement>(
    `img.diary-inline-image[src="${CSS.escape(oldSrc)}"]`
  );
  if (match && match !== selectedMediaEl) {
    selectedMediaEl = match;
    match.classList.add('img-selected');
  }
}

/**
 * 原生 click 处理：
 *   点图片 / 视频预览区（播放键除外）→ 选中；
 *   点编辑器其他地方 → 清除选中。
 */
function handleEditorBodyClick(e: MouseEvent) {
  // 刚结束一次拖拽重排，这一下 click 是松手的余波，不要触发选中
  if (Date.now() < suppressClickUntil) {
    clearMediaSelection();
    return;
  }
  const target = e.target as HTMLElement;
  // 点到真实图片（非 ProseMirror-separator 占位图）
  if (
    target?.tagName === 'IMG' &&
    target.classList.contains('diary-inline-image') &&
    !target.classList.contains('ProseMirror-separator')
  ) {
    const img = target as HTMLImageElement;
    // 如果已经是选中状态，保持选中（不重复加 class）
    if (img.classList.contains('img-selected')) return;
    selectMedia(img);
    return;
  }
  // 点到视频卡片的预览区域（播放键有自己的点击行为，不参与选中）
  const video = target?.closest?.('.diary-video') as HTMLElement | null;
  if (video && !target.closest('.dv-play')) {
    if (video.classList.contains('img-selected')) return;
    selectMedia(video);
    return;
  }
  // 点到编辑器其他地方 → 清掉选中
  // 但如果是纯图片段落里图片左/右侧的空白，把光标精确放到图片前/后
  // （PM 的 posAtCoords 在 atom 附近容易落到图片另一侧或图片内部）
  placeCaretBesideImage(e);
  clearMediaSelection();
}

/**
 * 点击纯图片段落中图片外侧的空白 → 光标落到最近一张图片的前面/后面。
 * 返回 true 表示已经接管了这次点击。
 */
function placeCaretBesideImage(e: MouseEvent): boolean {
  const ed = liveEditor();
  if (!ed) return false;
  const el = e.target as HTMLElement | null;
  const p = el?.closest?.('p') as HTMLElement | null;
  if (!p) return false;
  // 只处理纯媒体段落；图文混排时按点击位置正常定位
  if (p.textContent && p.textContent.trim()) return false;

  const imgs = Array.from(
    p.querySelectorAll<HTMLImageElement>('img.diary-inline-image:not(.ProseMirror-separator)')
  );
  if (!imgs.length) return false;
  const pr = p.getBoundingClientRect();
  if (e.clientY < pr.top || e.clientY > pr.bottom) return false;

  let targetPos = -1;
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left) {
      // 点在这张图左侧的空白 → 图片前
      targetPos = imgNodePos(ed.view, img);
      break;
    }
    if (e.clientX <= r.right) return false; // 点在图片上，交给选中逻辑
  }
  if (targetPos < 0) {
    // 点在所有图片右侧 → 最后一张图之后（图片是 inline atom，nodeSize = 1）
    const last = imgs[imgs.length - 1];
    targetPos = imgNodePos(ed.view, last) + 1;
  }
  if (targetPos < 0) return false;

  try {
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, targetPos)));
    ed.view.focus();
    return true;
  } catch {
    return false;
  }
}

// 同步外部 modelValue 变化（比如切换到另一篇日记时需要 setContent）
watch(
  () => props.modelValue,
  (val) => {
    const ed = liveEditor();
    if (!ed) return;
    const current = ed.getHTML();
    // 避免 setContent 触发 onUpdate 又 emit 回去造成死循环
    if (current === (val || '')) return;
    // 回声防护：val 是编辑器刚 emit 出去、又被父组件原样传回的内容。
    // 若 HTML 往返序列化有漂移，每次回传都会再 setContent → onUpdate → emit，
    // 无限重建 <img>，浏览器会以每秒几百次的频率重复请求日记图片，
    // 曾把 dev 后端刷到内存崩溃（Zone Allocation failed）。
    // 只要是自己刚发出去的内容，无论编辑器内部是否漂移，一律不再回写。
    if (val && val === lastEmittedHtml) return;
    ed.commands.setContent(val || '', { emitUpdate: false });
  }
);

// ─── 工具栏按钮状态 ────────────────────────────────────────────────────────
function isActive(name: string, attrs?: Record<string, any>) {
  return editor.value?.isActive(name, attrs) ?? false;
}

/** 检查当前段落/标题的文本对齐方式（TextAlign 扩展属性） */
function isAlign(align: 'left' | 'center' | 'right') {
  const ed = liveEditor();
  if (!ed) return align === 'left';
  // TextAlign 会把对齐方式写到当前节点的 attrs.textAlign 上，未设置时默认就是左对齐
  const { selection } = ed.state;
  const node = selection.$anchor.parent;
  const current = node.attrs.textAlign ?? 'left';
  return current === align;
}

function toggleHeading(level: 1 | 2 | 3 | 4) {
  editor.value?.chain().focus().toggleHeading({ level }).run();
}
function toggleBulletList() {
  editor.value?.chain().focus().toggleBulletList().run();
}
function toggleOrderedList() {
  editor.value?.chain().focus().toggleOrderedList().run();
}
function toggleQuote() {
  editor.value?.chain().focus().toggleBlockquote().run();
}
function toggleTaskList() {
  editor.value?.chain().focus().toggleTaskList().run();
}
function toggleCallout() {
  editor.value?.chain().focus().toggleCallout().run();
}
function toggleBold() {
  editor.value?.chain().focus().toggleBold().run();
}
function toggleItalic() {
  editor.value?.chain().focus().toggleItalic().run();
}
function toggleStrike() {
  editor.value?.chain().focus().toggleStrike().run();
}
function setTextAlign(align: 'left' | 'center' | 'right') {
  editor.value?.chain().focus().setTextAlign(align).run();
}
function setHorizontalRule() {
  editor.value?.chain().focus().setHorizontalRule().run();
}
function undo() {
  editor.value?.chain().focus().undo().run();
}
function redo() {
  editor.value?.chain().focus().redo().run();
}

// ─── 分栏（表格）：图片/视频/文字段落横向混排 ──────────────────────────────
/** 光标/内容变化的计数器：让工具栏的分栏上下文按钮跟着刷新 */
const editorTick = ref(0);
const isInTable = computed(() => {
  editorTick.value;
  return editor.value?.isActive('table') ?? false;
});

/** 插入 1 行 2 列的分栏，光标落在第一列 */
function insertColumns() {
  editor.value?.chain().focus().insertTable({ rows: 1, cols: 2, withHeaderRow: false }).run();
}
function addColumn() {
  editor.value?.chain().focus().addColumnAfter().run();
}
function removeColumn() {
  editor.value?.chain().focus().deleteColumn().run();
}
function removeTable() {
  editor.value?.chain().focus().deleteTable().run();
}

// ─── 图片上传：选文件 → 传后端 → 插入光标位置 ───────────────────────────────
function pickImage() {
  imageInput.value?.click();
}

async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
  input.value = '';
  if (!files.length || !editor.value) return;

  uploading.value = true;
  uploadPct.value = 0;
  try {
    // 多选时一次性放进同一段落，直接并排展示
    if (files.length === 1) await insertImageFile(files[0]);
    else await insertImageBlock(files);
  } finally {
    uploading.value = false;
  }
}

// ─── 视频上传：占位 + 进度 + 缩略图 + 独立播放 ─────────────────────────────
function pickVideo() {
  videoInput.value?.click();
}

async function onVideoPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || !editor.value) return;
  for (const f of files) {
    await insertVideoFile(f);
  }
}

// 独立播放浮层：NodeView / 展示端点击播放键时派发全局事件
const videoPlayerOpen = ref(false);
const videoPlayerSrc = ref('');
const videoPlayerPoster = ref('');

function onPlayVideoEvent(e: Event) {
  const detail = (e as CustomEvent<{ src?: string; poster?: string }>).detail;
  if (!detail?.src) return;
  videoPlayerSrc.value = detail.src;
  videoPlayerPoster.value = detail.poster || '';
  videoPlayerOpen.value = true;
}

/** 在文档里找「上传中的视频占位」（按 tempId） */
function findUploadingVideoPos(ed: Editor, tempId: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === 'video' && node.attrs.tempId === tempId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** 把上传进度画到视频占位的 NodeView 上（不产生事务） */
function updateVideoProgress(ed: Editor, tempId: string, pct: number) {
  const pos = findUploadingVideoPos(ed, tempId);
  if (pos < 0) return;
  const el = ed.view.nodeDOM(pos) as HTMLElement | null;
  if (!el) return;
  const bar = el.querySelector<HTMLElement>('.dv-progress-bar');
  const text = el.querySelector<HTMLElement>('.dv-upload-text');
  if (bar) bar.style.width = `${pct}%`;
  if (text) text.textContent = `上传中 ${pct}%`;
}

/** 视频探测结果：缩略图 + 存进元数据表的尺寸/时长 */
interface VideoProbe {
  poster: string;
  duration: number | null;
  width: number | null;
  height: number | null;
}

/**
 * 本地视频截帧 → 作为图片上传，得到缩略图 URL；
 * 顺带读出时长与像素尺寸（上传接口把它们存进 upload_files，供下载/元数据查看）。
 * 失败时 poster 为空串，其余字段为 null。
 */
async function probeVideo(blobUrl: string): Promise<VideoProbe> {
  const meta: Omit<VideoProbe, 'poster'> = { duration: null, width: null, height: null };
  const dataUrl = await new Promise<string | null>((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const timer = setTimeout(() => done(null), 8000);
    function done(val: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* ignore */
      }
      resolve(val);
    }
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = blobUrl;
    v.onloadeddata = () => {
      meta.duration =
        Number.isFinite(v.duration) && v.duration > 0
          ? Math.round(v.duration * 100) / 100
          : null;
      meta.width = v.videoWidth || null;
      meta.height = v.videoHeight || null;
      try {
        v.currentTime = Math.min(0.1, (v.duration || 0) / 3);
      } catch {
        done(null);
      }
    };
    v.onseeked = () => {
      try {
        const w = 480;
        const ratio = v.videoWidth ? v.videoHeight / v.videoWidth : 9 / 16;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = Math.max(1, Math.round(w * ratio));
        const ctx = canvas.getContext('2d');
        if (!ctx) return done(null);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        done(null);
      }
    };
    v.onerror = () => done(null);
  });
  if (!dataUrl) return { poster: '', ...meta };
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const res = await uploadMedia(new File([blob], 'video-poster.jpg', { type: 'image/jpeg' }));
    return { poster: res.url, ...meta };
  } catch {
    return { poster: '', ...meta };
  }
}

/** 插入视频：先占位并显示百分比，上传完成后换成「缩略图 + 播放键」卡片 */
async function insertVideoFile(file: File, insertPos?: number) {
  if (!isSupportedVideoFile(file)) {
    alert(videoFormatHint(file));
    return;
  }
  const ed = liveEditor();
  if (!ed) return;

  const tempId = `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const blobUrl = URL.createObjectURL(file);

  const chain = ed.chain().focus();
  if (insertPos !== undefined) chain.setTextSelection(insertPos);
  chain.setVideo({ src: '', name: file.name, uploading: true, tempId }).run();

  const current = liveEditor();
  if (!current) {
    URL.revokeObjectURL(blobUrl);
    return;
  }

  let lastPct = -1;
  uploading.value = true;
  try {
    // 先截帧 + 读时长/尺寸：原始文件名和这些元数据要在上传请求里一起带给服务端
    const probe = await probeVideo(blobUrl);
    const res = await uploadMedia(
      file,
      (p) => {
        uploadPct.value = p;
        if (p === lastPct) return;
        lastPct = p;
        const live = liveEditor();
        if (live) updateVideoProgress(live, tempId, p);
      },
      {
        name: file.name,
        duration: probe.duration ?? undefined,
        width: probe.width ?? undefined,
        height: probe.height ?? undefined,
      }
    );

    const live = liveEditor();
    if (!live) return;
    const pos = findUploadingVideoPos(live, tempId);
    if (pos < 0) return;
    const node = live.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'video') return;
    live.view.dispatch(
      live.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src: res.url,
        poster: probe.poster,
        name: res.name || node.attrs.name,
        uploading: false,
        tempId: null,
      })
    );
  } catch (err: any) {
    console.error('视频上传失败', err);
    const live = liveEditor();
    if (live) {
      const pos = findUploadingVideoPos(live, tempId);
      if (pos >= 0) {
        const node = live.state.doc.nodeAt(pos);
        if (node) live.view.dispatch(live.state.tr.delete(pos, pos + node.nodeSize));
      }
    }
    alert(err?.message || '视频上传失败，请重试');
  } finally {
    URL.revokeObjectURL(blobUrl);
    uploading.value = false;
  }
}

// ─── 图片插入（本地预览 + 上传进度提示） ───────────────────────────────────
/**
 * 插入图片：先插入本地 blob 预览，传完把 src 换成服务器地址。
 * 进度不再画在图片上（自定义 NodeView 已被移除），改为编辑器右下角的小胶囊。
 */
async function insertImageFile(file: File, insertPos?: number) {
  const ed = liveEditor();
  if (!ed) return;

  const preview = URL.createObjectURL(file);

  const chain = ed.chain().focus();
  if (insertPos !== undefined) chain.setTextSelection(insertPos);
  // 原始文件名随节点保存：磁盘名是随机 ID，下载时用它还原
  chain.insertContent({ type: 'image', attrs: { src: preview, name: file.name } }).run();


  try {
    // 原图动辄几 MB，先缩到长边上限再传：预览用本地原图，不影响插入体验
    const uploadFile = await compressImage(file, { maxEdge: MAX_DIARY_IMAGE_EDGE });
    const size = await measureImageFile(uploadFile);
    const res = await uploadMedia(
      uploadFile,
      (p) => {
        uploadPct.value = p;
      },
      { name: file.name, width: size?.width, height: size?.height }
    );
    replaceImageSrc(preview, res.url);
  } catch (err: any) {
    console.error('图片插入失败', err);
    removeImageBySrc(preview);
  } finally {
    URL.revokeObjectURL(preview);
  }
}

/** 读图片的实际像素尺寸（只用于上传元数据；失败返回 null，不影响上传） */
function measureImageFile(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size =
        img.naturalWidth && img.naturalHeight
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null;
      URL.revokeObjectURL(url);
      resolve(size);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** 读本地图片的宽高比（失败按 1:1，避免列宽崩掉） */
function imageAspectFromFile(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ar =
        img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      URL.revokeObjectURL(url);
      resolve(ar);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(1);
    };
    img.src = url;
  });
}

/** 按宽高比分配列宽：总和 = 容器宽；列宽 = pad + ar × H → 图片等高 */
function balancedColumnWidths(ars: number[], totalWidth: number, pad = 4): number[] {
  const content = Math.max(40, totalWidth - pad * ars.length);
  const sumAr = ars.reduce((sum, ar) => sum + ar, 0) || ars.length;
  const widths = ars.map((ar) => Math.max(40, Math.round((content * ar) / sumAr + pad)));
  const sum = widths.reduce((acc, w) => acc + w, 0);
  widths[widths.length - 1] += totalWidth - sum;
  return widths;
}

/**
 * 一次插入多张图片：直接建成一张 N 列分栏表格（每列一张图），
 * 不再走「同一段落 flex 并排」的旧排版。
 */
async function insertImageBlock(files: File[], insertPos?: number) {
  const ed = liveEditor();
  if (!ed) return;

  const ars = await Promise.all(files.map(imageAspectFromFile));
  const items = files.map((file, i) => ({
    file,
    ar: ars[i] || 1,
    preview: URL.createObjectURL(file),
  }));
  const schema = ed.state.schema;
  const editorWidth = (ed.view.dom as HTMLElement).clientWidth || 320;
  const widths = balancedColumnWidths(
    items.map((it) => it.ar),
    editorWidth
  );

  const chain = ed.chain().focus();
  if (insertPos !== undefined) chain.setTextSelection(insertPos);

  if (ed.isActive('table')) {
    // 表格内不能嵌表格：退化为逐张插入（各自独立段落，纵向排列）
    for (const it of items) {
      ed.chain()
        .focus()
        .insertContent({
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: it.preview, name: it.file.name } }],
        })
        .run();
    }
  } else {
    const cells = items.map((it, i) =>
      schema.nodes.tableCell.create({ colwidth: [widths[i]] }, [
        schema.nodes.paragraph.create(null, [
          schema.nodes.image.create({ src: it.preview, name: it.file.name }),
        ]),
      ])
    );
    const row = schema.nodes.tableRow.create(null, cells);
    const table = schema.nodes.table.create(null, [row]);
    chain.insertContent(table).run();
  }

  await Promise.all(
    items.map(async (it) => {
      try {
        const uploadFile = await compressImage(it.file, { maxEdge: MAX_DIARY_IMAGE_EDGE });
        const size = await measureImageFile(uploadFile);
        // 多图按列串行发送，进度胶囊才能反映真实先后
        const res = await uploadMedia(
          uploadFile,
          (p) => {
            uploadPct.value = p;
          },
          { name: it.file.name, width: size?.width, height: size?.height }
        );
        replaceImageSrc(it.preview, res.url);
      } catch (err: any) {
        console.error('图片插入失败', err);
        removeImageBySrc(it.preview);
      } finally {
        URL.revokeObjectURL(it.preview);
      }
    })
  );

  // 列宽已按图片比例算好；这里只把总宽对齐到表格容器宽度（保持比例）
  scheduleFitTables();
}

// ─── 表格列宽自适应：一行多图等高、铺满编辑区、不产生横向滚动 ─────────────
let balanceRaf = 0;

function scheduleBalanceTables() {
  if (balanceRaf) return;
  balanceRaf = requestAnimationFrame(() => {
    balanceRaf = 0;
    balanceTableColumns();
    // 全媒体表格已经按比例铺满；其它表格（含空格子）再兜一层，避免列宽总和超出编辑区
    clampTableOverflow();
  });
}

// 窗口尺寸变化：只按当前列宽比例缩放，不重置用户手动拖过的列宽
let fitRaf = 0;
function scheduleFitTables() {
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitTableWidths();
  });
}

function fitTableWidths() {
  const ed = liveEditor();
  if (!ed) return;
  const view = ed.view;
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const el = view.nodeDOM(pos) as HTMLElement | null;
    if (!el) return false;
    const tableEl = (el.matches('table') ? el : el.querySelector('table')) as HTMLTableElement | null;
    if (!tableEl) return false;
    const total = tableEl.parentElement?.clientWidth || tableEl.clientWidth;
    const cols = Array.from(tableEl.querySelectorAll<HTMLElement>('colgroup > col'));
    if (!total || !cols.length) return false;
    const widths = cols.map((c) => Number.parseFloat(c.style.width || '') || 0);
    const sum = widths.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) return false;
    let acc = 0;
    cols.forEach((col, i) => {
      const w =
        i === cols.length - 1 ? Math.max(0, total - acc) : Math.round((total * widths[i]) / sum);
      col.style.width = `${w}px`;
      acc += w;
    });
    return false;
  });
}

/**
 * 一行里每一列都是单个媒体（图片 / 视频）时，按原始宽高比重新分配列宽：
 *   - 列宽总和 = 表格容器宽度（左右顶到边，不出现横向滚动）
 *   - 每列宽 = padding + ar × H，保证所有列图片高度一致（同为 H）
 * 含文字列、合并单元格的表格不动（保留用户/默认列宽）。
 */
function balanceTableColumns() {
  const ed = liveEditor();
  if (!ed) return;
  const view = ed.view;

  const tables: { pos: number; node: any; el: HTMLElement }[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      const el = view.nodeDOM(pos) as HTMLElement | null;
      if (el) tables.push({ pos, node, el });
      return false;
    }
    return true;
  });
  if (!tables.length) return;

  let tr = ed.state.tr;
  let changed = false;
  const PAD = 4; // td 左右 padding 2 + 2

  for (const { pos, node, el } of tables) {
    const tableEl = (el.matches('table') ? el : el.querySelector('table')) as HTMLElement | null;
    if (!tableEl) continue;
    const firstRowEl = tableEl.querySelector('tr') as HTMLElement | null;
    if (!firstRowEl) continue;
    const tds = Array.from(firstRowEl.children) as HTMLTableCellElement[];
    if (!tds.length) continue;
    if (tds.some((td) => td.colSpan > 1)) continue; // 合并单元格不参与

    const ars: number[] = [];
    let allMedia = true;
    for (const td of tds) {
      const media = td.querySelector<HTMLElement>('img.diary-inline-image, .diary-video');
      if (!media) {
        allMedia = false;
        break;
      }
      if (media instanceof HTMLImageElement && media.naturalWidth && media.naturalHeight) {
        ars.push(media.naturalWidth / media.naturalHeight);
      } else {
        ars.push(16 / 9);
      }
    }
    if (!allMedia) continue;

    const total = tableEl.parentElement?.clientWidth || tableEl.clientWidth;
    if (!total) continue;
    const content = Math.max(80, total - PAD * tds.length);
    const sumAr = ars.reduce((sum, ar) => sum + ar, 0) || tds.length;
    const widths = ars.map((ar) => Math.max(60, Math.round((content * ar) / sumAr + PAD)));
    // 列多到「每列最小 60px」都塞不进容器时按比例压缩，否则最后一列会被补成负数/超宽
    const sumW = widths.reduce((sum, w) => sum + w, 0);
    const scale = sumW > total ? total / sumW : 1;
    for (let i = 0; i < widths.length; i++) widths[i] = Math.max(1, Math.floor(widths[i] * scale));
    const sumFitted = widths.reduce((sum, w) => sum + w, 0);
    widths[widths.length - 1] += total - sumFitted; // 四舍五入误差补到最后一列

    node.forEach((rowNode: any, rowOffset: number) => {
      // 注意：forEach 第二个参数是 offset，第三个才是列索引
      rowNode.forEach((cell: any, cellOffset: number, cellIndex: number) => {
        const targetWidth = widths[cellIndex];
        if (targetWidth != null && cellIndex < widths.length) {
          const current = cell.attrs?.colwidth;
          const same =
            Array.isArray(current) && current.length === 1 && current[0] === targetWidth;
          if (!same) {
            tr = tr.setNodeMarkup(pos + 2 + rowOffset + cellOffset, undefined, {
              ...cell.attrs,
              colwidth: [targetWidth],
            });
            changed = true;
          }
        }
      });
    });
  }

  if (changed) {
    try {
      view.dispatch(tr);
    } catch {
      /* 结构正在变化（表格被删）→ 跳过 */
    }
  }
}

/**
 * 兜底：任何表格的列宽总和都不允许超过容器宽度。
 *
 * `balanceTableColumns` 只处理「每列都是单个媒体」的分栏表；一旦某列被拖空
 * （留下空段落）它就不再重算，而插列/拖列宽又可能把总和撑大，
 * 多拖几次表格就顶出编辑区右侧、出现横向滚动。这里只对真的溢出的表格
 * 按当前渲染宽度等比压缩并写回 colwidth，正常列宽和手动拖过的列宽不动。
 */
function clampTableOverflow() {
  const ed = liveEditor();
  if (!ed) return;
  const view = ed.view;

  const tables: { pos: number; node: any; el: HTMLElement }[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table') {
      const el = view.nodeDOM(pos) as HTMLElement | null;
      if (el) tables.push({ pos, node, el });
      return false;
    }
    return true;
  });
  if (!tables.length) return;

  let tr = ed.state.tr;
  let changed = false;
  for (const { pos, node, el } of tables) {
    const tableEl = (el.matches('table') ? el : el.querySelector('table')) as HTMLTableElement | null;
    if (!tableEl) continue;
    const firstRow = tableEl.querySelector('tr') as HTMLElement | null;
    if (!firstRow) continue;
    const tds = Array.from(firstRow.children) as HTMLTableCellElement[];
    if (!tds.length) continue;
    if (tds.some((td) => td.colSpan > 1)) continue; // 合并单元格不处理

    const total = tableEl.parentElement?.clientWidth || tableEl.clientWidth;
    if (!total) continue;
    const domWidths = tds.map((td) => td.getBoundingClientRect().width);
    const sum = domWidths.reduce((acc, w) => acc + w, 0);
    if (sum <= total + 1) continue; // 没溢出

    const scale = total / sum;
    const next = domWidths.map((w) => Math.max(1, Math.floor(w * scale)));
    next[next.length - 1] = Math.max(
      1,
      next[next.length - 1] + total - next.reduce((acc, w) => acc + w, 0)
    );

    node.forEach((rowNode: any, rowOffset: number) => {
      rowNode.forEach((cell: any, cellOffset: number, cellIndex: number) => {
        const width = next[cellIndex];
        if (width == null) return;
        const current = cell.attrs?.colwidth;
        if (Array.isArray(current) && current.length === 1 && current[0] === width) return;
        tr = tr.setNodeMarkup(pos + 2 + rowOffset + cellOffset, undefined, {
          ...cell.attrs,
          colwidth: [width],
        });
        changed = true;
      });
    });
  }

  if (changed) {
    try {
      view.dispatch(tr);
    } catch {
      /* 结构正在变化（表格被删）→ 跳过 */
    }
  }
}

/** 按 src 找到图片节点位置 */
function findImagePosBySrc(src: string): number {
  const ed = liveEditor();
  if (!ed) return -1;
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** 上传完成后把本地预览地址换成服务器地址 */
function replaceImageSrc(from: string, to: string) {
  const ed = liveEditor();
  if (!ed) return;
  const pos = findImagePosBySrc(from);
  if (pos < 0) return;
  const node = ed.state.doc.nodeAt(pos);
  if (!node) return;
  ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: to }));
}

function removeImageBySrc(src: string) {
  const ed = liveEditor();
  if (!ed) return;
  const pos = findImagePosBySrc(src);
  if (pos < 0) return;
  const node = ed.state.doc.nodeAt(pos);
  if (!node) return;
  ed.view.dispatch(ed.state.tr.delete(pos, pos + node.nodeSize));
}


// ─── 图片浮动工具栏（选中图片时出现在图片上方） ────────────────────────────

const toolEl = ref<HTMLElement | null>(null);
/** 浮动工具栏实际尺寸：首次渲染后测量，用于把它限制在编辑区可视范围内 */
const toolBox = ref({ w: 168, h: 34 });

async function measureToolBox() {
  await nextTick();
  const el = toolEl.value;
  if (!el) return;
  toolBox.value = { w: el.offsetWidth || 168, h: el.offsetHeight || 34 };
}

/** 编辑器滚动容器的可视矩形：浮动元素只能落在这块区域里 */
function editorViewRect(): DOMRect | null {
  return scrollEl.value?.getBoundingClientRect() ?? null;
}

/**
 * 浮动工具栏定位。
 *
 * 图片靠近编辑区顶部时，按「图片上方 42px」定位会让工具栏跑到编辑框外面
 * （盖住正文标签/工具栏，看起来像穿透了编辑界面）。这里以编辑区可视矩形
 * 为边界：上方放不下就翻到图片下方，再整体夹紧在编辑区内。
 */
const imageToolStyle = computed(() => {
  const s = selectedMedia.value;
  if (!s) return {};

  const view = editorViewRect();
  const { w: toolW, h: toolH } = toolBox.value;
  const gap = 8;
  const edge = 6;

  const viewTop = Math.max(view?.top ?? 0, 0);
  const viewBottom = Math.min(view?.bottom ?? window.innerHeight, window.innerHeight);
  const viewLeft = Math.max(view?.left ?? 0, 0);
  const viewRight = Math.min(view?.right ?? window.innerWidth, window.innerWidth);

  // 选中框有实时矩形就用它（滚动/缩放后比 selectedMedia 更准）
  const f = selFrame.value;
  const imgTop = f ? f.top : s.top;
  const imgBottom = f ? f.top + f.height : s.bottom;
  const imgCenterX = f ? f.left + f.width / 2 : s.left;

  // 图片已完全滚出编辑区 → 不显示，避免工具条飘在编辑界面之外
  if (imgBottom <= viewTop || imgTop >= viewBottom) return { display: 'none' };

  let top = imgTop - toolH - gap;
  if (top < viewTop + edge) top = imgBottom + gap; // 上方不够 → 翻到图片下方
  top = clamp(top, viewTop + edge, Math.max(viewTop + edge, viewBottom - toolH - edge));

  const half = toolW / 2;
  const left =
    viewRight - viewLeft >= toolW + edge * 2
      ? clamp(imgCenterX, viewLeft + half + edge, viewRight - half - edge)
      : (viewLeft + viewRight) / 2;

  return {
    position: 'fixed' as const,
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transform: 'translateX(-50%)',
    zIndex: 3000,
  };
});

/** 选中图片所在段落的对齐方式 */
const selectedMediaAlign = computed<'left' | 'center' | 'right'>(() => {
  const pos = selectedMedia.value?.pos;
  if (pos === undefined) return 'left';
  try {
    return ((liveEditor()?.state.doc.resolve(pos).parent.attrs.textAlign as string) || 'left') as
      | 'left'
      | 'center'
      | 'right';
  } catch {
    return 'left';
  }
});

/** 选中图片是否「单图独占一行」：只有这种情况才显示左/中/右对齐按钮。
 *  多图并排一行时对齐是段落级属性，居中/右对齐会打乱 flex 行排版，隐藏。 */
const selectedMediaSolo = computed(() => {
  const pos = selectedMedia.value?.pos;
  const ed = liveEditor();
  if (pos === undefined || !ed) return true;
  try {
    let count = 0;
    ed.state.doc.resolve(pos).parent.forEach((child) => {
      if (child.type.name === 'image') count++;
    });
    return count < 2;
  } catch {
    return true;
  }
});

/** 当前选中的是不是视频（视频不显示替换按钮，但保留左/中/右对齐） */
const selectedMediaIsVideo = computed(() => selectedMedia.value?.kind === 'video');

/** 选中视频的对齐方式：未设置按「居中」显示（缩窄后的默认观感） */
const selectedVideoAlign = computed<'left' | 'center' | 'right'>(() => {
  const pos = selectedMedia.value?.pos;
  if (pos == null) return 'center';
  const node = liveEditor()?.state.doc.nodeAt(pos);
  const a = node?.attrs?.align;
  return a === 'left' || a === 'right' ? a : 'center';
});

/** 视频是块级节点：对齐写在自己的 align 属性上（图片是段落 textAlign） */
function alignSelectedVideo(value: 'left' | 'center' | 'right') {
  const ed = liveEditor();
  const pos = selectedMedia.value?.pos;
  if (!ed || pos == null || pos < 0) return;
  const node = ed.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'video') return;
  ed.view.dispatch(
    ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: value === 'center' ? null : value })
  );
  scheduleOverlaySync();
}

function alignSelectedImage(value: 'left' | 'center' | 'right') {
  liveEditor()?.chain().focus().setTextAlign(value).run();
}

/** 删除当前选中的图片 / 视频（按节点位置删，不依赖 PM 选区） */
function deleteSelectedMedia() {
  const ed = liveEditor();
  const pos = selectedMedia.value?.pos;
  const kind = selectedMedia.value?.kind;
  if (!ed || pos == null || pos < 0 || !kind) return;
  const node = ed.state.doc.nodeAt(pos);
  if (!node || node.type.name !== kind) {
    clearMediaSelection();
    return;
  }
  // 按节点自身位置删除（图片的 mousedown 已被吞掉，selection 只是停在图片旁的光标，
  // 用 deleteSelection 会删错文本；视频的选区也不在节点上）
  const tr = ed.state.tr;
  try {
    const $pos = ed.state.doc.resolve(pos);
    const parent = $pos.parent;
    const inCell = !!selectedMediaEl?.closest('td,th');
    if (!inCell && parent.type.name === 'paragraph' && parent.content.size === node.nodeSize) {
      // 图片独占一个普通段落 → 连空段落一起删，不留空行
      const paraPos = $pos.before();
      tr.delete(paraPos, paraPos + parent.nodeSize);
    } else if (parent.childCount === 1 && (parent.type.name === 'doc' || inCell)) {
      // 视频是块级节点：删掉后容器（文档 / 单元格）不能为空 → 留一个空段落
      tr.replaceWith(pos, pos + node.nodeSize, ed.schema.nodes.paragraph.create());
    } else {
      tr.delete(pos, pos + node.nodeSize);
    }
    ed.view.dispatch(tr);
  } catch {
    /* 结构正在变化 */
  }
  clearMediaSelection();
  scheduleBalanceTables();
}

const replaceInput = ref<HTMLInputElement | null>(null);
function pickReplaceImage() {
  replaceInput.value?.click();
}

/**
 * 下载当前选中的图片 / 视频，文件名还原成上传时的原始名。
 * 还在上传中的本地预览（blob:）没有服务端文件，直接跳过。
 */
function downloadSelectedMedia() {
  const ed = liveEditor();
  const pos = selectedMedia.value?.pos;
  if (!ed || pos == null || pos < 0) return;
  const node = ed.state.doc.nodeAt(pos);
  const src = String(node?.attrs?.src || '');
  if (!node || !src || src.startsWith('blob:')) return;
  downloadMedia(src, node.attrs?.name || null);
}

/** 视频恢复原始宽度（铺满容器） */
function resetSelectedVideoWidth() {
  const ed = liveEditor();
  const pos = selectedMedia.value?.pos;
  if (!ed || pos == null || pos < 0 || selectedMedia.value?.kind !== 'video') return;
  const node = ed.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'video') return;
  ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: null }));
  scheduleOverlaySync();
}

async function onReplaceImagePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = selectedMedia.value?.pos;
  if (
    !file ||
    !file.type.startsWith('image/') ||
    target === undefined ||
    selectedMedia.value?.kind !== 'image' ||
    !editor.value
  )
    return;
  try {
    const size = await measureImageFile(file);
    const res = await uploadMedia(file, undefined, {
      name: file.name,
      width: size?.width,
      height: size?.height,
    });
    const ed = liveEditor();
    if (!ed) return;
    const node = ed.state.doc.nodeAt(target);
    if (!node || node.type.name !== 'image') return;
    ed.view.dispatch(
      ed.state.tr.setNodeMarkup(target, undefined, {
        ...node.attrs,
        src: res.url,
        // 换了图就换成新图的名字，下载时不会拿到上一张的名字
        name: res.name || file.name,
      })
    );
  } catch (err) {
    console.error('替换图片失败', err);
  }
}

// 滚动/缩放后媒体位置会变，工具栏和选中框跟着重新定位
function repositionToolbar() {
  if (!selectedMediaEl) return;
  const rect = selectedMediaEl.getBoundingClientRect();
  const cur = selectedMedia.value;
  selectedMedia.value = {
    kind: cur?.kind ?? mediaKindOf(selectedMediaEl) ?? 'image',
    pos: cur?.pos ?? -1,
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left + rect.width / 2,
  };
  positionSelection();
}
/** 窗口尺寸变化：行宽变了 → CSS 自适应重排，悬浮元素重新定位 */
function onWindowResize() {
  repositionToolbar();
  scheduleOverlaySync();
  // 容器宽度变化 → 表格列宽按当前比例缩放（保留手动拖拽后的列宽）
  scheduleFitTables();
}
onMounted(() => {
  window.addEventListener('scroll', repositionToolbar, true);
  window.addEventListener('resize', onWindowResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', repositionToolbar, true);
  window.removeEventListener('resize', onWindowResize);
});

// ─── 粘贴图片 / 视频自动上传 ───────────────────────────────────────────────
function onPaste(e: ClipboardEvent) {
  if (!editor.value) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file') {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      if (file.type.startsWith('image/')) {
        handleSingleFile(file, 'image');
      } else if (file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name)) {
        insertVideoFile(file);
      }
    }
  }
}

// ─── 拖拽图片 / 视频到编辑器指定位置上传 ───────────────────────────────────
/**
 * 核心思路：
 *   1. drop 时用 editor.view.posAtCoords({ left, top }) 把鼠标位置映射到文档坐标 pos
 *   2. 上传完成后用 setTextSelection(pos) 把光标移到该位置，再 setImage/setVideo
 *   3. 这样图片/视频就精确地插在用户拖到的位置（而不是当前光标位置）
 *
 * 注意：posAtCoords 的坐标是相对 editor view DOM 的，需要用 boundingRect 转换。
 */
function onDragEnter(e: DragEvent) {
  if (!hasFile(e)) return;
  e.preventDefault();
  dragCounter++;
  isDraggingOver.value = true;
}

function onDragOver(e: DragEvent) {
  if (!hasFile(e)) return;
  e.preventDefault(); // 必须 preventDefault，否则 drop 不触发
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e: DragEvent) {
  if (!hasFile(e)) return;
  // 只真正离开 editor-scroll 才减，子元素间 move 不算离开
  // relatedTarget 是鼠标要去的元素，如果它还在 editor-scroll 里就不算 leave
  const from = e.currentTarget as HTMLElement;
  const to = e.relatedTarget as Node | null;
  if (to && from.contains(to)) return;
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDraggingOver.value = false;
  }
}

/**
 * 兜底：任何拖拽结束都清掉高亮。
 * 场景：鼠标拖进编辑器又拖出去松开，dragleave 事件可能丢失，
 *       导致 dragCounter 永远不归零 → 遮罩卡住不消失。
 */
function onAnyDragEnd() {
  dragCounter = 0;
  isDraggingOver.value = false;
}

function onDrop(e: DragEvent) {
  const ed = liveEditor();
  if (!ed || !hasFile(e)) return;
  e.preventDefault();
  dragCounter = 0;
  isDraggingOver.value = false;

  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;

  // 关键：posAtCoords 吃的是视口坐标（clientX/clientY），
  // 不能减编辑器的 rect（减完点位会落到编辑器外面 → 解析失败，
  // 兜底 doc.content.size 把文件插到文档最底部）。
  const posResult = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });
  const insertPos = posResult?.pos ?? ed.state.doc.content.size;

  // 图片成组处理：多张一次插入同一段落 → 并排
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  const otherFiles = files.filter((f) => !f.type.startsWith('image/'));

  if (imageFiles.length) {
    if (imageFiles.length === 1) {
      handleSingleFile(imageFiles[0], 'image', insertPos);
    } else {
      uploading.value = true;
      insertImageBlock(imageFiles, insertPos).finally(() => {
        uploading.value = false;
      });
    }
  }

  // 其余文件一律按视频处理：不支持的格式由 insertVideoFile 统一弹提示
  for (const file of otherFiles) {
    handleSingleFile(file, 'video', insertPos);
  }
}

/** 判断拖拽数据里有没有文件 */
function hasFile(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types).includes('Files');
}

async function handleSingleFile(file: File, kind: 'image' | 'video', insertPos?: number) {
  if (!editor.value) return;
  uploading.value = true;
  try {
    if (kind === 'image') {
      await insertImageFile(file, insertPos);
    } else {
      // 视频交给 insertVideoFile：先占位 + 进度，再换缩略图卡片
      await insertVideoFile(file, insertPos);
    }
  } catch (err) {
    console.error(`${kind} 上传失败`, err);
  } finally {
    uploading.value = false;
  }
}

// ─── 多图行布局（飞书式：等高并排、多行自适应、顶边排布） ──────────────────
/**
 * 行排版全部由 CSS 完成（NodeView 外壳 + --w 权重变量，见 DiaryImage.ts），
 * JS 这里只负责一件事：DOM 变化后重新定位悬浮元素（选中框、工具栏）。
 *
 * 之前的做法是 JS 算好行高再往 PM 管理的 <img> 上写 flex-basis ——
 * PM 的 DOMObserver 会把这些写入当成「外部篡改文档」而无限重绘图片
 * （实测每秒 ~120 次重建 <img>，点击/拖拽全部失灵）。
 */
let rowObserver: MutationObserver | null = null;
let rowRaf = 0;

function scheduleOverlaySync() {
  if (rowRaf) return;
  rowRaf = requestAnimationFrame(() => {
    rowRaf = 0;
    syncMediaSelectedClass(); // DOM 重建后恢复 .img-selected
    positionSelection();
    repositionToolbar();
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// ─── 图片指针拖拽重排（飞书式） ─────────────────────────────────────────────
/**
 * 不用 HTML5 drag & drop（DiaryImage.draggable=false 的原因见扩展文件注释），
 * 用 pointer events 自己实现：按下图片 → 移动超过阈值进入拖拽 →
 * 悬停目标图/段落显示插入指示条 → 松手用一个 ProseMirror 事务完成移动。
 *
 * 落点规则（对齐飞书的直觉）：
 *   - 悬停在别的图片上 → 插到它前/后（并入那一行）
 *   - 落在段落（含图片行的空隙/文字段落）→ 按坐标插到该位置
 *   - 落在其他块（标题/视频/引用…）→ 在该块前后插一个新段落
 *   - 拖出编辑器 → 取消
 */
/**
 * 媒体拖拽落点（图片 / 视频共用）。
 * 编辑器内不再做「一张图并排成一行」的旧排版，统一用表格分栏承载横向排布。
 */
type DropPlan =
  | { kind: 'newPara'; pos: number; blockEl: HTMLElement | null; before: boolean }
  | {
      kind: 'columns';
      blockEl: HTMLElement;
      blockPos: number;
      blockNode: any;
      /** 源媒体放在目标块左侧（true）还是右侧（false） */
      before: boolean;
    }
  | {
      /** 已有分栏（表格）：在指定列位置插入一列 */
      kind: 'addColumn';
      /** 画拖拽蓝线用：目标单元格（或表格本身） */
      anchorEl: HTMLElement;
      tablePos: number;
      tableNode: any;
      insertIndex: number;
      colWidth: number;
      drawLeft: boolean;
    }
  | {
      /** 拖进已有单元格：把媒体放进这个格子（而不是新开一列） */
      kind: 'cell';
      cellEl: HTMLElement;
      cellPos: number;
      tablePos: number;
      tableNode: any;
      rowIndex: number;
      colIndex: number;
    };

interface MediaDragState {
  el: HTMLElement;
  startX: number;
  startY: number;
  moved: boolean;
  ghost: HTMLElement | null;
  plan: DropPlan | null;
}

let imgDrag: MediaDragState | null = null;
let dragIndicator: HTMLElement | null = null;
/** 拖拽重排进行中（隐藏选中框，避免残影） */
const isImgDragging = ref(false);
/** 刚结束一次拖拽时抑制紧随的 click（否则松手那一下会触发图片选中） */
let suppressClickUntil = 0;

/**
 * 指针是否落在表格列宽拖拽热区上。
 *
 * prosemirror-tables 的列宽手柄本身是 `pointer-events: none` 的装饰 div，
 * 它靠 mousemove 判定「指针离单元格左右边缘 ≤ handleWidth」来决定谁是可拖的列。
 * 而单元格里的图片是铺满整格的，于是「按在线上」时 pointerdown 的真实目标是图片，
 * 图片拖拽逻辑会把这一下当成拖图 → 图被拖进别的格子，表格结构被改写。
 * 这里用同样的几何判定把这一段让给列宽手柄，媒体拖拽只从图片中部开始。
 */
function isColumnResizeHotspot(e: {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('.column-resize-handle')) return true;
  const cell = target.closest('td,th') as HTMLElement | null;
  if (!cell) return false;
  const row = cell.parentElement as HTMLElement | null;
  if (!row) return false;
  const colCount = row.children.length;
  const colIndex = Array.prototype.indexOf.call(row.children, cell) as number;
  // 单列表格：左右都是表格外边界，本来就没有可拖的列线 → 整格让给媒体拖拽
  if (colCount <= 1) return false;

  const r = cell.getBoundingClientRect();
  // prosemirror-tables 的 handleWidth = 8（见 TableKit 配置），多留 2px 容错
  const EDGE = 10;
  // 左侧只有「非第一列」才是两列交界（第一列左边是表格外边界，没有手柄）
  if (colIndex > 0 && e.clientX - r.left <= EDGE) return true;
  // 最后一列不可拖（lastColumnResizable: false），右边缘不是热区
  if (colIndex < colCount - 1 && r.right - e.clientX <= EDGE) return true;
  return false;
}

/**
 * 清掉列宽拖拽状态。
 *
 * 媒体拖拽一旦开始，就绝不能让 prosemirror-tables 同时在拖列宽：
 * 松手时媒体先改写文档结构，列宽插件的 activeHandle 随之失效，
 * 它的 finish() 会用失效位置算列宽而抛错，`dragging` 便永久停在 true
 * （表现：拖过一次表格线之后，列宽再也拖不动，撤销也不会恢复）。
 * setHandle 同时把 activeHandle 复位，避免 mousedown 再启动一次列宽拖拽。
 */
function cancelColumnResize(view: any) {
  const st = columnResizingPluginKey.getState(view.state);
  if (st && (st.dragging || st.activeHandle > -1)) {
    view.dispatch(
      view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null, setHandle: -1 })
    );
  }
}

/**
 * 列宽拖拽状态自愈。
 * 正常拖拽结束时 prosemirror-tables 会自己清掉 dragging；若拖拽中途发生过
 * 结构变更导致它的 finish() 抛错，dragging 就会永久停在 true（列宽再也拖不动）。
 * 这里直接把 dragging 复位，让列宽手柄恢复可用。
 */
function resetStuckColumnResize() {
  const ed = liveEditor();
  if (!ed) return;
  const st = columnResizingPluginKey.getState(ed.state);
  if (st?.dragging) {
    ed.view.dispatch(
      ed.state.tr.setMeta(columnResizingPluginKey, { setDragging: null, setHandle: -1 })
    );
  }
}

/** 指针松开后检查一次：放到下一次事件循环，让 prosemirror-tables 自己的 mouseup(finish) 先跑 */
function healStuckColumnResize() {
  setTimeout(() => {
    resetStuckColumnResize();
    // 列宽拖拽只改一列，松手后表格可能比容器宽（横向溢出）→ 收回容器宽
    clampTableOverflow();
  }, 0);
}

/**
 * 列宽热区里按下媒体后的「待定」状态。
 *
 * 单元格里的图片铺满整格，按在两列交界上时无法从按下的位置区分意图：
 *   - 沿表格线拖动 → 调整列宽（mousedown 已被 prosemirror-tables 接管）
 *   - 拖离表格 → 把图片拖出去
 * 所以先不启动媒体拖拽，等指针真正离开表格矩形时再接管，避免「只见蓝线、图不动」。
 */
let pendingMediaDrag: {
  el: HTMLElement;
  startX: number;
  startY: number;
  tableEl: HTMLElement | null;
} | null = null;
let pendingMediaMove: ((e: PointerEvent) => void) | null = null;

function clearPendingMediaDrag() {
  pendingMediaDrag = null;
  if (pendingMediaMove) {
    document.removeEventListener('pointermove', pendingMediaMove);
    pendingMediaMove = null;
  }
  document.removeEventListener('pointerup', onPendingMediaUp);
  document.removeEventListener('pointercancel', onPendingMediaUp);
}

function onPendingMediaUp() {
  clearPendingMediaDrag();
}

function armPendingMediaDrag(el: HTMLElement, e: PointerEvent) {
  clearPendingMediaDrag();
  pendingMediaDrag = {
    el,
    startX: e.clientX,
    startY: e.clientY,
    tableEl: el.closest('table') as HTMLElement | null,
  };
  pendingMediaMove = (ev: PointerEvent) => {
    const p = pendingMediaDrag;
    if (!p) return;
    const dx = ev.clientX - p.startX;
    const dy = ev.clientY - p.startY;
    if (Math.hypot(dx, dy) < 6) return;
    const tr = p.tableEl?.getBoundingClientRect();
    if (tr) {
      const outside =
        ev.clientX < tr.left - 2 ||
        ev.clientX > tr.right + 2 ||
        ev.clientY < tr.top - 2 ||
        ev.clientY > tr.bottom + 2;
      if (!outside) return; // 还在表格里 → 让列宽拖拽继续
    }
    // 指针已拖离表格 → 意图是拖出媒体：取消列宽拖拽，接管为媒体拖拽
    const ed = liveEditor();
    if (ed) cancelColumnResize(ed.view);
    imgDrag = {
      el: p.el,
      startX: p.startX,
      startY: p.startY,
      moved: true,
      ghost: null,
      plan: null,
    };
    clearPendingMediaDrag();
    document.addEventListener('pointermove', onImgDragMove);
    document.addEventListener('pointerup', onImgDragUp);
    document.addEventListener('pointercancel', onImgDragCancel);
    startImgDragGhost(ev);
    onImgDragMove(ev);
  };
  document.addEventListener('pointermove', pendingMediaMove);
  document.addEventListener('pointerup', onPendingMediaUp);
  document.addEventListener('pointercancel', onPendingMediaUp);
}

function onBodyPointerDown(e: PointerEvent) {
  if (e.button !== 0 || imgDrag || handleDragState) return;
  // 上一次拖拽若把列宽插件留在了 dragging 状态，先复位（否则这一下 mousedown 会被它吞掉）
  resetStuckColumnResize();
  const media = mediaElementAt(e.target);
  // 表格列宽热区：先交给 prosemirror-tables；若拖着媒体离开表格再切回媒体拖拽
  if (isColumnResizeHotspot(e)) {
    if (media) armPendingMediaDrag(media, e);
    return;
  }
  if (!media) return;

  // 媒体拖拽优先：按下的既然是图片/视频，就先收起列宽手柄的状态
  const ed = liveEditor();
  if (ed) cancelColumnResize(ed.view);

  imgDrag = {
    el: media,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    ghost: null,
    plan: null,
  };
  document.addEventListener('pointermove', onImgDragMove);
  document.addEventListener('pointerup', onImgDragUp);
  document.addEventListener('pointercancel', onImgDragCancel);
}

function onImgDragMove(e: PointerEvent) {
  if (!imgDrag) return;
  const dx = e.clientX - imgDrag.startX;
  const dy = e.clientY - imgDrag.startY;
  if (!imgDrag.moved) {
    if (Math.hypot(dx, dy) < 6) return; // 阈值内当作点击（选中），不进入拖拽
    startImgDragGhost(e);
  }
  e.preventDefault();
  if (imgDrag.ghost) {
    imgDrag.ghost.style.left = `${e.clientX}px`;
    imgDrag.ghost.style.top = `${e.clientY}px`;
  }
  imgDrag.plan = computeDropPlan(e.clientX, e.clientY);
  renderDropIndicator(imgDrag.plan);
}

function startImgDragGhost(e: PointerEvent) {
  if (!imgDrag) return;
  imgDrag.moved = true;
  clearMediaSelection(); // 拖拽中不显示选中工具栏/选中框
  // 再兜一次：若列宽拖拽已经启动，立刻取消。媒体与列宽不能同时进行，
  // 否则松手时媒体先改写结构，列宽插件的 finish() 会因失效位置抛错而卡死。
  const ed = liveEditor();
  if (ed) cancelColumnResize(ed.view);
  // 拖图开始时把 PM 的选区收成图片旁的光标：之前的文字框选（若还在）
  // 会跟着 DOM 重建被映射到新位置，看上去就像「图片被文字框选住了」。
  if (ed && imgDrag.el instanceof HTMLImageElement) {
    try {
      const pos = imgNodePos(ed.view, imgDrag.el);
      const sel = TextSelection.create(ed.state.doc, pos);
      if (!ed.state.selection.eq(sel)) {
        ed.view.dispatch(ed.state.tr.setSelection(sel));
      }
    } catch {
      /* 结构正在变化 */
    }
  }
  const rect = imgDrag.el.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'img-drag-ghost';
  // 图片 / 视频卡片都克隆一份作为跟随预览，避免浏览器自带的「复制一张缩略图」体验
  const inner = imgDrag.el.cloneNode(true) as HTMLElement;
  inner.style.width = `${rect.width}px`;
  inner.style.height = `${rect.height}px`;
  if (inner instanceof HTMLImageElement) inner.style.flexBasis = '';
  ghost.appendChild(inner);
  document.body.appendChild(ghost);
  imgDrag.ghost = ghost;
  imgDrag.el.classList.add('img-dragging');
  isImgDragging.value = true;
  document.body.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;
}

/** 媒体节点在文档中的位置（图片走 NodeView 外壳；视频是块级节点，posAtDOM 即节点起始位） */
function mediaNodePos(ed: Editor, el: HTMLElement): number {
  if (el instanceof HTMLImageElement) return imgNodePos(ed.view, el);
  const domPos = ed.view.posAtDOM(el, 0);
  const { doc } = ed.state;
  // 视频是 atom 节点：posAtDOM 在块边界返回的正是「节点前」的位置
  if (doc.nodeAt(domPos)?.type.name === 'video') return domPos;
  // 视图状态有偏移时按前后邻居兜底（避免落到单元格/文档开头，删错节点）
  const $p = doc.resolve(domPos);
  if ($p.nodeAfter?.type.name === 'video') return domPos;
  if ($p.nodeBefore?.type.name === 'video') return domPos - $p.nodeBefore.nodeSize;
  return $p.depth === 0 ? domPos : $p.before();
}

/** 顶层块元素 → 文档节点位置 */
function topNodePosAt(ed: Editor, blockEl: HTMLElement): number {
  const domPos = ed.view.posAtDOM(blockEl, 0);
  const $p = ed.state.doc.resolve(domPos);
  return $p.depth === 0 ? domPos : $p.before();
}

/** 指针落在表格内 → 在对应列位置插入一列（蓝线画在单元格边界，不画到表格外） */
/** 单元格 DOM → 文档里 tableCell 节点的起始位置 */
function cellDocPos(ed: Editor, cellEl: HTMLElement): number {
  try {
    const domPos = ed.view.posAtDOM(cellEl, 0);
    const $p = ed.state.doc.resolve(domPos);
    let depth = $p.depth;
    while (depth > 0) {
      const node = $p.node(depth);
      if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
        return $p.before(depth);
      }
      depth--;
    }
  } catch {
    /* 结构变化中 */
  }
  return -1;
}

function tableDropPlanAt(
  x: number,
  y: number,
  blockEl: HTMLElement,
  ed: Editor
): DropPlan | null {
  const tableEl = (blockEl.matches('table') ? blockEl : blockEl.querySelector('table')) as HTMLElement | null;
  if (!tableEl) return null;
  const tr = tableEl.getBoundingClientRect();
  if (y < tr.top - 2 || y > tr.bottom + 2) return null;
  // 只有表格最上/下 8px 留给「表格前后新建段落」；其余内部区域都应能拖进格子
  const band = Math.min(8, tr.height * 0.08);
  if (y < tr.top + band || y > tr.bottom - band) return null;

  let tablePos = -1;
  try {
    tablePos = topNodePosAt(ed, tableEl);
  } catch {
    return null;
  }
  const tableNode = ed.state.doc.nodeAt(tablePos);
  if (!tableNode || tableNode.type.name !== 'table') return null;
  const cols = tableNode.firstChild?.childCount || 1;

  // 指针在某个单元格里 → 在该单元格左/右插入一列
  const hits = document.elementsFromPoint(x, y) as HTMLElement[];
  let cellEl: HTMLElement | null = null;
  for (const hit of hits) {
    if (!tableEl.contains(hit)) continue;
    const cell = hit.closest('td,th') as HTMLElement | null;
    if (cell && tableEl.contains(cell)) {
      cellEl = cell;
      break;
    }
  }

  if (cellEl) {
    const rowEl = cellEl.parentElement as HTMLElement;
    const colIndex = Array.from(rowEl.children).indexOf(cellEl);
    const rowEl2 = cellEl.closest('tr') as HTMLElement | null;
    const rowIndex = rowEl2?.parentElement
      ? Array.from(rowEl2.parentElement.children).indexOf(rowEl2)
      : 0;
    const cr = cellEl.getBoundingClientRect();
    // 单元格左右边缘 → 插一列；中间 → 把媒体放进这个格子
    const edge = Math.min(16, Math.max(10, cr.width * 0.12));
    const drawLeft = x < cr.left + edge;
    const drawRight = x > cr.right - edge;
    if (drawLeft || drawRight) {
      return {
        kind: 'addColumn',
        anchorEl: cellEl,
        tablePos,
        tableNode,
        insertIndex: clamp(drawLeft ? colIndex : colIndex + 1, 0, cols),
        colWidth: Math.max(60, Math.round(cr.width)),
        drawLeft,
      };
    }

    const cellPos = cellDocPos(ed, cellEl);
    if (cellPos < 0) return null;
    return {
      kind: 'cell',
      cellEl,
      cellPos,
      tablePos,
      tableNode,
      rowIndex,
      colIndex,
    };
  }

  // 表格左右外侧 → 最左/最右加列
  const edge = Math.min(48, Math.max(24, tr.width * 0.1));
  const drawLeft = x <= tr.left + edge;
  const drawRight = x >= tr.right - edge;
  if (drawLeft || drawRight) {
    return {
      kind: 'addColumn',
      anchorEl: tableEl,
      tablePos,
      tableNode,
      insertIndex: drawLeft ? 0 : cols,
      colWidth: Math.max(60, Math.round(tr.width / (cols + 1))),
      drawLeft,
    };
  }
  return null;
}

/**
 * 悬停点 → 落点方案。
 *
 * 编辑器内所有横向排布都走表格分栏（不再做「同段落多图 flex 并排」）：
 *   - 拖到普通块（文字段落 / 图片 / 视频）内部 → 源媒体与目标块组成两列
 *   - 拖到表格单元格里 → 在该列左/右插入一列（蓝线画在单元格边界）
 *   - 拖到块的上下边缘 → 在该块前后新建段落
 *   - 拖出编辑器 → 取消
 */
function computeDropPlan(x: number, y: number): DropPlan | null {
  const ed = liveEditor();
  const drag = imgDrag;
  if (!ed || !drag) return null;
  const body = ed.view.dom as HTMLElement;
  const bodyRect = body.getBoundingClientRect();

  if (x < bodyRect.left - 40 || x > bodyRect.right + 40 || y > bodyRect.bottom + 80) return null;

  let srcPos = -1;
  try {
    srcPos = mediaNodePos(ed, drag.el);
  } catch {
    return null;
  }
  if (srcPos < 0) return null;

  const blocks = Array.from(body.children) as HTMLElement[];
  if (!blocks.length) return null;

  // 源媒体是否在表格单元格里（用于限制「同表格内的目标」）
  let srcCellEl: HTMLElement | null = null;
  let srcTablePos = -1;
  let srcColIndex = -1;
  const srcCellCandidate = drag.el.closest('td,th') as HTMLElement | null;
  if (srcCellCandidate) {
    srcCellEl = srcCellCandidate;
    const srcTableEl = srcCellCandidate.closest('table');
    if (srcTableEl) {
      try {
        srcTablePos = topNodePosAt(ed, srcTableEl);
      } catch {
        srcTablePos = -1;
      }
      srcColIndex = Array.from((srcCellCandidate.parentElement as HTMLElement).children).indexOf(
        srcCellCandidate
      );
    }
  }

  const topNodes: { node: any; pos: number }[] = [];
  let acc = 0;
  ed.state.doc.content.forEach((child: any) => {
    topNodes.push({ node: child, pos: acc });
    acc += child.nodeSize;
  });

  const firstTop = blocks[0].getBoundingClientRect().top;
  const lastBottom = blocks[blocks.length - 1].getBoundingClientRect().bottom;
  if (y < firstTop - 4) {
    return { kind: 'newPara', pos: 0, blockEl: blocks[0], before: true };
  }
  if (y > lastBottom + 4) {
    return {
      kind: 'newPara',
      pos: ed.state.doc.content.size,
      blockEl: blocks[blocks.length - 1],
      before: false,
    };
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const r = b.getBoundingClientRect();
    if (y < r.top - 4 || y > r.bottom + 4) continue;

    const tn = topNodes[bi];
    if (!tn) return null;

    // 表格目标（含源所在表格）：先判断「放进格子 / 插列」
    const plan = tableDropPlanAt(x, y, b, ed);
    if (plan) {
      if (plan.kind === 'cell' && srcTablePos >= 0 && plan.tablePos === srcTablePos) {
        // 同表格内：拖到同一格/同一列 → 不动。
        // addColumn 不在此拦截：同一个表格里把图拖到列间新增一列是合法操作，
        // applyDropPlan 会先删源图、再基于删除后的表格插入新列。
        if (plan.cellEl === srcCellEl || plan.colIndex === srcColIndex) return null;
      }
      return plan;
    }

    // 表格上下边缘 → 在表格前后新建段落（源在表格里时等于把媒体拖出去）
    if (tn.node.type.name === 'table') {
      const band = Math.min(10, r.height * 0.1);
      if (y < r.top + band || y > r.bottom - band) {
        const before = y < r.top + r.height / 2;
        return {
          kind: 'newPara',
          pos: clamp(before ? tn.pos : tn.pos + tn.node.nodeSize, 0, ed.state.doc.content.size),
          blockEl: b,
          before,
        };
      }
      return null; // 表格内部但没命中单元格/边缘 → 不动
    }

    // 悬停源媒体自己所在的块 → 不动
    if (b === drag.el || b.contains(drag.el)) return null;

    // 目标块是空段落（空白行）→ 媒体直接落成独立块。
    // 不能走下面的「组成两列」，否则空行会被塞进单元格，
    // 从表格里拖出来的图看起来仍然待在表格里（还会多出一个空格子）。
    if (tn.node.type.name === 'paragraph' && tn.node.content.size === 0) {
      return { kind: 'newPara', pos: tn.pos, blockEl: b, before: true };
    }

    // 块上下边缘：建新段落
    const band = Math.min(26, r.height * 0.22);
    if (y < r.top + band || y > r.bottom - band) {
      const before = y < r.top + r.height / 2;
      return {
        kind: 'newPara',
        pos: clamp(before ? tn.pos : tn.pos + tn.node.nodeSize, 0, ed.state.doc.content.size),
        blockEl: b,
        before,
      };
    }

    // 块内部 ⇒ 与源媒体组成两列
    return {
      kind: 'columns',
      blockEl: b,
      blockPos: tn.pos,
      blockNode: tn.node,
      before: x < r.left + r.width / 2,
    };
  }

  // 落在两个块之间的空隙（块间距 / margin 区）→ 插到两块的边界（上块之后 = 下块之前）。
  // 没有这个兜底时，从表格里把图拖到表格外的空白处会因为「没命中任何块」而没有落点，
  // 指示线消失、松手也不生效，表现就是拖不出来。
  for (let bi = 0; bi < blocks.length - 1; bi++) {
    const cur = blocks[bi].getBoundingClientRect();
    const next = blocks[bi + 1].getBoundingClientRect();
    if (y > cur.bottom && y < next.top) {
      const tn = topNodes[bi + 1];
      if (!tn) continue;
      const before = y < (cur.bottom + next.top) / 2;
      return {
        kind: 'newPara',
        pos: tn.pos,
        blockEl: before ? blocks[bi + 1] : blocks[bi],
        before,
      };
    }
  }

  return null;
}

function renderDropIndicator(plan: DropPlan | null) {
  const ed = liveEditor();
  if (!ed) return;
  ed.view.dom.querySelectorAll('img.drop-hi').forEach((el) => el.classList.remove('drop-hi'));
  if (!plan) {
    removeDragIndicator();
    return;
  }
  let ind = dragIndicator;
  if (!ind) {
    ind = document.createElement('div');
    ind.className = 'img-drop-indicator';
    document.body.appendChild(ind);
    dragIndicator = ind;
  }
  // 每次先回到「细蓝线」形态；拖进单元格时再切成高亮框
  ind.style.background = '#3370ff';
  ind.style.border = 'none';
  ind.style.borderRadius = '2px';
  ind.style.boxSizing = 'border-box';

  // 指示条也是 fixed 浮层：夹到编辑区可视范围内，避免蓝线画到编辑框外
  const view = editorViewRect();
  const viewTop = Math.max(view?.top ?? 0, 0);
  const viewBottom = Math.min(view?.bottom ?? window.innerHeight, window.innerHeight);
  const viewLeft = Math.max(view?.left ?? 0, 0);
  const viewRight = Math.min(view?.right ?? window.innerWidth, window.innerWidth);

  if (plan.kind === 'newPara') {
    const r = plan.blockEl?.getBoundingClientRect();
    if (!r) {
      removeDragIndicator();
      return;
    }
    const left = clamp(r.left, viewLeft, viewRight);
    const width = clamp(r.left + r.width, viewLeft, viewRight) - left;
    if (width <= 0) {
      removeDragIndicator();
      return;
    }
    ind.style.left = `${left}px`;
    ind.style.top = `${clamp((plan.before ? r.top : r.bottom) - 2, viewTop, viewBottom - 4)}px`;
    ind.style.width = `${width}px`;
    ind.style.height = '4px';
  } else if (plan.kind === 'columns') {
    // 与普通块组成两列：在目标块的左/右边缘画竖线
    const r = plan.blockEl.getBoundingClientRect();
    const top = clamp(r.top, viewTop, viewBottom);
    const height = clamp(r.bottom, viewTop, viewBottom) - top;
    if (height <= 0) {
      removeDragIndicator();
      return;
    }
    ind.style.left = `${clamp((plan.before ? r.left : r.right) - 2, viewLeft, viewRight - 4)}px`;
    ind.style.top = `${top}px`;
    ind.style.width = '4px';
    ind.style.height = `${height}px`;
  } else if (plan.kind === 'cell') {
    // 放进单元格：用高亮框标出整格
    const r = plan.cellEl.getBoundingClientRect();
    const left = clamp(r.left + 2, viewLeft, viewRight);
    const top = clamp(r.top + 2, viewTop, viewBottom);
    const width = Math.max(0, Math.min(r.right - 2, viewRight) - left);
    const height = Math.max(0, Math.min(r.bottom - 2, viewBottom) - top);
    if (width <= 0 || height <= 0) {
      removeDragIndicator();
      return;
    }
    ind.style.left = `${left}px`;
    ind.style.top = `${top}px`;
    ind.style.width = `${width}px`;
    ind.style.height = `${height}px`;
    ind.style.background = 'rgba(51, 112, 255, 0.08)';
    ind.style.border = '2px solid #3370ff';
    ind.style.borderRadius = '8px';
  } else {
    // 表格内插列：蓝线严格画在目标单元格（或表格）的左/右边界上
    const r = plan.anchorEl.getBoundingClientRect();
    const top = clamp(r.top, viewTop, viewBottom);
    const height = clamp(r.bottom, viewTop, viewBottom) - top;
    if (height <= 0) {
      removeDragIndicator();
      return;
    }
    ind.style.left = `${clamp((plan.drawLeft ? r.left : r.right) - 2, viewLeft, viewRight - 4)}px`;
    ind.style.top = `${top}px`;
    ind.style.width = '4px';
    ind.style.height = `${height}px`;
  }
}

function removeDragIndicator() {
  dragIndicator?.remove();
  dragIndicator = null;
}

function onImgDragUp(e: PointerEvent) {
  const drag = imgDrag;
  cleanupImgDragListeners();
  if (!drag) return;
  const plan = drag.plan;
  cleanupImgDragVisual(drag);
  imgDrag = null;
  if (drag.moved) {
    suppressClickUntil = Date.now() + 200;
    if (plan) {
      try {
        applyDropPlan(drag.el, plan);
      } catch (err) {
        // 拖拽未生效时不要把异常抛成 uncaught（会打断后续交互），
        // 但必须留下可诊断的信息
        console.error('[diary-drop] 应用拖拽落点失败', plan.kind, err);
      }
    }
  }
}

function onImgDragCancel() {
  const drag = imgDrag;
  cleanupImgDragListeners();
  if (!drag) return;
  cleanupImgDragVisual(drag);
  imgDrag = null;
  if (drag.moved) suppressClickUntil = Date.now() + 200;
}

function cleanupImgDragListeners() {
  document.removeEventListener('pointermove', onImgDragMove);
  document.removeEventListener('pointerup', onImgDragUp);
  document.removeEventListener('pointercancel', onImgDragCancel);
}

function cleanupImgDragVisual(drag: MediaDragState) {
  drag.ghost?.remove();
  drag.el.classList.remove('img-dragging');
  isImgDragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  removeDragIndicator();
  liveEditor()?.view.dom.querySelectorAll('.drop-hi').forEach((el) => el.classList.remove('drop-hi'));
}

/** 单元格是否已经空了（没有内容，或只剩一个空段落） */
function isCellEmpty(cell: any): boolean {
  if (!cell || cell.childCount === 0) return true;
  if (cell.childCount !== 1) return false;
  const child = cell.firstChild;
  return child.type.name === 'paragraph' && child.content.size === 0;
}

/** 光标位置是否在表格单元格内部 */
function isPosInsideCell($pos: any): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return true;
  }
  return false;
}

/**
 * 光标与图片相邻时的删除（按删除文字的逻辑）：
 *   dir = -1（Backspace）：光标紧跟在图片后面 → 删掉这张图；
 *   dir = +1（Delete）：光标紧贴在图片前面 → 删掉这张图。
 * 图片独占一个普通段落（且不在分栏里）时连空段落一起删，不留空行；
 * 分栏单元格里的图片只删图，保留空段落（单元格必须有段落才合法）。
 * 返回 true 表示已处理。
 */
function deleteAdjacentImage(view: any, dir: -1 | 1): boolean {
  const { state } = view;
  const sel = state.selection;
  if (!sel.empty) return false;
  const $pos = dir < 0 ? sel.$from : sel.$to;
  const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
  if (!node || node.type.name !== 'image') return false;

  const tr = state.tr;
  const parent = $pos.parent;
  if (
    dir < 0 &&
    parent.type.name === 'paragraph' &&
    parent.content.size === node.nodeSize &&
    !isPosInsideCell($pos)
  ) {
    const ps = $pos.before();
    tr.delete(ps, ps + parent.nodeSize);
  } else {
    const from = dir < 0 ? $pos.pos - node.nodeSize : $pos.pos;
    const to = dir < 0 ? $pos.pos : $pos.pos + node.nodeSize;
    tr.delete(from, to);
  }
  view.dispatch(tr);
  scheduleBalanceTables();
  return true;
}

/**
 * 表格里删空一列后，光标停在该列第一行的空单元格，继续按删除键：
 * 默认不会再有任何反应。这里改为「删掉当前列」（不限于第一列，
 * 例如左边第一列还有图、右边第二列已被删空时，光标在第二列也能删）。
 *
 * 只处理「表格第一行的空单元格 + 整列都空」，避免误删还有图片/文字的列；
 * 单列表格 deleteColumn 会拒绝，此时删列等于删表，直接移除空表格。
 */
function deleteEmptyColumnAtTopRow(view: any): boolean {
  const { state } = view;
  const sel = state.selection;
  if (!sel.empty) return false;

  const $cell = cellAround(sel.$from);
  if (!$cell) return false; // 不在表格里
  // 光标所在列必须在表格第一行（否则向下删内容时会被误删列）
  if ($cell.index(-1) !== 0) return false;

  const colIndex = $cell.index();
  const cell = $cell.nodeAfter;
  if (!cell || !isCellEmpty(cell)) return false;
  const table = $cell.node(-1);
  if (!table || table.type.name !== 'table') return false;

  // 整列都空才删，避免删掉还有内容的列
  let columnEmpty = true;
  table.forEach((row: any) => {
    const colCell = row.child(Math.min(colIndex, row.childCount - 1));
    if (!isCellEmpty(colCell)) columnEmpty = false;
  });
  if (!columnEmpty) return false;

  if (deleteColumn(state, view.dispatch)) return true;
  // 只有一列：删列即删表（空表格直接移除）
  return deleteTable(state, view.dispatch);
}

/**
 * 媒体被拖走 / 拖出分栏后清理源表格：
 *   - 该列变空 → 删掉这一列；
 *   - 表格只剩一列 → 分栏没有意义，还原成普通块（图片段落 / 视频块）；
 *   - 整个表格都空了 → 删表格，补一个空段落。
 */
function cleanupSourceTable(
  tr: any,
  info: { pos: number; colIndex: number } | null
): void {
  if (!info) return;
  // assoc=-1：表格本身可能刚被整体替换过（同表格插列），要落在新表格的开头
  const pos = clamp(tr.mapping.map(info.pos, -1), 0, tr.doc.content.size);
  const table = tr.doc.nodeAt(pos);
  if (!table || table.type.name !== 'table') return;
  const schema = tr.doc.type.schema;

  let allEmpty = true;
  table.forEach((row: any) =>
    row.forEach((cell: any) => {
      if (!isCellEmpty(cell)) allEmpty = false;
    })
  );
  if (allEmpty) {
    tr.replaceWith(pos, pos + table.nodeSize, schema.nodes.paragraph.create());
    return;
  }

  const cols = table.firstChild?.childCount || 0;
  if (cols <= 0) return;
  const colIndex = clamp(info.colIndex, 0, cols - 1);

  let colEmpty = true;
  table.forEach((row: any) => {
    const cell = row.child(Math.min(colIndex, row.childCount - 1));
    if (!cell || !isCellEmpty(cell)) colEmpty = false;
  });
  if (!colEmpty) return;

  if (cols <= 1) {
    // 只剩一列：把该列里的块还原到文档（分栏消失）
    const blocks: any[] = [];
    table.forEach((row: any) => row.forEach((cell: any) => cell.forEach((child: any) => blocks.push(child))));
    const meaningful = blocks.filter(
      (b: any) => !(b.type.name === 'paragraph' && b.content.size === 0)
    );
    const content = meaningful.length ? meaningful : [schema.nodes.paragraph.create()];
    tr.replaceWith(pos, pos + table.nodeSize, content);
    return;
  }

  // 删掉空列后只剩一列 → 分栏没有意义，还原为普通块
  if (cols - 1 <= 1) {
    const keepIndex = colIndex === 0 ? 1 : 0;
    const blocks: any[] = [];
    table.forEach((row: any) => {
      const keep = row.child(Math.min(keepIndex, row.childCount - 1));
      if (keep) keep.forEach((child: any) => blocks.push(child));
    });
    const meaningful = blocks.filter(
      (b: any) => !(b.type.name === 'paragraph' && b.content.size === 0)
    );
    const content = meaningful.length ? meaningful : [schema.nodes.paragraph.create()];
    tr.replaceWith(pos, pos + table.nodeSize, content);
    return;
  }

  // 还有多列：只删掉变空的那一列
  const rows: any[] = [];
  table.forEach((row: any) => {
    const cells: any[] = [];
    row.forEach((cell: any, _offset: number, index: number) => {
      if (index !== colIndex) cells.push(cell);
    });
    rows.push(schema.nodes.tableRow.create(row.attrs, cells));
  });
  tr.replaceWith(pos, pos + table.nodeSize, schema.nodes.table.create(table.attrs, rows));
}

/** 松手：一个事务完成「插入新位置 + 删除原位置（含搬空的段落）」，单次撤销可回退 */
function applyDropPlan(srcEl: HTMLElement, plan: DropPlan) {
  const ed = liveEditor();
  if (!ed) return;
  const view = ed.view;

  let srcPos: number;
  try {
    srcPos = mediaNodePos(ed, srcEl);
  } catch {
    return;
  }
  const srcNode = ed.state.doc.nodeAt(srcPos);
  if (!srcNode || (srcNode.type.name !== 'image' && srcNode.type.name !== 'video')) return;

  const schema = ed.state.schema;
  const isImage = srcNode.type.name === 'image';
  const $src = ed.state.doc.resolve(srcPos);
  const srcPara = isImage ? $src.parent : null;
  const srcParaPos = isImage ? $src.before() : -1;

  // 源媒体是否在表格里：拖出格子后要清理空列 / 空分栏
  let srcTableInfo: { pos: number; colIndex: number } | null = null;
  const srcCellEl = srcEl.closest('td,th') as HTMLElement | null;
  if (srcCellEl) {
    const srcTableEl = srcCellEl.closest('table');
    if (srcTableEl) {
      try {
        const tPos = topNodePosAt(ed, srcTableEl);
        if (ed.state.doc.nodeAt(tPos)?.type.name === 'table') {
          srcTableInfo = {
            pos: tPos,
            colIndex: Array.from((srcCellEl.parentElement as HTMLElement).children).indexOf(
              srcCellEl
            ),
          };
        }
      } catch {
        /* 结构变化中 → 不做清理 */
      }
    }
  }

  /** 单元格里的内容：图片要包一层段落，视频本身就是 block。
   *  进入表格后清掉旧的 width/flex —— 列宽由表格统一控制，图片默认铺满整列才能等高。 */
  const cellContent = (node: any) => {
    if (node.type.name === 'image') {
      const attrs = { ...node.attrs, width: null, flex: null };
      return schema.nodes.paragraph.create(null, [schema.nodes.image.create(attrs)]);
    }
    return node;
  };

  /** 删除源媒体（普通段落独占时整段删；表格单元格里必须保留空段落，否则 cell 无效） */
  const deleteSource = (tr: any) => {
    const inCell = !!srcCellEl;
    if (!isImage) {
      const parent = $src.parent;
      if (inCell && parent.type.name === 'tableCell' && parent.childCount === 1) {
        tr.replaceWith(srcPos, srcPos + srcNode.nodeSize, schema.nodes.paragraph.create());
      } else {
        tr.delete(srcPos, srcPos + srcNode.nodeSize);
      }
      return;
    }
    if (
      srcPara &&
      srcPara.type.name === 'paragraph' &&
      srcPara.content.size === srcNode.nodeSize
    ) {
      if (inCell) {
        tr.delete(srcPos, srcPos + srcNode.nodeSize); // 保留空段落
      } else {
        tr.delete(srcParaPos, srcParaPos + srcPara.nodeSize); // 普通图片段落：整段删
      }
    } else {
      tr.delete(srcPos, srcPos + srcNode.nodeSize);
    }
  };

  // ─── 与目标块组成分栏（目标若是纯图片段落，按每张图一列拆开） ──────────
  if (plan.kind === 'columns') {
    const totalWidth = Math.max(120, Math.round(plan.blockEl.getBoundingClientRect().width));

    // 目标块是否「纯图片段落」：是的话每张图各占一列，2 张以上也能继续成网格
    const targetImgs: any[] = [];
    let mediaOnly = false;
    if (plan.blockNode.type.name === 'paragraph') {
      let onlyMedia = true;
      plan.blockNode.forEach((child: any) => {
        if (child.type.name === 'image') targetImgs.push(child);
        else if (child.isText && !String(child.text || '').trim()) {
          /* 纯空白文本忽略 */
        } else if (child.type.name === 'hardBreak') {
          /* 换行忽略 */
        } else {
          onlyMedia = false;
        }
      });
      mediaOnly = targetImgs.length > 0 && onlyMedia;
    }
    const targetNodes: any[] = mediaOnly ? targetImgs : [plan.blockNode];

    // 列宽按媒体原始宽高比分配 → 同一行等高（视频固定 16:9）
    const targetEls = Array.from(
      plan.blockEl.querySelectorAll<HTMLElement>('img.diary-inline-image, .diary-video')
    );
    const arOf = (el: HTMLElement | null): number => {
      if (el instanceof HTMLImageElement && el.naturalWidth && el.naturalHeight) {
        return el.naturalWidth / el.naturalHeight;
      }
      return 16 / 9;
    };
    const targetArs = targetNodes.map((node, i) => {
      if (mediaOnly) return arOf(targetEls[i] ?? null);
      return node.type.name === 'video' ? 16 / 9 : 1;
    });
    const srcAr =
      srcEl instanceof HTMLImageElement && srcEl.naturalWidth && srcEl.naturalHeight
        ? srcEl.naturalWidth / srcEl.naturalHeight
        : 16 / 9;

    const ordered = plan.before ? [srcNode, ...targetNodes] : [...targetNodes, srcNode];
    const orderedArs = plan.before ? [srcAr, ...targetArs] : [...targetArs, srcAr];
    const widths = balancedColumnWidths(orderedArs, totalWidth);

    const cells = ordered.map((node, i) =>
      schema.nodes.tableCell.create({ colwidth: [widths[i]] }, [cellContent(node)])
    );
    const row = schema.nodes.tableRow.create(null, cells);
    const table = schema.nodes.table.create(null, [row]);

    const tr = ed.state.tr;
    deleteSource(tr);
    const at = clamp(tr.mapping.map(plan.blockPos), 0, tr.doc.content.size);
    const to = Math.min(at + plan.blockNode.nodeSize, tr.doc.content.size);
    tr.replaceWith(at, to, table);
    cleanupSourceTable(tr, srcTableInfo);
    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
    scheduleBalanceTables();
    return;
  }

  // ─── 在已有分栏的指定列位置插入一列 ────────────────────────────────────
  if (plan.kind === 'addColumn') {
    /**
     * 新列必须从原有列宽里「挤」出来，不能直接叠加：
     * 原列宽总和本就等于容器宽，再塞一列全额宽会让表格每插一次就宽出编辑区一点
     * （横向滚动 / 图片顶到屏幕外）。这里按原有列宽比例整体缩放到容器宽。
     */
    const tableEl = (plan.anchorEl.matches('table')
      ? plan.anchorEl
      : plan.anchorEl.closest('table')) as HTMLElement | null;
    const container = Math.max(
      120,
      tableEl?.parentElement?.clientWidth || tableEl?.clientWidth || 0
    );

    const tr = ed.state.tr;
    deleteSource(tr);
    const at = clamp(tr.mapping.map(plan.tablePos), 0, tr.doc.content.size);
    /**
     * 源图可能就在这个表格里（同一个表格内把图拖到列间新增一列）。
     * 这种情况必须以「删除源图后的表格」为起点：
     *   - 否则新表格里会同时存在原图和复制出来的图；
     *   - 旧节点的 nodeSize 比当前文档里的表格大 1，替换范围会多吃掉后面的内容。
     */
    const sameTable = !!srcTableInfo && srcTableInfo.pos === plan.tablePos;
    const baseNode = sameTable ? (tr.doc.nodeAt(at) as any) : null;
    const baseTable = baseNode && baseNode.type.name === 'table' ? baseNode : plan.tableNode;

    const cols = baseTable.firstChild?.childCount || 0;
    const insertAt = clamp(plan.insertIndex, 0, cols);
    const firstRowEl = tableEl?.querySelector('tr') as HTMLElement | null;
    const oldWidths: number[] = [];
    baseTable.firstChild?.forEach((cell: any, _offset: number, index: number) => {
      const cw = Number(cell.attrs?.colwidth?.[0]);
      const domW = firstRowEl?.children[index]?.getBoundingClientRect().width || 0;
      oldWidths.push(cw > 0 ? cw : domW || container / Math.max(cols, 1));
    });
    const widths = [...oldWidths];
    widths.splice(insertAt, 0, plan.colWidth);
    const sum = widths.reduce((acc, w) => acc + w, 0) || 1;
    const fitted = widths.map((w) => Math.max(1, Math.round((w * container) / sum)));
    // 四舍五入误差补到最后一列，保证总和正好等于容器宽
    fitted[fitted.length - 1] = Math.max(
      1,
      fitted[fitted.length - 1] + container - fitted.reduce((acc, w) => acc + w, 0)
    );

    const colWidthAt = (i: number) => fitted[i] ?? fitted[fitted.length - 1];
    const newCell = schema.nodes.tableCell.create({ colwidth: [colWidthAt(insertAt)] }, [
      cellContent(srcNode),
    ]);
    const rows: any[] = [];
    baseTable.forEach((row: any) => {
      const cells: any[] = [];
      let inserted = false;
      for (let i = 0; i < row.childCount; i++) {
        if (!inserted && i === insertAt) {
          cells.push(newCell);
          inserted = true;
        }
        const cell = row.child(i);
        cells.push(
          cell.type.create({ ...cell.attrs, colwidth: [colWidthAt(cells.length)] }, cell.content)
        );
      }
      if (!inserted) cells.push(newCell); // 行尾插入
      rows.push(schema.nodes.tableRow.create(row.attrs, cells));
    });
    const table = schema.nodes.table.create(baseTable.attrs, rows);

    const to = Math.min(at + baseTable.nodeSize, tr.doc.content.size);
    tr.replaceWith(at, to, table);
    // 同表格时源列在新表格里可能后移了（新列插在它前面），清理空列要按新索引
    cleanupSourceTable(
      tr,
      srcTableInfo
        ? {
            pos: srcTableInfo.pos,
            colIndex: srcTableInfo.colIndex + (insertAt <= srcTableInfo.colIndex ? 1 : 0),
          }
        : null
    );
    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
    scheduleBalanceTables();
    return;
  }

  // ─── 放进已有单元格（不新开列） ────────────────────────────────────────
  if (plan.kind === 'cell') {
    const tr = ed.state.tr;
    deleteSource(tr);
    const at = clamp(tr.mapping.map(plan.cellPos), 0, tr.doc.content.size);
    const cell = tr.doc.nodeAt(at);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) return;

    const content = cellContent(srcNode);
    const emptyCell =
      cell.childCount === 1 &&
      cell.firstChild?.type.name === 'paragraph' &&
      cell.firstChild.content.size === 0;
    if (emptyCell) {
      tr.replaceWith(at + 1, at + cell.nodeSize - 1, content);
    } else {
      tr.insert(at + cell.nodeSize - 1, content);
    }
    cleanupSourceTable(tr, srcTableInfo);
    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
    scheduleBalanceTables();
    return;
  }

  // ─── 在块前/后新建段落 ─────────────────────────────────────────────────
  const tr = ed.state.tr;
  deleteSource(tr);
  const at = clamp(tr.mapping.map(plan.pos), 0, tr.doc.content.size);
  tr.insert(at, cellContent(srcNode));
  cleanupSourceTable(tr, srcTableInfo);
  if (tr.docChanged) view.dispatch(tr.scrollIntoView());
  scheduleBalanceTables();
}

// ─── 选中框：飞书式 8 手柄缩放（四角圆点 + 四边胶囊） ─────────────────────
/**
 * 点击图片 → 蓝色选中框 + 8 个手柄；拖手柄缩放：
 *   - 并排行内的图：调整这张图在行里的占比 → 写 flex 属性（data-flex 持久化），
 *     重排后保持宽高比、高度自适应（同行可能不等高，顶边对齐）
 *   - 独立成段的图：调整宽度百分比 → 写 width 属性（data-width 持久化）
 *
 * 宽度换算（手柄语义，锚点 = 起始矩形）：
 *   e/ne/se 边 → 宽 = 光标到左缘距离；w/nw/sw 边 → 宽 = 右缘到光标距离；
 *   n 边 → 由「底缘到光标的距离」按宽高比换算；s 边 → 由「顶缘到光标」换算。
 */
const HANDLE_SIDES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type HandleSide = (typeof HANDLE_SIDES)[number];

/** 手柄提示文案 */
const handleTitles: Record<HandleSide, string> = {
  nw: '拖动缩放（保持宽高比）',
  n: '上下拖动缩放',
  ne: '拖动缩放（保持宽高比）',
  e: '左右拖动缩放',
  se: '拖动缩放（保持宽高比）',
  s: '上下拖动缩放',
  sw: '拖动缩放（保持宽高比）',
  w: '左右拖动缩放',
};

const selFrame = ref<{ left: number; top: number; width: number; height: number } | null>(null);
const frameStyle = computed(() => {
  const f = selFrame.value;
  if (!f) return {};
  const style: Record<string, string> = {
    left: `${Math.round(f.left)}px`,
    top: `${Math.round(f.top)}px`,
    width: `${Math.round(f.width)}px`,
    height: `${Math.round(f.height)}px`,
  };
  // 选中框是 fixed 浮层：图片滚到编辑区边缘时，框和手柄会画到编辑器工具栏、
  // 「正文」标签上（视觉穿透）。用 clip-path 裁到编辑区可视范围内，
  // 越界部分（含向外偏移的手柄）不再显示。
  const view = editorViewRect();
  if (view) {
    const top = Math.max(0, Math.round(view.top - f.top));
    const right = Math.max(0, Math.round(f.left + f.width - view.right));
    const bottom = Math.max(0, Math.round(f.top + f.height - view.bottom));
    const left = Math.max(0, Math.round(view.left - f.left));
    if (top || right || bottom || left) {
      style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    }
  }
  return style;
});

/** 选中框贴着图片实时定位（DOM 重建/滚动/缩放都会重刷） */
function positionSelection() {
  const img = selectedMediaEl;
  if (!img || handleDragState || imgDrag) return;
  if (!document.body.contains(img)) {
    selFrame.value = null;
    return;
  }
  const r = img.getBoundingClientRect();
  selFrame.value = { left: r.left, top: r.top, width: r.width, height: r.height };
}

interface HandleDragState {
  /** 被拖动的媒体（图片 / 视频卡片） */
  el: HTMLElement;
  /** 实际改样式的容器（图片是 NodeView 外壳；视频就是卡片本身） */
  shell: HTMLElement;
  side: HandleSide;
  mode: 'row' | 'single' | 'video';
  /** 起始视觉矩形（视口坐标） */
  startRect: { left: number; top: number; right: number; bottom: number };
  startWidth: number;
  startHeight: number;
  /** 所在容器的内容宽（行 flex 分配的总宽 / 单元格内容宽） */
  paraWidth: number;
  /** 同一视觉行里其它图的总权重（flex-grow 分母的其余部分） */
  othersWeight: number;
  /** 是否真的拖动过（未拖动松手不提交，避免误写属性） */
  moved: boolean;
  /** 拖动过程中实时解出的权重，松手直接提交（保证预览 = 最终，不回弹） */
  lastWeight: number | null;
}
let handleDragState: HandleDragState | null = null;

/** shell 的排版权重：--w 变量（NodeView 写入），读不到按宽高比兜底 */
function shellWeight(shell: HTMLElement): number {
  const v = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--w'));
  if (Number.isFinite(v) && v > 0) return v;
  const img = shell.querySelector('img');
  if (img && img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  return 1;
}

/** 容器的内容宽（扣掉左右内边距），用于把 px 宽度换算成百分比 */
function contentWidthOf(el: HTMLElement): number {
  const host = (el.parentElement as HTMLElement | null) || el;
  const cs = getComputedStyle(host);
  const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  return Math.max(80, host.clientWidth - pad);
}

function onSelHandleDown(e: PointerEvent, side: HandleSide) {
  const el = selectedMediaEl;
  if (!el || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  // 视频卡片：块级节点，按「容器宽度百分比」缩放（没有并排行 flex 那一套）
  if (mediaKindOf(el) === 'video') {
    const vr = el.getBoundingClientRect();
    handleDragState = {
      el,
      shell: el,
      side,
      mode: 'video',
      startRect: { left: vr.left, top: vr.top, right: vr.right, bottom: vr.bottom },
      startWidth: vr.width,
      startHeight: vr.height,
      paraWidth: contentWidthOf(el),
      othersWeight: 0,
      moved: false,
      lastWeight: null,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onSelHandleMove);
    document.addEventListener('pointerup', onSelHandleUp);
    document.addEventListener('pointercancel', onSelHandleUp);
    return;
  }

  const img = el as HTMLImageElement;
  const shell = (img.closest('.diary-img-shell') as HTMLElement | null) || img.parentElement;
  const p = img.closest('p');
  if (!shell || !p) return;

  const r = img.getBoundingClientRect();
  const inRow = (p as HTMLElement).querySelectorAll(':scope > .diary-img-shell').length >= 2;

  // 并排行：同一视觉行（顶边对齐）里其它图的总权重，用于换算新权重
  let othersWeight = 0;
  if (inRow) {
    const shells = Array.from((p as HTMLElement).querySelectorAll<HTMLElement>(':scope > .diary-img-shell'));
    const others = shells.filter(
      (sh) => sh !== shell && Math.abs(sh.getBoundingClientRect().top - r.top) < 24
    );
    othersWeight = others.reduce((acc, sh) => acc + shellWeight(sh), 0);
  }

  handleDragState = {
    el: img,
    shell,
    side,
    mode: inRow ? 'row' : 'single',
    startRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    startWidth: r.width,
    startHeight: r.height,
    paraWidth: p.clientWidth || 600,
    othersWeight,
    moved: false,
    lastWeight: null,
  };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  document.addEventListener('pointermove', onSelHandleMove);
  document.addEventListener('pointerup', onSelHandleUp);
  document.addEventListener('pointercancel', onSelHandleUp);
}

function onSelHandleMove(e: PointerEvent) {
  const h = handleDragState;
  if (!h) return;
  e.preventDefault();
  h.moved = true;
  const newWidth = computeNewWidth(h, e.clientX, e.clientY);
  if (h.mode === 'video') {
    // 视频按 px 拖，aspect-ratio 由 CSS 保持；松手再换算成百分比存属性
    h.shell.style.width = `${Math.round(newWidth)}px`;
  } else if (h.mode === 'row') {
    // 预览与最终布局必须走同一个模型（flex-grow: var(--w)），否则松手会回弹。
    // flex 布局：我的宽度 = w/(w+Σ其它权重) × 行宽，反解 w：
    //   w = 目标宽 × Σ其它权重 / (行宽 - 目标宽)
    const W2 = h.othersWeight;
    let weight: number;
    if (W2 > 0) {
      const S = Math.max(h.paraWidth, newWidth + 24);
      weight = (newWidth * W2) / Math.max(S - newWidth, 1);
    } else {
      weight = shellWeight(h.shell) * (newWidth / Math.max(h.startWidth, 1));
    }
    weight = clamp(weight, 0.12, 60);
    h.lastWeight = weight;
    // 只写 --w（NodeView 外壳内联样式，ignoreMutation 保护，PM 不重绘），
    // min/max-width 的 CSS 规则照常生效 → 预览含折行/封顶判定，与最终一致
    h.shell.style.setProperty('--w', weight.toFixed(2));
  } else {
    h.shell.style.width = `${Math.round(newWidth)}px`;
  }
  positionSelectionForce();
}

/** 按手柄方位把光标位置换算成新宽度 */
function computeNewWidth(
  h: HandleDragState,
  px: number,
  py: number
): number {
  const { left, right, top, bottom } = h.startRect;
  const aspect = h.startWidth / Math.max(h.startHeight, 1);
  let w: number;
  switch (h.side) {
    case 'e': case 'ne': case 'se':
      w = px - left; break;
    case 'w': case 'nw': case 'sw':
      w = right - px; break;
    case 'n':
      w = (bottom - py) * aspect; break;
    case 's':
      w = (py - top) * aspect; break;
  }
  const min = h.mode === 'row' ? 24 : h.paraWidth * 0.05;
  const max = h.mode === 'row' ? h.paraWidth * 0.96 : h.paraWidth;
  return clamp(w, min, max);
}

/** 拖手柄期间 positionSelection 有 handleDragState 守卫，这里强刷位置 */
function positionSelectionForce() {
  const el = handleDragState?.el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  selFrame.value = { left: r.left, top: r.top, width: r.width, height: r.height };
}

function onSelHandleUp() {
  const h = handleDragState;
  if (!h) return;
  handleDragState = null;
  document.removeEventListener('pointermove', onSelHandleMove);
  document.removeEventListener('pointerup', onSelHandleUp);
  document.removeEventListener('pointercancel', onSelHandleUp);
  commitMediaResize(h);
}

/** 松手：预览宽度 → 节点属性持久化（并排行写 flex；单图写 width；视频写 width 百分比） */
function commitMediaResize(h: HandleDragState) {
  // 没有真正拖动就不提交（点了手柄立刻松开的误触）
  if (!h.moved) return;
  const ed = liveEditor();
  if (!ed) return;
  let pos: number;
  try {
    pos = mediaNodePos(ed, h.el);
  } catch {
    return;
  }
  const node = ed.state.doc.nodeAt(pos);
  if (!node) return;

  if (h.mode === 'video') {
    if (node.type.name !== 'video') return;
    const newW = h.shell.getBoundingClientRect().width;
    const pct = Math.round(clamp((newW / Math.max(h.paraWidth, 1)) * 100, 5, 100) * 10) / 10;
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: pct }));
  } else if (h.mode === 'row') {
    if (node.type.name !== 'image') return;
    // 拖动过程中已经按 flex 布局模型实时解出权重，直接提交 → 预览即最终，无回弹
    const weight = h.lastWeight ?? shellWeight(h.shell);
    const rounded = Math.round(clamp(weight, 0.12, 60) * 100) / 100;
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, flex: rounded }));
  } else {
    if (node.type.name !== 'image') return;
    const newW = h.shell.getBoundingClientRect().width;
    // 保留 1 位小数，把提交前后的宽度差压到 1px 以内
    const pct = Math.round(clamp((newW / Math.max(h.paraWidth, 1)) * 100, 5, 100) * 10) / 10;
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: pct }));
  }
  // setNodeMarkup 走 NodeView.update，不产生 childList 变更 → 主动刷一次选中框，
  // 避免框停在松手前的旧矩形上（表现为框「穿透」到图片上方）
  scheduleOverlaySync();
}

// 对外暴露 getHTML / setContent，给父组件读和写
defineExpose({
  getHTML: () => liveEditor()?.getHTML() ?? '',
  getText: () => liveEditor()?.getText() ?? '',
  setContent: (html: string) => liveEditor()?.commands.setContent(html, { emitUpdate: false }),
  focus: () => liveEditor()?.commands.focus(),
});

onMounted(() => {
  const el = editorEl.value?.$el as HTMLElement | undefined;
  el?.addEventListener('paste', onPaste as any);
  // 监听编辑器内点击：如果点的是高亮块的 emoji 按钮，弹出 EmojiPicker
  el?.addEventListener('click', onEditorClick as any);
  // 点击编辑器外部关闭 emoji 选择器
  document.addEventListener('click', onDocClick);

  // 原生 click 监听在 .ProseMirror body 上 → 图片选中/清除
  // （必须用原生 DOM 监听，不用 ProseMirror 的 selection 机制，
  //  因为 ProseMirror 会把 inline image 的 NodeSelection 降级成 TextSelection）
  const body = liveEditor()?.view.dom;
  if (body) {
    body.addEventListener('click', handleEditorBodyClick as any);
    // 飞书式图片拖拽重排：pointer events 自己实现（HTML5 draggable 会吃掉 click）
    body.addEventListener('pointerdown', onBodyPointerDown as any);

  }

  // 任何拖拽结束都清掉高亮，防止卡在 is-drag-over
  window.addEventListener('dragend', onAnyDragEnd);
  window.addEventListener('drop', onAnyDragEnd);
  // 列宽拖拽状态自愈：拖拽中途结构被改写时插件会卡住 dragging，松手后补一次复位
  // 只挂 mouseup（prosemirror-tables 的 finish 也挂在 mouseup 上，同步先跑完再检查）；
  // 不挂 pointerup，避免兼容鼠标事件尚未派发时把正常的列宽提交打断
  window.addEventListener('mouseup', healStuckColumnResize);
  window.addEventListener('pointercancel', healStuckColumnResize);
  // 视频卡片播放键 → 打开独立播放浮层
  window.addEventListener('diary:play-video', onPlayVideoEvent as EventListener);

  // 编辑器 DOM 变化时重新定位悬浮元素（选中框/工具栏）。
  // childList + style 属性都要监听：缩放提交/图片加载只改内联样式（--w、width），
  // 不产生 childList 变更，漏掉会导致选中框停在旧矩形上（框「穿透」到图片上方）。
  // 这里只读 DOM 不写入 → 不会像旧版那样和 PM 的 DOMObserver 互相触发死循环。
  if (body) {
    rowObserver = new MutationObserver(scheduleOverlaySync);
    rowObserver.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }
  scheduleOverlaySync();
});
onBeforeUnmount(() => {
  const el = editorEl.value?.$el as HTMLElement | undefined;
  el?.removeEventListener('paste', onPaste as any);
  el?.removeEventListener('click', onEditorClick as any);
  document.removeEventListener('click', onDocClick);
  const body = liveEditor()?.view.dom;
  if (body) {
    body.removeEventListener('click', handleEditorBodyClick as any);
    body.removeEventListener('pointerdown', onBodyPointerDown as any);

  }
  window.removeEventListener('dragend', onAnyDragEnd);
  window.removeEventListener('drop', onAnyDragEnd);
  window.removeEventListener('mouseup', healStuckColumnResize);
  window.removeEventListener('pointercancel', healStuckColumnResize);
  window.removeEventListener('diary:play-video', onPlayVideoEvent as EventListener);
  // 拖拽进行中卸载（如用户回车保存）：清掉 document 级监听与悬浮 DOM，
  // 否则后续 pointerup/rAF 会访问已销毁的 view（tiptap 直接抛错）
  cleanupImgDragListeners();
  clearPendingMediaDrag();
  document.removeEventListener('pointermove', onSelHandleMove);
  document.removeEventListener('pointerup', onSelHandleUp);
  document.removeEventListener('pointercancel', onSelHandleUp);
  handleDragState = null;
  imgDrag = null;
  document.querySelectorAll('.img-drag-ghost, .img-drop-indicator, .img-sel-frame, .img-tool').forEach((el) => el.remove());
  rowObserver?.disconnect();
  rowObserver = null;
  if (rowRaf) cancelAnimationFrame(rowRaf);
});

/** 编辑器内点击：检测是否点击了高亮块的 emoji 按钮 */
function onEditorClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const emojiBtn = target.closest('.callout-emoji') as HTMLElement | null;
  if (emojiBtn) {
    e.preventDefault();
    e.stopPropagation();
    activeCalloutEl.value = emojiBtn;
    emojiPickerOpen.value = !emojiPickerOpen.value;
  }
}

/** 点击文档其他地方关闭 emoji 选择器 */
function onDocClick(e: MouseEvent) {
  if (!emojiPickerOpen.value) return;
  const target = e.target as HTMLElement;
  if (target.closest('.emoji-picker') || target.closest('.callout-emoji')) return;
  emojiPickerOpen.value = false;
  activeCalloutEl.value = null;
}

/** 从 EmojiPicker 选中 emoji 后，更新当前高亮块的 emoji */
function onEmojiSelect(emoji: string) {
  if (!activeCalloutEl.value) return;
  // 通过 data-emoji 属性找到对应的 callout 节点位置并更新
  const calloutEl = activeCalloutEl.value.closest('.callout') as HTMLElement;
  if (!calloutEl) return;

  const ed = liveEditor();
  if (!ed) return;
  const view = ed.view;
  try {
    // posAtDOM: 通过 DOM 节点找到它在文档中的位置
    const pos = view.posAtDOM(calloutEl, 0);
    if (pos != null) {
      ed.chain().focus().setTextSelection(pos).updateCalloutEmoji(emoji).run();
    }
  } catch {
    // fallback：posAtDOM 失败时直接更新 DOM 显示
    activeCalloutEl.value.textContent = emoji;
    activeCalloutEl.value.setAttribute('data-emoji', emoji);
    calloutEl.setAttribute('data-emoji', emoji);
  }
  emojiPickerOpen.value = false;
  activeCalloutEl.value = null;
}
</script>

<template>
  <div class="diary-editor">
    <!-- 工具栏：飞书风格分组 -->
    <div class="toolbar">
      <!-- 撤销/重做 -->
      <div class="tb-group">
        <button type="button" class="tb-btn" title="撤销 (Ctrl+Z)" @click="undo">↶</button>
        <button type="button" class="tb-btn" title="重做 (Ctrl+Shift+Z)" @click="redo">↷</button>
      </div>

      <div class="tb-sep"></div>

      <!-- 标题 -->
      <div class="tb-group">
        <button
          type="button"
          class="tb-btn"
          title="一级标题 (输入 # 空格)"
          :class="{ on: isActive('heading', { level: 1 }) }"
          @click="toggleHeading(1)"
        >H1</button>
        <button
          type="button"
          class="tb-btn"
          title="二级标题 (输入 ## 空格)"
          :class="{ on: isActive('heading', { level: 2 }) }"
          @click="toggleHeading(2)"
        >H2</button>
        <button
          type="button"
          class="tb-btn"
          title="三级标题 (输入 ### 空格)"
          :class="{ on: isActive('heading', { level: 3 }) }"
          @click="toggleHeading(3)"
        >H3</button>
        <button
          type="button"
          class="tb-btn"
          title="四级标题 (输入 #### 空格)"
          :class="{ on: isActive('heading', { level: 4 }) }"
          @click="toggleHeading(4)"
        >H4</button>
      </div>

      <div class="tb-sep"></div>

      <!-- 列表 -->
      <div class="tb-group">
        <button
          type="button"
          class="tb-btn tb-icon"
          title="无序列表 (输入 - 空格)"
          :class="{ on: isActive('bulletList') }"
          @click="toggleBulletList"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <circle cx="2.4" cy="4" r="1" fill="currentColor" />
            <circle cx="2.4" cy="8" r="1" fill="currentColor" />
            <circle cx="2.4" cy="12" r="1" fill="currentColor" />
            <path d="M5.8 4h8.2M5.8 8h8.2M5.8 12h8.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn tb-icon"
          title="有序列表 (输入 1. 空格)"
          :class="{ on: isActive('orderedList') }"
          @click="toggleOrderedList"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <text x="0.9" y="5.6" font-size="4.8" font-weight="700" fill="currentColor" font-family="Arial, Helvetica, sans-serif">1</text>
            <text x="0.9" y="9.6" font-size="4.8" font-weight="700" fill="currentColor" font-family="Arial, Helvetica, sans-serif">2</text>
            <text x="0.9" y="13.6" font-size="4.8" font-weight="700" fill="currentColor" font-family="Arial, Helvetica, sans-serif">3</text>
            <path d="M5.8 4h8.2M5.8 8h8.2M5.8 12h8.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn"
          title="任务列表"
          :class="{ on: isActive('taskList') }"
          @click="toggleTaskList"
        >☑</button>
      </div>

      <div class="tb-sep"></div>

      <!-- 格式 -->
      <div class="tb-group">
        <button type="button" class="tb-btn" title="粗体 (Ctrl+B)" :class="{ on: isActive('bold') }" @click="toggleBold">
          <b>B</b>
        </button>
        <button type="button" class="tb-btn" title="斜体 (Ctrl+I)" :class="{ on: isActive('italic') }" @click="toggleItalic">
          <i>I</i>
        </button>
        <button type="button" class="tb-btn" title="删除线" :class="{ on: isActive('strike') }" @click="toggleStrike">
          <s>S</s>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 块级 -->
      <div class="tb-group">
        <button
          type="button"
          class="tb-btn"
          title="引用块 (输入 > 空格)"
          :class="{ on: isActive('blockquote') }"
          @click="toggleQuote"
        >❝</button>
        <button
          type="button"
          class="tb-btn"
          title="高亮块"
          :class="{ on: isActive('callout') }"
          @click="toggleCallout"
        >💡</button>
        <button type="button" class="tb-btn" title="分割线 (输入 --- 回车)" @click="setHorizontalRule">―</button>
      </div>

      <div class="tb-sep"></div>

      <!-- 对齐 -->
      <div class="tb-group">
        <button
          type="button"
          class="tb-btn tb-icon"
          title="左对齐"
          :class="{ on: isAlign('left') }"
          @click="setTextAlign('left')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M2 3h12M2 7h8M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn tb-icon"
          title="居中对齐"
          :class="{ on: isAlign('center') }"
          @click="setTextAlign('center')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M2 3h12M4 7h8M3 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn tb-icon"
          title="右对齐"
          :class="{ on: isAlign('right') }"
          @click="setTextAlign('right')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M2 3h12M6 7h8M4 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 插入图片 / 视频 -->
      <div class="tb-group">
        <button type="button" class="tb-btn" title="插入图片（或直接粘贴）" :disabled="uploading" @click="pickImage">
          🖼
        </button>
        <button type="button" class="tb-btn" title="插入视频（或直接粘贴）" :disabled="uploading" @click="pickVideo">
          🎬
        </button>
      </div>

      <div class="tb-sep"></div>

      <!-- 分栏：横向混排（图片 / 视频 / 文字），列宽可拖动 -->
      <div class="tb-group">
        <button type="button" class="tb-btn tb-icon" title="插入分栏（两列，可拖列宽）" @click="insertColumns">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8 3.2v9.6" stroke="currentColor" stroke-width="1.3"/>
          </svg>
        </button>
        <template v-if="isInTable">
          <button type="button" class="tb-btn" title="右侧加一列" @click="addColumn">＋</button>
          <button type="button" class="tb-btn" title="删除当前列" @click="removeColumn">－</button>
          <button type="button" class="tb-btn" title="删除整个分栏" @click="removeTable">✕</button>
        </template>
      </div>
    </div>

    <!-- 编辑区：支持拖拽图片/视频到指定位置上传 -->
    <div
      ref="scrollEl"
      class="editor-scroll"
      :class="{ 'is-drag-over': isDraggingOver }"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- 拖拽时的顶部提示条（飞书风格），不再盖满整个编辑区 -->
      <div v-if="isDraggingOver" class="drop-hint">松开即可添加到此位置</div>
      <EditorContent ref="editorEl" :editor="editor" class="editor-content" />
      <!-- 上传进度：图片上传时右下角小胶囊 -->
      <div v-if="uploading" class="upload-pill">◐ {{ uploadPct }}%</div>
    </div>

    <!-- 媒体浮动工具栏：选中图片 / 视频后出现在正上方 -->
    <Teleport to="body">
      <div v-if="selectedMedia" ref="toolEl" class="img-tool" :style="imageToolStyle" @mousedown.prevent>
        <template v-if="!selectedMediaIsVideo && selectedMediaSolo">
          <button type="button" class="it-btn" :class="{ on: selectedMediaAlign === 'left' }" title="左对齐" @click="alignSelectedImage('left')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="it-btn" :class="{ on: selectedMediaAlign === 'center' }" title="居中对齐" @click="alignSelectedImage('center')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="it-btn" :class="{ on: selectedMediaAlign === 'right' }" title="右对齐" @click="alignSelectedImage('right')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <span class="it-sep"></span>
        </template>
        <template v-else-if="selectedMediaIsVideo">
          <button type="button" class="it-btn" :class="{ on: selectedVideoAlign === 'left' }" title="左对齐" @click="alignSelectedVideo('left')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="it-btn" :class="{ on: selectedVideoAlign === 'center' }" title="居中对齐" @click="alignSelectedVideo('center')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="it-btn" :class="{ on: selectedVideoAlign === 'right' }" title="右对齐" @click="alignSelectedVideo('right')">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <span class="it-sep"></span>
        </template>
        <button
          v-if="!selectedMediaIsVideo"
          type="button"
          class="it-btn"
          title="替换图片"
          @click="pickReplaceImage"
        >
          ⇄
        </button>
        <button
          v-if="selectedMediaIsVideo"
          type="button"
          class="it-btn"
          title="恢复原始宽度"
          @click="resetSelectedVideoWidth"
        >
          ⤢
        </button>
        <button
          type="button"
          class="it-btn"
          :title="selectedMediaIsVideo ? '下载视频' : '下载图片'"
          @click="downloadSelectedMedia"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3l3-3M2.5 12.5h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        </button>
        <button
          type="button"
          class="it-btn danger"
          :title="selectedMediaIsVideo ? '删除视频' : '删除图片'"
          @click="deleteSelectedMedia"
        >
          🗑
        </button>
      </div>
    </Teleport>
    <input ref="replaceInput" type="file" accept="image/*" class="hidden-file" @change="onReplaceImagePicked" />

    <!-- 图片选中框：飞书式四角圆点 + 四边胶囊手柄，拖动缩放 -->
    <Teleport to="body">
      <div v-if="selFrame && !isImgDragging" class="img-sel-frame" :style="frameStyle">
        <span
          v-for="side in HANDLE_SIDES"
          :key="side"
          :class="['sel-handle', `sel-handle-${side}`]"
          :title="handleTitles[side]"
          @pointerdown="onSelHandleDown($event, side)"
        ></span>
      </div>
    </Teleport>

    <!-- Emoji 选择器：点击高亮块的 emoji 按钮时弹出 -->
    <Teleport to="body">
      <EmojiPicker
        v-if="emojiPickerOpen && activeCalloutEl"
        :model-value="emojiPickerOpen"
        :style="emojiPickerStyle"
        @update:model-value="emojiPickerOpen = $event"
        @select="onEmojiSelect"
      />
    </Teleport>

    <!-- 隐藏文件选择器：图片 & 视频 -->
    <input
      ref="imageInput"
      type="file"
      accept="image/*"
      multiple
      class="hidden-file"
      @change="onImagePicked"
    />
    <input
      ref="videoInput"
      type="file"
      accept="video/mp4,video/webm,video/quicktime"
      multiple
      class="hidden-file"
      @change="onVideoPicked"
    />

    <!-- 独立视频播放浮层 -->
    <VideoPlayerModal
      v-model="videoPlayerOpen"
      :src="videoPlayerSrc"
      :poster="videoPlayerPoster"
    />
  </div>
</template>

<style scoped>
.diary-editor {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, 0.6);
  overflow: hidden;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding: var(--space-8) var(--space-10);
  background: var(--glass-bg-strong);
  border-bottom: 1px solid var(--glass-border);
}
.tb-group { display: flex; align-items: center; gap: 2px; }
.tb-sep { width: 1px; height: 18px; background: var(--glass-border); margin: 0 2px; }
.tb-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  transition: all var(--dur-fast);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tb-btn:hover:not(:disabled) {
  background: rgba(255, 209, 102, 0.3);
  color: var(--text-on-yellow);
}
.tb-btn.on {
  background: rgba(255, 209, 102, 0.5);
  color: var(--text-on-yellow);
}
.tb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* SVG 图标按钮：让 svg 继承按钮文字颜色，并保持垂直居中 */
.tb-btn.tb-icon {
  color: var(--text-secondary);
}
.tb-btn.tb-icon svg {
  display: block;
}
.tb-btn.tb-icon:hover:not(:disabled) {
  color: var(--text-on-yellow);
}
.tb-btn.tb-icon.on {
  color: var(--text-on-yellow);
}

/* 编辑区 */
.editor-scroll {
  max-height: 400px;
  overflow-y: auto;
  position: relative;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
/* 拖拽文件进入编辑区：轻量边框高亮（不再盖淡黄色背景，否则会盖住编辑器里已有的图片） */
.editor-scroll.is-drag-over {
  border-color: var(--accent-yellow);
  box-shadow: inset 0 0 0 2px var(--accent-yellow);
}
/* 拖拽时顶部提示条（飞书风格）—— position: sticky 让它贴在编辑器顶部 */
.editor-scroll .drop-hint {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 6px 14px;
  margin: 0 8px 8px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-on-yellow);
  background: var(--accent-yellow);
  border-radius: 0 0 6px 6px;
  box-shadow: 0 2px 8px rgba(255, 209, 102, 0.35);
  pointer-events: none;
  user-select: none;
}
.editor-content {
  padding: var(--space-14);
  outline: none;
  min-height: 160px;
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: var(--text-primary);
}
/* 正文可编辑区聚焦时不要焦点环：全局 :focus-visible 会在真实 Chrome 里画一圈棕色描边 */
.editor-content :deep(.diary-editor-body:focus),
.editor-content :deep(.diary-editor-body:focus-visible) {
  outline: none;
  box-shadow: none;
}

.hidden-file { display: none; }

/* 图片浮动工具栏 */
.img-tool {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
}
.it-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.it-btn:hover { background: rgba(0, 0, 0, 0.06); }
.it-btn.on { background: #e8efff; color: #3370ff; }
.it-btn.danger:hover { background: #ffecec; color: #e5484d; }
.it-sep { width: 1px; height: 16px; background: rgba(0, 0, 0, 0.1); margin: 0 4px; }

/* 上传进度胶囊 */
.upload-pill {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 4px 10px;
  border-radius: var(--r-pill);
  background: rgba(90, 90, 90, 0.85);
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  pointer-events: none;
  z-index: 20;
}

/* ─── 富文本渲染样式 ─── */
.editor-content :deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
  margin-top: 1em;
  margin-bottom: 0.4em;
  line-height: 1.3;
  color: var(--text-primary);
}
.editor-content :deep(h2) {
  font-size: 1.3em;
  font-weight: 700;
  margin-top: 0.9em;
  margin-bottom: 0.3em;
  line-height: 1.35;
  color: var(--text-primary);
}
.editor-content :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin-top: 0.7em;
  margin-bottom: 0.3em;
  line-height: 1.4;
  color: var(--text-primary);
}
.editor-content :deep(h4) {
  font-size: 1.05em;
  font-weight: 600;
  margin-top: 0.6em;
  margin-bottom: 0.2em;
  line-height: 1.4;
  color: var(--text-secondary);
}
.editor-content :deep(p) {
  margin: 0.3em 0;
}
.editor-content :deep(ul),
.editor-content :deep(ol) {
  padding-left: 1.5em;
  margin: 0.3em 0;
}
.editor-content :deep(ul) { list-style: disc; }
.editor-content :deep(ol) { list-style: decimal; }
.editor-content :deep(li) { margin: 0.15em 0; }
.editor-content :deep(blockquote) {
  border-left: 3px solid var(--accent-orange);
  padding: 0.4em 0.8em;
  margin: 0.5em 0;
  background: rgba(255, 209, 102, 0.12);
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
  color: var(--text-secondary);
  font-style: italic;
}
.editor-content :deep(hr) {
  border: none;
  border-top: 1px solid rgba(0, 0, 0, 0.18);
  margin: 1em 0;
}
.editor-content :deep(strong) { font-weight: 700; }
.editor-content :deep(em) { font-style: italic; }
.editor-content :deep(s) { text-decoration: line-through; opacity: 0.7; }
.editor-content :deep(a) {
  color: var(--text-on-orange);
  text-decoration: underline;
}

/* 图片：NodeView 外壳（span.diary-img-shell > img），宽度由外壳控制，
   外壳内的一切改动 PM 都忽略（ignoreMutation）→ 不会触发重绘 */
.editor-content :deep(.diary-img-shell) {
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
  line-height: 0;
  /* 图片支持指针拖拽重排：禁掉触摸滚动手势冲突 */
  touch-action: none;
  /* 图片不参与文字选择：拖动时不会把图片/相邻文字一起刷成文字框选 */
  user-select: none;
  -webkit-user-select: none;
}
.editor-content :deep(.diary-img-shell img.diary-inline-image) {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--r-md);
}
.editor-content :deep(img.diary-inline-image.img-selected) {
  outline: 1.5px solid #3370ff;
  outline-offset: 2px;
}
/* 编辑器失去焦点时不再显示选中边框 */
.editor-content :deep(.diary-editor-body:not(.ProseMirror-focused) img.img-selected) {
  outline: none;
}
/* 拖拽重排的视觉反馈：源图半透明、目标图虚线框 */
.editor-content :deep(img.diary-inline-image.img-dragging) {
  opacity: 0.35;
}
.editor-content :deep(img.diary-inline-image.drop-hi) {
  outline: 2px dashed #3370ff;
  outline-offset: 2px;
}

/* 图片并排排布已迁移到表格分栏（见上方 table.diary-table），
   编辑器内不再对同段落多图做 flex 行布局。 */

/* 视频：16:9 自适应容器，保持宽高比 */
.editor-content :deep(video) {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--r-md);
  margin: 0.5em auto;
  background: #000;
  cursor: pointer;
  transition: box-shadow var(--dur-fast);
}
.editor-content :deep(video:hover) {
  box-shadow: 0 0 0 2px var(--accent-yellow);
}

/* ─── 视频缩略图卡片（点击播放键打开独立播放浮层）─── */
.editor-content :deep(.diary-video) {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 0.5em 0;
  border-radius: var(--r-md);
  overflow: hidden;
  background: #141414;
  user-select: none;
  /* 视频卡片支持指针拖拽成列，禁掉触摸滚动手势冲突 */
  touch-action: none;
}
.editor-content :deep(.diary-video.img-dragging) {
  opacity: 0.35;
}
/* 选中态：视频卡片和图片一样显示蓝色选中框（框 + 缩放手柄由 .img-sel-frame 画） */
.editor-content :deep(.diary-video.img-selected) {
  outline: 1.5px solid #3370ff;
  outline-offset: 2px;
}
.editor-content :deep(.diary-editor-body:not(.ProseMirror-focused) .diary-video.img-selected) {
  outline: none;
}
/* 缩窄后的视频居中显示，和「一个独立片段」的视觉一致 */
.editor-content :deep(.diary-video[data-width]) {
  margin-left: auto;
  margin-right: auto;
}
/* 左 / 右对齐（工具栏按钮写入的 data-align，未设置时按居中） */
.editor-content :deep(.diary-video[data-align='left']) {
  margin-left: 0;
  margin-right: auto;
}
.editor-content :deep(.diary-video[data-align='right']) {
  margin-left: auto;
  margin-right: 0;
}
.editor-content :deep(.diary-video .dv-thumb) {
  position: absolute;
  inset: 0;
}
.editor-content :deep(.diary-video .dv-thumb img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.editor-content :deep(.dv-thumb-empty) {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255, 255, 255, 0.5);
  font-size: var(--fs-sm);
  letter-spacing: 2px;
}
.editor-content :deep(.dv-play) {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.52);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  backdrop-filter: blur(4px);
  transition: background var(--dur-fast), transform var(--dur-fast);
}
.editor-content :deep(.dv-play:hover) {
  background: rgba(0, 0, 0, 0.72);
  transform: translate(-50%, -50%) scale(1.06);
}
.editor-content :deep(.dv-name) {
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
/* 上传占位：遮罩 + 百分比 + 进度条 */
.editor-content :deep(.dv-upload-mask) {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.editor-content :deep(.dv-upload-text) {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.editor-content :deep(.dv-upload-track) {
  width: 56%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
}
.editor-content :deep(.dv-progress-bar) {
  display: block;
  height: 100%;
  background: #fff;
  transition: width 0.15s linear;
}

/* ─── 分栏表格（横向混排：图片 / 视频 / 文字）─── */
/* 编辑态的网格用「单元格浅灰背景 + 间隙」区分，不画边框线（参照飞书）；
   阅读端走 DiaryTimeline 的无背景样式。
   关键：border-spacing = 0，列宽总和严格等于容器宽度，不产生横向滚动。 */
.editor-content :deep(.tableWrapper) {
  overflow-x: hidden;
  margin: 0.6em 0;
}
.editor-content :deep(table.diary-table) {
  width: 100% !important;
  min-width: 0 !important;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}
.editor-content :deep(table.diary-table td),
.editor-content :deep(table.diary-table th) {
  position: relative;
  vertical-align: top;
  /* 左右只留 2px：一行多图时图片几乎顶到编辑区两边，中间留 4px 视觉间隙 */
  padding: 4px 2px;
  border: none;
  background: transparent;
}
/* 背景块用伪元素内缩，不影响列宽（图片可以顶到列的两边） */
.editor-content :deep(table.diary-table td::before),
.editor-content :deep(table.diary-table th::before) {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 8px;
  background: rgba(90, 58, 74, 0.08);
  pointer-events: none;
}
.editor-content :deep(table.diary-table td > *),
.editor-content :deep(table.diary-table th > *) {
  position: relative;
  z-index: 1;
}
/* 选中单元格（CellSelection）加深底色 */
.editor-content :deep(table.diary-table .selectedCell::after) {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 8px;
  background: rgba(51, 112, 255, 0.1);
  pointer-events: none;
}
/* 单元格内段落与媒体不再额外留白 */
.editor-content :deep(table.diary-table td > p),
.editor-content :deep(table.diary-table th > p) {
  margin: 0;
}
/* 单元格内的视频只清掉上下留白，左右留给对齐逻辑（左/中/右） */
.editor-content :deep(table.diary-table td > .diary-video) {
  margin-top: 0;
  margin-bottom: 0;
}
/* 单元格里只有一张图时，默认占满整列；用户缩窄后是 inline-block，
   段落 text-align（左/中/右对齐按钮）才能把图片水平居中 */
.editor-content :deep(table.diary-table td p:not(:has(> .diary-img-shell ~ .diary-img-shell)) > .diary-img-shell) {
  display: inline-block;
  width: 100%;
  max-width: 100%;
  vertical-align: top;
}
/* 列宽拖拽手柄：鼠标靠近两列交界时出现的蓝色竖线 */
.editor-content :deep(table.diary-table .column-resize-handle) {
  position: absolute;
  right: -3px;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 2px;
  background: #3370ff;
  opacity: 0.9;
  pointer-events: none;
  z-index: 6;
}
.editor-content :deep(.resize-cursor) {
  cursor: col-resize;
}

/* ─── 高亮块（Callout）─── */
.editor-content :deep(.callout) {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  margin: 0.6em 0;
  border-radius: var(--r-md);
  background: rgba(255, 209, 102, 0.12);
  border: 1px solid rgba(255, 209, 102, 0.35);
}
.editor-content :deep(.callout-emoji) {
  flex-shrink: 0;
  font-size: 20px;
  line-height: 1.4;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
  margin-top: 1px;
  user-select: none;
  transition: transform var(--dur-fast);
}
.editor-content :deep(.callout-emoji:hover) {
  transform: scale(1.15);
}
.editor-content :deep(.callout-content) {
  flex: 1;
  min-width: 0;
}
.editor-content :deep(.callout-content p) {
  margin: 0;
}

/* ─── 任务列表（Task List）─── */
.editor-content :deep(ul[data-type="taskList"]) {
  list-style: none;
  padding: 0;
  margin: 0.5em 0;
}
/* Tiptap v3 的 li 只带 data-checked，没有 data-type，所以用父级 ul 定位 */
.editor-content :deep(ul[data-type="taskList"] > li) {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0;
}
.editor-content :deep(ul[data-type="taskList"] > li > label) {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  height: 1.7em;
  user-select: none;
}
.editor-content :deep(ul[data-type="taskList"] > li > label input[type="checkbox"]) {
  width: 16px;
  height: 16px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent-yellow);
}
.editor-content :deep(ul[data-type="taskList"] > li > div) {
  flex: 1;
  min-width: 0;
}
.editor-content :deep(ul[data-type="taskList"] > li > div p) {
  margin: 0;
  line-height: 1.7;
}
.editor-content :deep(ul[data-type="taskList"] > li[data-checked="true"] > div p) {
  text-decoration: line-through;
  color: var(--text-muted);
}
/* 复选框跟随文字对齐方式（TextAlign 会把 text-align 写在 p 的内联样式上） */
.editor-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: center"])) {
  justify-content: center;
}
.editor-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: right"])) {
  justify-content: flex-end;
}
/* 居中/右对齐时文字块不撑满，整行才会跟着移动 */
.editor-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: center"]) > div),
.editor-content :deep(ul[data-type="taskList"] > li:has(> div > p[style*="text-align: right"]) > div) {
  flex: 0 1 auto;
}

/* ─── 图片选中框（飞书式：四角圆点 + 四边胶囊手柄）─── */
.img-sel-frame {
  position: fixed;
  z-index: 3000;
  border: 1.5px solid #3370ff;
  pointer-events: none; /* 框本体不挡事件，只有手柄可交互 */
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
}
.img-sel-frame .sel-handle {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
  background: #fff;
  border: 1.5px solid #3370ff;
  box-shadow: 0 1px 4px rgba(51, 112, 255, 0.35);
}
/* 四角：圆点，向外偏移一半，盖在框角上 */
.img-sel-frame .sel-handle-nw,
.img-sel-frame .sel-handle-ne,
.img-sel-frame .sel-handle-sw,
.img-sel-frame .sel-handle-se {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.img-sel-frame .sel-handle-nw { left: -6px; top: -6px; cursor: nwse-resize; }
.img-sel-frame .sel-handle-ne { right: -6px; top: -6px; cursor: nesw-resize; }
.img-sel-frame .sel-handle-sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.img-sel-frame .sel-handle-se { right: -6px; bottom: -6px; cursor: nwse-resize; }
/* 四边：小胶囊，居中在边上 */
.img-sel-frame .sel-handle-n,
.img-sel-frame .sel-handle-s {
  width: 20px;
  height: 7px;
  border-radius: 4px;
  left: calc(50% - 10px);
}
.img-sel-frame .sel-handle-n { top: -4.5px; cursor: ns-resize; }
.img-sel-frame .sel-handle-s { bottom: -4.5px; cursor: ns-resize; }
.img-sel-frame .sel-handle-e,
.img-sel-frame .sel-handle-w {
  width: 7px;
  height: 20px;
  border-radius: 4px;
  top: calc(50% - 10px);
}
.img-sel-frame .sel-handle-e { right: -4.5px; cursor: ew-resize; }
.img-sel-frame .sel-handle-w { left: -4.5px; cursor: ew-resize; }
.img-sel-frame .sel-handle:hover {
  background: #e8f0ff;
}

/* Placeholder */
.editor-content :deep(.is-editor-empty:first-child):before {
  content: attr(data-placeholder);
  float: left;
  color: var(--text-muted);
  pointer-events: none;
  height: 0;
}
</style>

<style>
/* ─── 拖拽重排的全局元素（命令式 createElement 挂在 body 上，scoped 管不到） ─── */

/* 拖拽时跟手的幽灵图 */
.img-drag-ghost {
  position: fixed;
  z-index: 3500;
  transform: translate(-50%, -50%);
  pointer-events: none;
  opacity: 0.75;
  border-radius: var(--r-md, 10px);
  overflow: hidden;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}
.img-drag-ghost img {
  display: block;
  border-radius: var(--r-md, 10px);
}

/* 视频卡片作为拖拽预览时，全局作用域下补齐卡片样式（scoped 样式命中不了 body 下的 ghost） */
.img-drag-ghost .diary-video {
  position: relative;
  width: 100%;
  height: 100%;
  margin: 0;
  border-radius: var(--r-md, 10px);
  overflow: hidden;
  background: #141414;
}
.img-drag-ghost .diary-video .dv-thumb {
  position: absolute;
  inset: 0;
}
.img-drag-ghost .diary-video .dv-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 0;
}
.img-drag-ghost .diary-video .dv-thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
}
.img-drag-ghost .diary-video .dv-play {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.52);
  color: #fff;
  font-size: 18px;
}
.img-drag-ghost .diary-video .dv-name {
  position: absolute;
  left: 8px;
  bottom: 6px;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 10px;
}

/* 落点指示条：竖条 = 插到某张图前/后，横条 = 在某个块前/后换新行 */
.img-drop-indicator {
  position: fixed;
  z-index: 3400;
  pointer-events: none;
  background: #3370ff;
  border-radius: 2px;
  box-shadow: 0 0 6px rgba(51, 112, 255, 0.6);
}
</style>
