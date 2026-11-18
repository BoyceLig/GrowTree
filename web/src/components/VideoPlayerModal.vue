<script setup lang="ts">
/**
 * 独立视频播放器浮层。
 *
 * 日记里的视频不再就地用 <video controls> 播放，而是先显示缩略图卡片，
 * 点播放键后用这个黑底浮层独立播放（对应飞书/小红书式的沉浸播放）。
 * 右上角 X / 点击遮罩 / Esc 都可以退出；播放结束后浮层中央给出重播入口。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { downloadMedia } from '@/utils/mediaDownload';

const props = defineProps<{
  modelValue: boolean;
  src: string;
  poster?: string;
  /** 上传时的原始文件名：下载时还原成这个名字（磁盘名是随机 ID） */
  name?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
}>();

const videoEl = ref<HTMLVideoElement | null>(null);
const ended = ref(false);

function close() {
  emit('update:modelValue', false);
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      ended.value = false;
      await nextTick();
      videoEl.value?.play().catch(() => {
        /* 浏览器拦截自动播放时用户点一下原生控件即可 */
      });
    } else {
      const v = videoEl.value;
      if (v) {
        v.pause();
        v.currentTime = 0;
      }
    }
  }
);

function replay() {
  ended.value = false;
  const v = videoEl.value;
  if (!v) return;
  v.currentTime = 0;
  v.play().catch(() => {});
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.modelValue) close();
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="vp-fade">
      <div v-if="modelValue" class="vp-mask" @click.self="close">
        <div class="vp-box" @click.stop>
          <button
            class="vp-dl"
            type="button"
            aria-label="下载视频"
            title="下载视频"
            @click="downloadMedia(src, name)"
          >
            ⬇
          </button>
          <button class="vp-close" type="button" aria-label="关闭视频" @click="close">✕</button>
          <video
            ref="videoEl"
            class="vp-video"
            :src="src"
            :poster="poster || undefined"
            controls
            playsinline
            @ended="ended = true"
          ></video>
          <div v-if="ended" class="vp-ended">
            <button class="vp-replay" type="button" @click="replay">↻ 重新播放</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vp-mask {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-20);
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.vp-box {
  position: relative;
  width: min(880px, 100%);
  border-radius: var(--r-md);
  overflow: hidden;
  background: #000;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}

.vp-video {
  display: block;
  width: 100%;
  max-height: 78vh;
  background: #000;
}

.vp-close {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  width: 34px;
  height: 34px;
  border-radius: var(--r-full);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-fast);
}
.vp-close:hover {
  background: rgba(0, 0, 0, 0.78);
}

/* 下载：在关闭按钮左侧，避免遮挡视频右上角 */
.vp-dl {
  position: absolute;
  top: 10px;
  right: 52px;
  z-index: 2;
  width: 34px;
  height: 34px;
  border-radius: var(--r-full);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 15px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur-fast);
}
.vp-dl:hover {
  background: rgba(0, 0, 0, 0.78);
}

.vp-ended {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
  pointer-events: none;
}
.vp-replay {
  pointer-events: auto;
  padding: 10px 18px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.92);
  color: #1f1f1f;
  font-size: var(--fs-sm);
  font-weight: 600;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.vp-replay:hover {
  background: #fff;
}

.vp-fade-enter-active,
.vp-fade-leave-active {
  transition: opacity 0.2s ease;
}
.vp-fade-enter-from,
.vp-fade-leave-to {
  opacity: 0;
}
</style>