/**
 * Tiptap 自定义 Video 节点扩展（缩略图卡片 + 独立播放浮层）。
 *
 * HTML 序列化输出（展示端直接 v-html 渲染）：
 *   <div class="diary-video" data-src="/uploads/xxx.mp4" data-poster="/uploads/xxx-poster.jpg" data-name="xxx.mp4">
 *     <div class="dv-thumb"><img src="…" alt="" /></div>
 *     <button class="dv-play" type="button">▶</button>
 *     <span class="dv-name">xxx.mp4</span>
 *   </div>
 *
 * 编辑器内用 NodeView 渲染同样的结构；上传中额外显示「上传中 xx%」遮罩。
 * 点击播放键不就地播放，而是派发全局事件 diary:play-video，由编辑器/展示端
 * 打开 VideoPlayerModal 独立播放（右上角 X 退出）。
 *
 * 兼容老日记里的 <video src="…"></video>：parseHTML 同时识别 video 标签。
 */
import { Node, mergeAttributes } from '@tiptap/core';

/** 支持的视频类型（与后端上传白名单一致） */
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];

/** 文件是否是支持的视频格式（MIME 可能为空，用扩展名兜底） */
export function isSupportedVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return VIDEO_TYPES.includes(file.type) || VIDEO_EXTS.some((ext) => name.endsWith(ext));
}

/** 不支持时的提示文案 */
export function videoFormatHint(file: File): string {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  const shown = ext || file.type || '该文件';
  return `${shown} 格式暂不支持，请使用 MP4 / WebM / MOV 格式的视频`;
}

/** 解析视频节点的元信息（老 video 标签与新卡片 div 共用） */
function attrFrom(el: HTMLElement, key: string): string | null {
  return el.getAttribute(key);
}

/** 宽度百分比钳制在 5-100，避免出现 0 宽或超出容器的脏值 */
function clampWidth(n: number): number {
  return Math.min(100, Math.max(5, Math.round(n * 10) / 10));
}

/** 生成视频卡片的 HTML 结构（保存到 HTML 的最终形态；上传进度只存在于 NodeView） */
function cardChildren(attrs: Record<string, any>): any[] {
  const poster = String(attrs.poster || '');
  const name = String(attrs.name || '');
  const children: any[] = [
    [
      'div',
      { class: 'dv-thumb' },
      poster
        ? ['img', { src: poster, alt: '', loading: 'lazy' }]
        : ['span', { class: 'dv-thumb-empty' }, '视频'],
    ],
    ['button', { class: 'dv-play', type: 'button', 'aria-label': '播放视频' }, '▶'],
  ];
  if (name) children.push(['span', { class: 'dv-name' }, name]);
  return children;
}

const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  // 不用 HTML5 draggable（会拖出浏览器原生缩略图）；拖拽统一由编辑器
  // 的 pointer events 处理，和图片一致（拖到块上组成表格分栏）。
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {} as Record<string, any>,
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => attrFrom(el as HTMLElement, 'data-src') || attrFrom(el as HTMLElement, 'src'),
        renderHTML: (attrs) => {
          if (!attrs.src) return {};
          return { 'data-src': attrs.src };
        },
      },
      /** 缩略图（上传时本地截帧后作为图片上传得到） */
      poster: {
        default: null,
        parseHTML: (el) => attrFrom(el as HTMLElement, 'data-poster') || attrFrom(el as HTMLElement, 'poster'),
        renderHTML: (attrs) => (attrs.poster ? { 'data-poster': attrs.poster } : {}),
      },
      /** 原始文件名，仅用于卡片展示 */
      name: {
        default: null,
        parseHTML: (el) => attrFrom(el as HTMLElement, 'data-name'),
        renderHTML: (attrs) => (attrs.name ? { 'data-name': attrs.name } : {}),
      },
      /** 显示宽度（容器宽度的百分比，5-100）；空 = 铺满整行 */
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = attrFrom(el as HTMLElement, 'data-width');
          if (raw) {
            const n = Number.parseFloat(raw);
            if (Number.isFinite(n)) return clampWidth(n);
          }
          const styleW = (el as HTMLElement).style?.width || '';
          const m = /([\d.]+)%/.exec(styleW);
          return m ? clampWidth(Number.parseFloat(m[1])) : null;
        },
        renderHTML: (attrs) =>
          attrs.width ? { 'data-width': String(attrs.width), style: `width:${attrs.width}%` } : {},
      },
      /** 水平对齐（和图片的左/中/右一致）；空 = 默认居中 */
      align: {
        default: null,
        parseHTML: (el) => {
          const v = attrFrom(el as HTMLElement, 'data-align');
          return v === 'left' || v === 'center' || v === 'right' ? v : null;
        },
        renderHTML: (attrs) => (attrs.align ? { 'data-align': attrs.align } : {}),
      },
      /** 仅编辑器内部使用：true = 正在上传占位（不写入 HTML） */
      uploading: {
        default: false,
        parseHTML: () => false,
        renderHTML: () => ({}),
      },
      /** 仅编辑器内部使用：上传占位的唯一标识（同名视频并发上传也能对上） */
      tempId: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
      // 兼容老视频节点属性，不再渲染到 HTML
      controls: { default: true, renderHTML: () => ({}) },
      playsinline: { default: true, renderHTML: () => ({}) },
      preload: { default: 'metadata', renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [{ tag: 'div.diary-video' }, { tag: 'video' }];
  },

  renderHTML({ node }) {
    const a = node.attrs || {};
    const attrs = {
      class: 'diary-video',
      'data-src': a.src || '',
      ...(a.poster ? { 'data-poster': a.poster } : {}),
      ...(a.name ? { 'data-name': a.name } : {}),
      // 缩放后的宽度要跟着 HTML 一起存，展示端（v-html）才能保持同样大小
      ...(a.width ? { 'data-width': String(a.width), style: `width:${a.width}%` } : {}),
      ...(a.align ? { 'data-align': a.align } : {}),
    };
    return ['div', mergeAttributes(this.options.HTMLAttributes, attrs), ...cardChildren(a)];
  },

  addNodeView() {
    return (props: { node: any }) => new VideoCardView(props.node) as any;
  },

  addCommands() {
    return {
      setVideo:
        (attributes: { src: string; poster?: string; name?: string; uploading?: boolean; tempId?: string }) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: attributes,
          });
        },
    };
  },
});

/** 视频卡片 NodeView：缩略图 + 播放键；上传中显示进度遮罩 */
class VideoCardView {
  dom: HTMLElement;
  private node: any;

  constructor(node: any) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'diary-video';
    this.render();
    this.dom.addEventListener('click', (e) => {
      const play = (e.target as HTMLElement).closest('.dv-play');
      if (!play) return;
      e.preventDefault();
      e.stopPropagation();
      const src = String(this.node.attrs.src || '');
      if (!src) return;
      window.dispatchEvent(
        new CustomEvent('diary:play-video', {
          detail: { src, poster: String(this.node.attrs.poster || '') },
        })
      );
    });
  }

  update(node: any) {
    if (node.type.name !== 'video') return false;
    this.node = node;
    this.render();
    return true;
  }

  /** 上传进度/遮罩都是外部直接写 DOM，PM 不需要感知 */
  ignoreMutation() {
    return true;
  }

  /** 只拦截播放键，避免点按钮时触发编辑器选中逻辑 */
  stopEvent(e: Event) {
    return !!(e.target as HTMLElement | null)?.closest?.('.dv-play');
  }

  private render() {
    const attrs = this.node.attrs || {};
    const poster = String(attrs.poster || '');
    const name = String(attrs.name || '');
    const uploading = !!attrs.uploading;

    this.dom.dataset.src = String(attrs.src || '');
    if (poster) this.dom.dataset.poster = poster;
    else delete this.dom.dataset.poster;
    if (name) this.dom.dataset.name = name;
    else delete this.dom.dataset.name;

    // 缩放宽度：内联 style 覆盖 CSS 的 width:100%（拖动缩放手柄时也直接写这个）
    const width = attrs.width ? clampWidth(Number.parseFloat(String(attrs.width))) : null;
    if (width) {
      this.dom.dataset.width = String(width);
      this.dom.style.width = `${width}%`;
    } else {
      delete this.dom.dataset.width;
      this.dom.style.width = '';
    }

    // 水平对齐：data-align 交给 CSS 决定左右外边距（空 = 默认居中）
    const align = attrs.align === 'left' || attrs.align === 'right' ? attrs.align : null;
    if (align) this.dom.dataset.align = align;
    else delete this.dom.dataset.align;

    const thumb = document.createElement('div');
    thumb.className = 'dv-thumb';
    if (poster) {
      const img = document.createElement('img');
      img.src = poster;
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      const empty = document.createElement('span');
      empty.className = 'dv-thumb-empty';
      empty.textContent = '视频';
      thumb.appendChild(empty);
    }

    const children: HTMLElement[] = [thumb];
    if (uploading) {
      const mask = document.createElement('div');
      mask.className = 'dv-upload-mask';
      const text = document.createElement('span');
      text.className = 'dv-upload-text';
      text.textContent = '上传中 0%';
      const track = document.createElement('span');
      track.className = 'dv-upload-track';
      const bar = document.createElement('i');
      bar.className = 'dv-progress-bar';
      bar.style.width = '0%';
      track.appendChild(bar);
      mask.append(text, track);
      children.push(mask);
    } else {
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'dv-play';
      play.setAttribute('aria-label', '播放视频');
      play.textContent = '▶';
      children.push(play);
    }
    if (name) {
      const label = document.createElement('span');
      label.className = 'dv-name';
      label.textContent = name;
      children.push(label);
    }

    this.dom.replaceChildren(...children);
  }
}

export default Video;

// 补充类型声明，让 editor.chain().focus().setVideo({ src }) 通过类型检查
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    video: {
      setVideo: (attributes: {
        src: string;
        poster?: string;
        name?: string;
        uploading?: boolean;
        tempId?: string;
      }) => ReturnType;
    };
  }
}