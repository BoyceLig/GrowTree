<script setup lang="ts">
import GlassCard from '@/components/GlassCard.vue';
import ReviewPanel from '@/components/ReviewPanel.vue';

/**
 * 总览页「审核」合并卡片：
 *   心愿单审核 + 原来的右下角审核（商城兑换 / 任务完成）合成一个面板。
 *   每张卡片自带类型标签，历史记录也合并展示。
 */
</script>

<template>
  <GlassCard class="review-center" padding="16px 18px">
    <div class="rc-head">
      <div class="rc-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4h9l3 3v13H7V4h2" />
          <path d="M7 4H5v16h2" />
          <path d="M11 10h6" />
          <path d="M11 14h6" />
          <path d="M11 18h4" />
          <path d="M3 8l2 1" />
        </svg>
      </div>
      <div class="rc-text">
        <div class="rc-title">审核</div>
        <div class="rc-sub">心愿单、商城兑换和任务完成都在这里处理，审核记录自动保留</div>
      </div>
    </div>
    <ReviewPanel embedded />
  </GlassCard>
</template>

<style scoped>
.review-center {
  margin-bottom: var(--space-20);
  border: 1px solid rgba(255, 196, 92, 0.4);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.74), rgba(255, 248, 232, 0.64));
}
.rc-head {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  margin-bottom: var(--space-14);
}
.rc-icon {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  color: var(--text-on-orange);
  background: rgba(255, 180, 84, 0.16);
  border: 1px solid rgba(255, 180, 84, 0.32);
}
.rc-icon svg { width: 22px; height: 22px; }
.rc-text { min-width: 0; }
.rc-title {
  font-family: var(--font-cute);
  font-size: var(--fs-lg);
}
.rc-sub {
  margin-top: var(--space-2);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-muted);
}
</style>
