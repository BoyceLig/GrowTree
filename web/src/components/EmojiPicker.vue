<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';

/**
 * 飞书风格的 Emoji 选择器。
 * - 顶部搜索框（可过滤）
 * - 中间 emoji 网格（带分类标题）
 * - 底部分类 tab 栏：滚动时自动高亮当前分区，点击可跳转
 * - 左下角 🎲 随机选择一个 emoji
 */
const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
  }>(),
  { modelValue: false }
);

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  select: [emoji: string];
}>();

const search = ref('');
const bodyRef = ref<HTMLElement | null>(null);
const activeCat = ref(0);

// 飞书常用 emoji 分类
const categories = [
  { name: '最近', icon: '🕐', emojis: ['👍','❤️','🎉','⭐','🔥','😂','😍','🤣','😊','🙏','✨','💯','👌','🤔','😅'] },
  { name: '表情', icon: '😀', emojis: [
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙',
    '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥',
    '😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐',
    '😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞',
    '😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖',
    '😺','😸','😹','😻','😼','😽','🙀','😿','😾','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️',
    '💕','💞','💓','💗','💖','💘','💝','💟','💌','💯','💢','💥','💫','💦','💨','🕳️','💣','💬','👁️‍🗨️','🗨️',
  ]},
  { name: '手势', icon: '👍', emojis: [
    '👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍',
    '👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂',
    '🦻','👃','🧠','🦷','🦴','👀','👁️','👅','👄','💋',
  ]},
  { name: '动物', icon: '🐶', emojis: [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆',
    '🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦗','🕷️','🦂','🐢','🐍','🦎','🦖',
    '🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘',
    '🦏','🦛','🐪','🐫','🦙','🦒','🦘','🦡','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🐐','🦌','🐕','🐩','🐈',
  ]},
  { name: '食物', icon: '🍎', emojis: [
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑',
    '🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳',
    '🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘',
    '🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧',
    '🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','☕','🫖',
    '🍵','🍶','🍾','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🫗','🥤','🧋','🧃','🧉','🧊','🥢','🍽️','🍴','🥄',
  ]},
  { name: '旅行', icon: '⚽', emojis: [
    '🗺️','🧭','🏔️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🎡','🎢','🎠','⛲','⛱️','🚗','🚕','🚙','🚌',
    '🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🚏','🛣️','🛤️','🛢️','⛽',
    '🚨','🚥','🚦','🚧','⚓','⛵','🛶','🚤','🛳️','⛴️','🛥️','🚢','✈️','🛩️','🛫','🛬','🪂','💺','🚁','🚟',
    '🚠','🚡','🛰️','🚀','🛸','🌍','🌎','🌏','🌐',
  ]},
  { name: '物品', icon: '🚗', emojis: [
    '⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','💽','💾','💿','📀','📷','📸','📹','🎥','📽️','🎞️','📞','☎️',
    '📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','🎈','🎉','🎊','🎁','🏮','🎀','🪄','🎏',
    '🎐','🧧','🎑','🏳️','🏴','🏁','🚩','🎌','💡','🔦','🕯️','🪔','🧯','🛢️','💸','💵','💴','💶','💷','💰',
    '💳','💎','⚖️','🪜','🧰','🔧','🔨','⚒️','🛠️','⛏️','🔩','⚙️','🪤','🧱','⛓️','🧲','🔫','💣','🧨','🪓',
  ]},
  { name: '符号', icon: '💡', emojis: [
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️',
    '✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐',
    '♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️',
    '㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️',
    '🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️',
  ]},
];

// 搜索过滤
const filteredCategories = computed(() => {
  if (!search.value.trim()) return categories;
  const q = search.value.trim().toLowerCase();
  return categories
    .map((c) => ({ ...c, emojis: c.emojis.filter((e) => e.toLowerCase().includes(q)) }))
    .filter((c) => c.emojis.length > 0);
});

// 滚动监听：根据各分类标题相对滚动容器的位置，自动高亮当前分区 tab
let rafId = 0;

function onBodyScroll() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const body = bodyRef.value;
    if (!body) return;
    const bodyTop = body.getBoundingClientRect().top;
    const sections = body.querySelectorAll<HTMLElement>('.ep-section');
    let active = 0;
    sections.forEach((el, i) => {
      if (el.getBoundingClientRect().top - bodyTop <= 8) active = i;
    });
    activeCat.value = active;
  });
}

// 点击底部 tab 跳转到对应分类
function scrollToCat(idx: number) {
  if (search.value) {
    // 搜索状态下分区被过滤，先清空搜索恢复完整分类再跳转
    search.value = '';
    nextTick(() => {
      const el = bodyRef.value?.querySelectorAll<HTMLElement>('.ep-section')[idx];
      if (el) doScrollTo(el);
    });
    return;
  }
  const el = bodyRef.value?.querySelectorAll<HTMLElement>('.ep-section')[idx];
  if (el) doScrollTo(el);
}

// 精确计算目标分类相对滚动容器的偏移
function doScrollTo(el: HTMLElement) {
  const body = bodyRef.value;
  if (!body) return;
  const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  activeCat.value = Number(el.dataset.index) || 0;
}

// 随机选择一个 emoji
function pickRandom() {
  const all = categories.flatMap((c) => c.emojis);
  const emoji = all[Math.floor(Math.random() * all.length)];
  emit('select', emoji);
  emit('update:modelValue', false);
  search.value = '';
}

function pick(emoji: string) {
  emit('select', emoji);
  emit('update:modelValue', false);
  search.value = '';
}

function close() {
  emit('update:modelValue', false);
  search.value = '';
}

// 搜索过滤后分区数量变化，重置高亮并回到顶部
watch(search, () => {
  activeCat.value = 0;
  bodyRef.value?.scrollTo({ top: 0 });
});

onMounted(() => {
  bodyRef.value?.addEventListener('scroll', onBodyScroll, { passive: true });
});
onBeforeUnmount(() => {
  bodyRef.value?.removeEventListener('scroll', onBodyScroll);
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <div v-if="modelValue" class="emoji-picker" @click.stop>
    <!-- 顶部搜索框 + 随机 + 关闭 -->
    <div class="ep-search">
      <span class="ep-icon">🔍</span>
      <input v-model="search" class="ep-input" placeholder="搜索" @click.stop />
      <button type="button" class="ep-close" title="关闭" @click="close">✕</button>
      <button type="button" class="ep-random" title="随机选一个" @click="pickRandom">🎲</button>
    </div>

    <!-- emoji 网格区（可滚动） -->
    <div ref="bodyRef" class="ep-body">
      <section
        v-for="(cat, idx) in filteredCategories"
        :key="cat.name"
        class="ep-section"
        :data-index="idx"
      >
        <div class="ep-cat">{{ cat.name }}</div>
        <div class="ep-grid">
          <button
            v-for="e in cat.emojis"
            :key="e"
            type="button"
            class="ep-emoji"
            @click="pick(e)"
          >{{ e }}</button>
        </div>
      </section>
      <div v-if="!filteredCategories.length" class="ep-empty">没有找到相关 emoji</div>
    </div>

    <!-- 底部分类 tab 栏 -->
    <div class="ep-tabs">
      <button
        v-for="(cat, idx) in categories"
        :key="cat.name"
        type="button"
        class="ep-tab"
        :class="{ on: activeCat === idx }"
        :title="cat.name"
        @click="scrollToCat(idx)"
      >{{ cat.icon }}</button>
    </div>
  </div>
</template>

<style scoped>
.emoji-picker {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  width: 340px;
  height: 360px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(16px);
  z-index: 100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 搜索框 */
.ep-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}
.ep-icon { font-size: 14px; flex-shrink: 0; }
.ep-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--fs-sm);
  font-family: inherit;
}
.ep-close {
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  border-radius: var(--r-sm);
  font-size: 12px; color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--dur-fast);
}
.ep-close:hover { background: rgba(0,0,0,0.06); color: var(--text-primary); }

/* emoji 网格区 */
.ep-body {
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 8px 8px;
  flex: 1;
  min-height: 0;
  position: relative;
  scroll-behavior: smooth;
}
.ep-section {
  display: block;
}
.ep-cat {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  padding: 10px 4px 6px;
  font-weight: 600;
  position: sticky;
  top: 0;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(8px);
  z-index: 1;
}
.ep-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}
.ep-emoji {
  width: 100%;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  border-radius: var(--r-sm);
  background: transparent;
  border: none;
  transition: background var(--dur-fast), transform var(--dur-fast);
  cursor: pointer;
}
.ep-emoji:hover {
  background: rgba(255, 209, 102, 0.35);
  transform: scale(1.1);
}
.ep-empty {
  text-align: center;
  padding: 24px;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

/* 底部分类 tab 栏 */
.ep-tabs {
  display: flex;
  align-items: center;
  padding: 6px 6px;
  border-top: 1px solid var(--glass-border);
  background: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
  overflow: hidden;
}
.ep-tab {
  flex: 1 1 0;
  min-width: 0;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  border: none;
  background: transparent;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all var(--dur-fast);
}
.ep-tab:hover { background: rgba(0,0,0,0.06); }
.ep-tab.on {
  background: rgba(255, 209, 102, 0.45);
  box-shadow: 0 0 0 1px var(--accent-yellow);
}

/* 随机按钮（搜索框右侧） */
.ep-random {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  cursor: pointer;
  transition: transform var(--dur-fast), background var(--dur-fast);
}
.ep-random:hover {
  background: rgba(255, 209, 102, 0.35);
  transform: rotate(-20deg) scale(1.1);
}
</style>
