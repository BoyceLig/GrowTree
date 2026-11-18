import Image from '@tiptap/extension-image';

/**
 * 成长日记专用图片节点（飞书风格）。
 *
 * 与官方 Image 的区别：
 *   - inline（行内节点）：连续插入的多张图片共处同一段落，并排/分行展示
 *   - 额外属性：width（单图宽度百分比）、flex（并排行内的排版权重）
 *
 * 并排行的排版全部交给 CSS（见 DiaryTiptapEditor.vue / DiaryTimeline.vue）：
 *   flex-grow: var(--w) + min-width/max-width: calc(var(--w) × 88px/320px)，
 *   flex-wrap 按假设主尺寸自动换行 → 同行等高、多行自适应、顶边对齐。
 *
 * 为什么必须用 NodeView（之前的教训）：
 *   不用 NodeView 时，图片 DOM 由 ProseMirror 直接管理，任何外部样式写入
 *   （布局算法写 flexBasis、选中态加 class…）都会被 PM 的 DOMObserver 当成
 *   「文档被外部改了」→ PM 重绘图片 → 我们的 MutationObserver 又被触发 →
 *   再写样式……实测每秒 120 次重建 <img>，点击/拖拽全部落空。
 *   NodeView 的 ignoreMutation() 返回 true 后，PM 完全忽略我们对自己
 *   DOM 的一切改动，死循环从根上不存在了。
 *
 *   这里刻意用「纯 DOM」NodeView（不引入 Vue 响应式）：
 *   NodeView 内部跑一套独立 Vue 应用在真实浏览器里不可靠（点击选不中、
 *   工具栏不刷新），纯 DOM + 同步方法最稳。
 */
const DiaryImage = Image.extend({
  inline: true,
  group: 'inline',
  // 必须 false：HTML5 draggable 会在 mousedown 后立即 dragstart，
  // 导致 ProseMirror 跳过 click → 图片点不中。
  // 拖拽重定位由编辑器组件用 pointer events 自己实现（见 DiaryTiptapEditor.vue）。
  draggable: false,
  /**
   * 图片不参与 PM 的 NodeSelection：
   * selectable 为 true 时，键盘左/右键经过图片会先「选中图片」再移动，
   * 第一下光标停在图片上（看不见），此时输入会把图片整个替换掉（顶掉）。
   * 选中态由编辑器的 DOM class 自己维护，不需要 PM 的 NodeSelection。
   */
  selectable: false,
  /** 叶子 atom：光标只能停在图片前后，不会进入图片内部 */
  atom: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      /**
       * 上传时的原始文件名。磁盘名是随机 ID，下载时靠它还原成用户认识的名字。
       * 老图片没有这个属性 → 下载时回退到服务端元数据表 / 磁盘名。
       */
      name: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-name') || null,
        renderHTML: (attrs) => (attrs.name ? { 'data-name': attrs.name } : {}),
      },
      /** 宽度百分比（1-100），null = 按原始尺寸 */
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-width') || el.getAttribute('width');
          if (raw) return Number(String(raw).replace('%', '')) || null;
          const styleWidth = (el as HTMLElement).style?.width;
          if (styleWidth && styleWidth.endsWith('%')) return Number(styleWidth.replace('%', '')) || null;
          return null;
        },
        renderHTML: (attrs) => {
          if (!attrs.width) return {};
          return { 'data-width': attrs.width, style: `width:${attrs.width}%` };
        },
      },
      /**
       * 并排行内的排版权重（飞书式拖手柄调出来的「占比」）。
       * 默认 null = 用图片原始宽高比；调整后写成一个具体数值。
       * 展示端（DiaryTimeline）没有 NodeView，直接读 data-flex 属性。
       */
      flex: {
        default: null,
        parseHTML: (el) => {
          const v = Number.parseFloat(el.getAttribute('data-flex') ?? '');
          return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
        },
        renderHTML: (attrs) => {
          if (!attrs.flex) return {};
          return { 'data-flex': attrs.flex };
        },
      },
    };
  },

  addNodeView() {
    return (props: { node: any }) => new ImageShellView(props.node) as any;
  },
});

/** 图片节点外壳 NodeView：span.diary-img-shell > img.diary-inline-image */
class ImageShellView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private node: any;
  private mo: MutationObserver | null = null;
  private moParent: HTMLElement | null = null;

  constructor(node: any) {
    this.node = node;
    this.dom = document.createElement('span');
    this.dom.className = 'diary-img-shell';
    // 外壳不可编辑：浏览器不会把光标停进图片层（否则输入会把图片顶掉）
    this.dom.contentEditable = 'false';
    this.img = document.createElement('img');
    this.img.className = 'diary-inline-image';
    this.img.draggable = false;
    // 图片加载完成后才知道原始宽高比 → 算 --w 权重
    this.img.addEventListener('load', () => {
      this.applyAspect();
      this.applyWeight();
    });
    this.dom.appendChild(this.img);
    this.sync(node);
    // 构造时 dom 还没挂到段落里，父节点要等 PM 插入后才存在
    queueMicrotask(() => this.sync(this.node));
  }

  /** PM 文档变更（含 setNodeMarkup 改 attrs）→ 同步视觉 */
  update(node: any) {
    if (node.type.name !== 'image') return false;
    this.node = node;
    this.sync(node);
    return true;
  }

  /** 关键：PM 忽略 shell 内部的一切 DOM 改动（样式/类名），外部写样式不再触发重绘 */
  ignoreMutation() {
    return true;
  }

  destroy() {
    this.mo?.disconnect();
    this.mo = null;
  }

  private sync(node: any) {
    this.node = node;
    const src = String(node.attrs.src ?? '');
    if (this.img.getAttribute('src') !== src) this.img.setAttribute('src', src);

    // 同段落 ≥ 2 个外壳 → 并排行（flex 布局），否则按单图处理
    const p = this.dom.parentElement;
    const inRow = !!p && (p as HTMLElement).querySelectorAll(':scope > .diary-img-shell').length >= 2;

    // 清掉拖拽缩放预览可能留下的内联布局，回到 CSS 主导
    const s = this.dom.style;
    s.flexGrow = '';
    s.flexBasis = '';
    s.minWidth = '';
    s.maxWidth = '';

    if (inRow) {
      // 并排行：宽度交给 flex（--w 权重），data-width 不生效
      s.width = '';
      this.applyAspect();
      this.applyWeight();
    } else {
      const w = Number(node.attrs.width);
      s.width = Number.isFinite(w) && w > 0 ? `${w}%` : '';
      // 单图不参与行布局，清掉权重避免残留
      s.removeProperty('--w');
      this.applyAspect();
    }

    this.ensureObserver();
  }

  /** --ar = 图片原始宽高比（与用户拖出来的占比 --w 无关）。
   *  编辑器 CSS 用它做换行判据（min-width = --ar × 88px）：
   *  若用 --w 做判据，用户拖出来的大权重会把 min-width 撑到超过行宽，
   *  导致图片在拖拽/保存后意外折行。 */
  private applyAspect() {
    if (this.img.complete && this.img.naturalWidth && this.img.naturalHeight) {
      const ar = Math.round((this.img.naturalWidth / this.img.naturalHeight) * 100) / 100;
      this.dom.style.setProperty('--ar', String(ar));
    }
  }

  /** --w = data-flex 权重；没有则用原始宽高比（加载完成后）。
   *  仅并排行（同段 ≥2 个外壳）有意义；单图清掉，避免残留干扰布局与调试。 */
  private applyWeight() {
    const p = this.dom.parentElement;
    const inRow = !!p && (p as HTMLElement).querySelectorAll(':scope > .diary-img-shell').length >= 2;
    if (!inRow) {
      this.dom.style.removeProperty('--w');
      return;
    }
    const flex = Number.parseFloat(String(this.node.attrs.flex ?? ''));
    let w: number | null = null;
    if (Number.isFinite(flex) && flex > 0) {
      w = Math.round(flex * 100) / 100;
    } else if (this.img.complete && this.img.naturalWidth && this.img.naturalHeight) {
      w = Math.round((this.img.naturalWidth / this.img.naturalHeight) * 100) / 100;
    }
    if (w === null) this.dom.style.removeProperty('--w');
    else this.dom.style.setProperty('--w', String(w));
  }

  /**
   * 监听父段落的 childList：同段图片增删会改变「是否并排行」。
   * 只读 PM 的 DOM（childList），自己的写入都在 shell 内部且被
   * ignoreMutation 覆盖 → 不会形成 PM 重绘回环。
   * PM 复用外壳换段落时（拖拽重排）要跟着换观察对象。
   */
  private ensureObserver() {
    const p = this.dom.parentElement as HTMLElement | null;
    if (!p || this.moParent === p) return;
    this.mo?.disconnect();
    this.mo = new MutationObserver(() => this.sync(this.node));
    this.mo.observe(p, { childList: true });
    this.moParent = p;
  }
}

export default DiaryImage;
