/**
 * Tiptap 自定义 Callout（高亮块）节点扩展。
 *
 * HTML 序列化输出：
 *   <div class="callout" data-emoji="❤️">
 *     <button class="callout-emoji" contenteditable="false">❤️</button>
 *     <div class="callout-content"><p>高亮块内容</p></div>
 *   </div>
 *
 * 点击左边的 emoji 按钮时，编辑器会弹出 EmojiPicker 供切换。
 */
import { Node, mergeAttributes } from '@tiptap/core';

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return {
      HTMLAttributes: {} as Record<string, any>,
    };
  },

  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-emoji') || '💡',
        renderHTML: (attrs) => ({ 'data-emoji': attrs.emoji }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.callout' }];
  },

  renderHTML({ HTMLAttributes }) {
    const emoji = HTMLAttributes['data-emoji'] || '💡';
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, { class: 'callout' }, HTMLAttributes),
      [
        'button',
        {
          class: 'callout-emoji',
          contenteditable: 'false',
          'data-emoji': emoji,
          type: 'button',
        },
        emoji,
      ],
      ['div', { class: 'callout-content' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attributes?: { emoji?: string }) =>
        ({ commands }) => {
          return commands.wrapIn(this.name, attributes);
        },
      toggleCallout:
        (attributes?: { emoji?: string }) =>
        ({ commands }) => {
          return commands.toggleWrap(this.name, attributes);
        },
      updateCalloutEmoji:
        (emoji: string) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, { emoji });
        },
    };
  },
});

export default Callout;

// 类型声明
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attributes?: { emoji?: string }) => ReturnType;
      toggleCallout: (attributes?: { emoji?: string }) => ReturnType;
      updateCalloutEmoji: (emoji: string) => ReturnType;
    };
  }
}
