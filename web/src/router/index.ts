import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  // 使用 hash 路由：在 Capacitor/WebView 内不依赖服务端路径回退，
  // 避免登录后 history 跳转失效停在登录页的问题
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/Login.vue') },
    // 家长端
    {
      path: '/parent',
      component: () => import('@/views/parent/Layout.vue'),
      meta: { role: 'parent' },
      children: [
        { path: '', name: 'parent-dashboard', component: () => import('@/views/parent/Dashboard.vue') },
        { path: 'tasks', name: 'parent-tasks', component: () => import('@/views/parent/Tasks.vue') },
        { path: 'tasks/manage', name: 'parent-tasks-manage', component: () => import('@/views/parent/TaskManage.vue') },
        { path: 'points', name: 'parent-points', component: () => import('@/views/parent/Points.vue') },
        { path: 'shop', name: 'parent-shop', component: () => import('@/views/parent/Shop.vue') },
        { path: 'review', name: 'parent-review', component: () => import('@/views/parent/Review.vue') },
        { path: 'growth', name: 'parent-growth', component: () => import('@/views/parent/Growth.vue') },
        { path: 'calendar', name: 'parent-calendar', component: () => import('@/views/parent/Calendar.vue') },
        { path: 'logs', name: 'parent-logs', component: () => import('@/views/parent/Logs.vue') },
      ],
    },
    // 小孩端
    {
      path: '/child',
      component: () => import('@/views/child/Layout.vue'),
      meta: { role: 'child' },
      children: [
        { path: '', name: 'child-home', component: () => import('@/views/child/Home.vue') },
        { path: 'tasks', name: 'child-tasks', component: () => import('@/views/child/Tasks.vue') },
        { path: 'shop', name: 'child-shop', component: () => import('@/views/child/Shop.vue') },
        { path: 'growth', name: 'child-growth', component: () => import('@/views/child/Growth.vue') },
        { path: 'calendar', name: 'child-calendar', component: () => import('@/views/child/Calendar.vue') },
        { path: 'growth/detail', name: 'child-growth-detail', component: () => import('@/views/child/GrowthDetail.vue') },
      ],
    },
    {
      path: '/',
      redirect: () => {
        const auth = useAuthStore();
        if (auth.hasParent) return '/parent';
        if (auth.hasChild) return '/child';
        return '/login';
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/login' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  const role = to.meta.role as 'parent' | 'child' | undefined;

  // 家长和孩子各有一份登录态：进哪个端就用哪份 token
  if (role) {
    if (!auth.activate(role)) return { name: 'login', query: { role } };
    return;
  }

  // 登录页不踢已登录的人：方便在同一个浏览器里再登另一个身份
  if (to.name === 'login') auth.activate(null);
});

export default router;
