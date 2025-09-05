import { auth } from '@/config/firebaseConfig'
import { onAuthStateChanged } from 'firebase/auth'
import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: '/guest',
            name: 'guest',
            component: import('@/layouts/GuestLayout.vue'),
            children: [
                {
                    path: '/login',
                    name: 'login',
                    component: import('@/views/guest/LoginView.vue'),
                },
                {
                    path: '/register',
                    name: 'register',
                    component: import('@/views/guest/RegisterView.vue'),
                },
                {
                    path: '/dog',
                    name: 'dog',
                    component: import('@/views/guest/DogView.vue'),
                },
                {
                    path: '/gender-reveal',
                    name: 'gender.reveal',
                    component: import('@/views/guest/GenderReveal.vue'),
                },
            ],
        },
        {
            path: '/',
            name: 'dashboard',
            component: import('@/layouts/AppLayout.vue'),
            meta: { requiresAuth: true },
            children: [
                {
                    path: '/',
                    name: 'feed',
                    component: import('@/views/authenticated/FeedView.vue'),
                },
                {
                    path: '/communities',
                    name: 'communities',
                    component: import('@/views/authenticated/CommunitiesView.vue'),
                },
                {
                    path: '/profile',
                    name: 'personal.profile',
                    component: import('@/views/authenticated/profile/PersonalProfile.vue'),
                },
                {
                    path: '/profile/:uid',
                    name: 'user.profile',
                    component: () => import('@/views/authenticated/profile/UserProfileView.vue'),
                    props: true, // so you can access uid as a prop inside the component
                    meta: { requiresAuth: true },
                },
            ],
        },

        {
            path: '/page-not-found',
            name: 'page.not.found',
            component: import('@/views/errors/NoPageFound.vue'),
        },
    ],
})

router.beforeEach((to, from, next) => {
    const authStore = useAuthStore()

    if (to.meta.requiresAuth && !authStore.isAuthenticated) {
        next({ name: 'login' })
    } else {
        next()
    }
})

export default router
