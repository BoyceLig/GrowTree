/**
 * 成长日记图片行布局（飞书式自适应多行并排）。
 *
 * 编辑器（DiaryTiptapEditor）与展示端（DiaryTimeline）共用同一套算法：
 * 排版规则分头写两遍，迟早长得不一样。
 *
 * 规则：
 *   - 一个段落里只有图片（ProseMirror 补的 separator 占位图 / <br> 忽略）→ 按「行」排版
 *   - 逐张累加，行高跌破 minHeight 就从这张开始换行 → 多行自适应
 *   - 同一行等高（flex-basis = 权重 × 行高，高度 auto 由宽高比自然得出），顶边对齐
 *   - 权重默认 = 图片原始宽高比；用户拖过边缘调整后 = data-flex 覆盖值（持久化在 HTML 里）
 *   - 行高超过 maxHeight 时封顶，该行不再撑满整宽（顶边靠左，剩余留白）
 */

export interface RowLayoutOptions {
  /** 每行最小高度(px)：再塞一张会让行高低于它就换行 */
  minHeight?: number;
  /** 每行最大高度(px)：单图/少图行封顶，避免一张图占满半屏 */
  maxHeight?: number;
  /** 图间距(px)，与 CSS gap 保持一致 */
  gap?: number;
}

const DEFAULTS: Required<RowLayoutOptions> = {
  minHeight: 88,
  maxHeight: 320,
  gap: 4,
};

/** 判断段落是否是「纯图片段落」，返回真实图片列表；不是则返回 null */
export function rowImagesOf(p: HTMLParagraphElement): HTMLImageElement[] | null {
  const imgs: HTMLImageElement[] = [];
  let hasOther = false;
  for (const el of Array.from(p.children)) {
    if (el.tagName === 'BR') continue;
    if (el.tagName === 'IMG' && el.classList.contains('ProseMirror-separator')) continue;
    if (el instanceof HTMLImageElement) imgs.push(el);
    else hasOther = true;
  }
  // ProseMirror 在相邻原子节点间会塞零宽空格（U+200B），显式清掉再判断有没有真实文字
  const text = (p.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (hasOther || text || imgs.length === 0) return null;
  return imgs;
}

/** 图片的排版权重：data-flex（用户拖出来的）优先，否则用原始宽高比，加载中按 1:1 */
export function imageWeight(img: HTMLImageElement): number {
  const flex = Number.parseFloat(img.dataset.flex ?? '');
  if (Number.isFinite(flex) && flex > 0) return flex;
  if (img.naturalWidth && img.naturalHeight) return img.naturalWidth / img.naturalHeight;
  return 1;
}

/**
 * 对一个段落执行行排版。
 *
 * @returns 是否被识别为图片行（调用方据此 toggle img-row class）
 * 行分配为贪心装箱：从当前行继续累加图片，只要行高 ≥ minHeight 就继续塞，
 * 塞不下就换行。空段落（length 0）不会进这里（rowImagesOf 返回 null）。
 */
export function layoutParagraph(
  p: HTMLParagraphElement,
  opts: RowLayoutOptions = {}
): boolean {
  const { minHeight, maxHeight, gap } = { ...DEFAULTS, ...opts };
  const imgs = rowImagesOf(p);

  if (!imgs) {
    // 不是图片行：清掉可能的残留内联布局（比如用户在图后面敲了字）
    p.querySelectorAll('img').forEach((el) => {
      (el as HTMLImageElement).style.flexBasis = '';
    });
    return false;
  }

  // 单图段落：不做行排版。编辑器里单图是「铺满整行（或按保存的 width%）」，
  // 这里若也走行排版，竖图会被 maxHeight 封顶压成左侧一小条，两端观感不一致；
  // 交给 CSS（max-width:100%）和 renderHTML 写下的内联 width 即可。
  // 注意：data-width 的内联 width 不能清 —— 那是用户拖出来的尺寸，清了就丢。
  if (imgs.length === 1) {
    const img = imgs[0];
    img.style.flexGrow = '';
    img.style.flexBasis = '';
    return false;
  }

  const width = p.clientWidth || 600;
  const weights = imgs.map(imageWeight);

  // 贪心分行
  const rows: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < imgs.length; i++) {
    const trial = [...cur, i];
    const sumW = trial.reduce((acc, idx) => acc + weights[idx], 0);
    const h = (width - gap * (trial.length - 1)) / sumW;
    if (cur.length > 0 && h < minHeight) {
      rows.push(cur);
      cur = [i];
    } else {
      cur = trial;
    }
  }
  if (cur.length) rows.push(cur);

  for (const row of rows) {
    const sumW = row.reduce((acc, idx) => acc + weights[idx], 0);
    let h = (width - gap * (row.length - 1)) / sumW;
    if (h > maxHeight) h = maxHeight;
    for (const idx of row) {
      const img = imgs[idx];
      // 清掉历史遗留的内联样式（旧版写过 flexGrow / width%），统一走 flex-basis
      img.style.flexGrow = '';
      img.style.width = '';
      img.style.flexBasis = `${Math.max(24, Math.round(weights[idx] * h))}px`;
    }
  }
  return true;
}

/**
 * 表格列宽归一化：Tiptap 保存的是 px 列宽（编辑时容器宽度），阅读容器宽度
 * 可能不同。按原比例换成百分比 → 表格始终 100% 铺满、不出现横向滚动。
 */
export function normalizeTableColumns(root: HTMLElement): void {
  root.querySelectorAll<HTMLTableElement>('table.diary-table').forEach((table) => {
    const cols = Array.from(table.querySelectorAll<HTMLElement>('colgroup > col'));
    if (!cols.length) return;
    const widths = cols.map((col) => Number.parseFloat(col.style.width || '') || 0);
    const sum = widths.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) return;
    cols.forEach((col, i) => {
      col.style.width = `${((widths[i] || 0) / sum) * 100}%`;
    });
    // 清掉表格自身的固定宽度/最小宽度，避免小屏溢出
    table.style.width = '';
    table.style.minWidth = '';
  });
}

/** 给根元素下所有段落跑一遍行排版 */
export function layoutAllRows(root: HTMLElement, opts: RowLayoutOptions = {}): void {
  root.querySelectorAll('p').forEach((p) => {
    // 分栏单元格里的单图交给 CSS 满宽显示；只有多图才需要行排版
    const inCell = !!p.closest('td, th');
    const imgs = inCell ? rowImagesOf(p as HTMLParagraphElement) : null;
    if (inCell && (!imgs || imgs.length < 2)) {
      (p as HTMLElement).classList.remove('img-row');
      return;
    }
    const isRow = layoutParagraph(p as HTMLParagraphElement, opts);
    (p as HTMLElement).classList.toggle('img-row', isRow);
  });
  normalizeTableColumns(root);
}

/**
 * 图片未加载完时先挂一次性 load 监听，加载完重排。
 * @param relayout 重排回调（一般就是 layoutAllRows 的防抖版）
 */
export function bindPendingImageLoads(root: HTMLElement, relayout: () => void): void {
  root.querySelectorAll('img').forEach((el) => {
    const img = el as HTMLImageElement;
    if (img.complete && img.naturalWidth) return;
    if (img.dataset.rowLoadBound) return;
    img.dataset.rowLoadBound = '1';
    img.addEventListener('load', relayout, { once: true });
  });
}
