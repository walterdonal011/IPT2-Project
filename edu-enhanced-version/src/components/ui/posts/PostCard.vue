<script setup>
import { formatDistanceToNow } from 'date-fns'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { PostService } from '@/services/PostService.js'
import { CommentService } from '@/services/CommentService.js'

const props = defineProps({
    post: { type: Object, required: true },
})

const emit = defineEmits(['visitProfile'])

// Services
const postService = new PostService()
const commentService = new CommentService()
const authStore = useAuthStore()

// Modal state
const showCommentModal = ref(false)
const commentSort = ref('most-relevant')
const newComment = ref('')
const replyingTo = ref(null)
const replyText = ref('')

// Current user from auth store
const currentUser = computed(() => {
    if (!authStore.me) return null
    return {
        name: authStore.me.firstName || authStore.me.lastName
            ? `${authStore.me.firstName || ''} ${authStore.me.lastName || ''}`.trim()
            : authStore.me.displayName || authStore.me.email,
        photoUrl: authStore.me.photoURL || '/default-avatar.png',
        uid: authStore.me.uid,
        email: authStore.me.email
    }
})

// Reactions
const reactionTypes = [
    { type: 'like', label: '👍', color: 'text-blue-600' },
    { type: 'love', label: '❤️', color: 'text-red-500' },
    { type: 'haha', label: '😂', color: 'text-yellow-500' },
    { type: 'wow', label: '😮', color: 'text-purple-500' },
    { type: 'sad', label: '😢', color: 'text-blue-400' },
    { type: 'angry', label: '😡', color: 'text-red-600' },
]

// Post reactions
const userReaction = ref(null)
const reactions = ref(
    props.post.reactions || {
        like: 0,
        love: 0,
        haha: 0,
        wow: 0,
        sad: 0,
        angry: 0,
    },
)

// Comments data
const comments = ref([])
const loading = ref(false)
const unsubscribeComments = ref(null)
const unsubscribeReplies = ref({})

// Computed properties
const sortedComments = computed(() => {
    const sorted = [...comments.value]
    switch (commentSort.value) {
        case 'newest':
            return sorted.sort((a, b) => b.createdAt - a.createdAt)
        case 'oldest':
            return sorted.sort((a, b) => a.createdAt - b.createdAt)
        case 'most-relevant':
        default:
            // Sort by total reactions + replies count
            return sorted.sort((a, b) => {
                const aScore = Object.values(a.reactions).reduce((sum, count) => sum + count, 0) + a.replies.length
                const bScore = Object.values(b.reactions).reduce((sum, count) => sum + count, 0) + b.replies.length
                return bScore - aScore
            })
    }
})

const totalComments = computed(() => {
    return comments.value.length + comments.value.reduce((sum, comment) => sum + comment.replies.length, 0)
})

// Initialize user reaction from post data
watch(() => props.post, (newPost) => {
    if (newPost && newPost.userReactions && currentUser.value) {
        userReaction.value = newPost.userReactions[currentUser.value.uid] || null
    }
    if (newPost && newPost.reactions) {
        reactions.value = newPost.reactions
    }
}, { immediate: true })

// Helper function to initialize comment user reactions
function initializeCommentReactions(comment) {
    if (currentUser.value && comment.userReactions) {
        comment.userReaction = comment.userReactions[currentUser.value.uid] || null
    } else {
        comment.userReaction = null
    }
    return comment
}

// Functions
async function setReaction(type) {
    if (!currentUser.value) return
    
    try {
        await postService.addReaction(props.post.id, type)
        
        // Optimistic update
        if (userReaction.value === type) {
            reactions.value[type]--
            userReaction.value = null
        } else {
            if (userReaction.value) reactions.value[userReaction.value]--
            reactions.value[type]++
            userReaction.value = type
        }
    } catch (error) {
        console.error('Error setting reaction:', error)
    }
}

async function setCommentReaction(commentId, type, isReply = false, parentId = null) {
    if (!currentUser.value) return
    
    try {
        await commentService.addReaction(props.post.id, commentId, type)
        
        // Optimistic update
        const targetComments = isReply ? 
            comments.value.find(c => c.id === parentId)?.replies || [] : 
            comments.value
        
        const comment = targetComments.find(c => c.id === commentId)
        if (!comment) return
        
        if (comment.userReaction === type) {
            comment.reactions[type]--
            comment.userReaction = null
        } else {
            if (comment.userReaction) comment.reactions[comment.userReaction]--
            comment.reactions[type]++
            comment.userReaction = type
        }
    } catch (error) {
        console.error('Error setting comment reaction:', error)
    }
}

function openCommentModal() {
    showCommentModal.value = true
    // Comments are already loaded automatically
}

function closeCommentModal() {
    showCommentModal.value = false
    replyingTo.value = null
    replyText.value = ''
    // Don't clean up listeners since comments should stay loaded
}

async function loadComments() {
    if (loading.value) return
    
    loading.value = true
    try {
        // Listen to top-level comments
        unsubscribeComments.value = commentService.listenToComments(props.post.id, (topLevelComments) => {
            // Filter out optimistic comments and merge with real ones
            const realComments = topLevelComments.map(comment => {
                const processedComment = {
                    ...comment,
                    replies: comment.replies || []
                }
                // Initialize user reaction for each comment
                return initializeCommentReactions(processedComment)
            })
            
            // Keep optimistic comments that aren't yet in real data
            const optimisticComments = comments.value.filter(c => c.isOptimistic)
            const existingRealIds = new Set(realComments.map(c => c.id))
            const stillOptimistic = optimisticComments.filter(c => !existingRealIds.has(c.id))
            
            // Preserve existing replies when updating comments
            const commentsWithPreservedReplies = realComments.map(newComment => {
                const existingComment = comments.value.find(c => c.id === newComment.id && !c.isOptimistic)
                if (existingComment && existingComment.replies) {
                    return {
                        ...newComment,
                        replies: existingComment.replies // Preserve existing replies
                    }
                }
                return newComment
            })
            
            // Merge real comments with still-optimistic ones
            comments.value = [...commentsWithPreservedReplies, ...stillOptimistic]
            
            // Load replies for each real comment automatically (only if not already loaded)
            realComments.forEach(comment => {
                if (!unsubscribeReplies.value[comment.id]) {
                    loadReplies(comment.id)
                }
            })
        })
    } catch (error) {
        console.error('Error loading comments:', error)
    } finally {
        loading.value = false
    }
}

function loadReplies(commentId) {
    if (unsubscribeReplies.value[commentId]) return
    
    unsubscribeReplies.value[commentId] = commentService.listenToReplies(
        props.post.id, 
        commentId, 
        (replies) => {
            const comment = comments.value.find(c => c.id === commentId)
            if (comment) {
                // Preserve optimistic replies when updating
                const optimisticReplies = comment.replies.filter(r => r.isOptimistic)
                const realReplies = replies.map(reply => initializeCommentReactions(reply))
                
                // Merge real replies with optimistic ones
                comment.replies = [...realReplies, ...optimisticReplies]
            }
        }
    )
}

async function submitComment() {
    if (!newComment.value.trim() || !currentUser.value) return
    
    const commentText = newComment.value.trim()
    newComment.value = '' // Clear input immediately for better UX
    
    // Optimistic update - add comment immediately to UI
    const optimisticComment = {
        id: `temp-${Date.now()}`,
        postId: props.post.id,
        parentCommentId: null,
        uid: currentUser.value.uid,
        email: currentUser.value.email,
        displayName: currentUser.value.name,
        photoURL: currentUser.value.photoUrl,
        content: commentText,
        createdAt: new Date(),
        updatedAt: new Date(),
        reactions: {
            like: 0,
            love: 0,
            haha: 0,
            wow: 0,
            sad: 0,
            angry: 0,
        },
        userReactions: {},
        repliesCount: 0,
        replies: [],
        isOptimistic: true,
        userReaction: null // Initialize user reaction
    }
    
    // Add to UI immediately
    comments.value.unshift(optimisticComment)
    
    try {
        const commentId = await commentService.addComment(props.post.id, commentText)
        
        // Create the real comment object to replace the optimistic one
        const realComment = {
            id: commentId,
            postId: props.post.id,
            parentCommentId: null,
            uid: currentUser.value.uid,
            email: currentUser.value.email,
            displayName: currentUser.value.name,
            photoURL: currentUser.value.photoUrl,
            content: commentText,
            createdAt: new Date(), // Will be updated by Firebase
            updatedAt: new Date(),
            reactions: {
                like: 0,
                love: 0,
                haha: 0,
                wow: 0,
                sad: 0,
                angry: 0,
            },
            userReactions: {},
            repliesCount: 0,
            replies: [],
            isOptimistic: false,
            userReaction: null // Initialize user reaction
        }
        
        // Replace optimistic comment with real one immediately
        const optimisticIndex = comments.value.findIndex(c => c.id === optimisticComment.id)
        if (optimisticIndex !== -1) {
            comments.value.splice(optimisticIndex, 1, realComment)
        }
        
    } catch (error) {
        console.error('Error submitting comment:', error)
        // Remove optimistic comment on error
        const index = comments.value.findIndex(c => c.id === optimisticComment.id)
        if (index !== -1) {
            comments.value.splice(index, 1)
        }
        // Restore the comment text
        newComment.value = commentText
    }
}

function startReply(commentId) {
    replyingTo.value = commentId
    replyText.value = ''
}

function cancelReply() {
    replyingTo.value = null
    replyText.value = ''
}

async function submitReply() {
    if (!replyText.value.trim() || !replyingTo.value || !currentUser.value) return
    
    const replyTextValue = replyText.value.trim()
    const parentCommentId = replyingTo.value
    replyText.value = '' // Clear input immediately
    replyingTo.value = null // Close reply form immediately
    
    // Find parent comment
    const parentComment = comments.value.find(c => c.id === parentCommentId)
    if (!parentComment) return
    
    // Optimistic update - add reply immediately to UI
    const optimisticReply = {
        id: `temp-reply-${Date.now()}`,
        postId: props.post.id,
        parentCommentId: parentCommentId,
        uid: currentUser.value.uid,
        email: currentUser.value.email,
        displayName: currentUser.value.name,
        photoURL: currentUser.value.photoUrl,
        content: replyTextValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        reactions: {
            like: 0,
            love: 0,
            haha: 0,
            wow: 0,
            sad: 0,
            angry: 0,
        },
        userReactions: {},
        isOptimistic: true,
        userReaction: null // Initialize user reaction
    }
    
    // Add to UI immediately
    parentComment.replies.push(optimisticReply)
    
    try {
        const replyId = await commentService.addReply(props.post.id, parentCommentId, replyTextValue)
        
        // Create the real reply object to replace the optimistic one
        const realReply = {
            id: replyId,
            postId: props.post.id,
            parentCommentId: parentCommentId,
            uid: currentUser.value.uid,
            email: currentUser.value.email,
            displayName: currentUser.value.name,
            photoURL: currentUser.value.photoUrl,
            content: replyTextValue,
            createdAt: new Date(), // Will be updated by Firebase
            updatedAt: new Date(),
            reactions: {
                like: 0,
                love: 0,
                haha: 0,
                wow: 0,
                sad: 0,
                angry: 0,
            },
            userReactions: {},
            isOptimistic: false,
            userReaction: null // Initialize user reaction
        }
        
        // Replace optimistic reply with real one immediately
        const optimisticIndex = parentComment.replies.findIndex(r => r.id === optimisticReply.id)
        if (optimisticIndex !== -1) {
            parentComment.replies.splice(optimisticIndex, 1, realReply)
        }
        
    } catch (error) {
        console.error('Error submitting reply:', error)
        // Remove optimistic reply on error
        const index = parentComment.replies.findIndex(r => r.id === optimisticReply.id)
        if (index !== -1) {
            parentComment.replies.splice(index, 1)
        }
        // Restore the reply text and form
        replyText.value = replyTextValue
        replyingTo.value = parentCommentId
    }
}

function getTotalReactions(reactions) {
    return Object.values(reactions).reduce((sum, count) => sum + count, 0)
}

function getTopReaction(reactions) {
    const sorted = Object.entries(reactions)
        .filter(([_, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
    
    if (sorted.length === 0) return null
    return reactionTypes.find(r => r.type === sorted[0][0])
}

// Load comments automatically when component mounts
onMounted(() => {
    loadComments()
})

// Cleanup on unmount
onUnmounted(() => {
    if (unsubscribeComments.value) {
        unsubscribeComments.value()
    }
    Object.values(unsubscribeReplies.value).forEach(unsub => unsub())
})
</script>

<template>
    <div class="bg-white rounded-lg shadow overflow-hidden max-w-5xl">
        <!-- Header -->
        <div class="p-4 flex items-start space-x-3">
            <img
                :src="post?.user?.photoUrl || '/default-avatar.png'"
                alt="User avatar"
                class="w-10 h-10 rounded-full object-cover"
            />
            <div class="flex-1">
                <div class="flex items-center justify-between">
                    <div>
                        <h4
                            @click="$emit('visitProfile', post.uid)"
                            class="font-semibold text-gray-800 cursor-pointer hover:underline"
                        >
                            {{
                                post?.user?.firstName || post?.user?.lastName
                                    ? post?.user?.firstName + ' ' + post?.user?.lastName
                                    : post?.user?.displayName || post.displayName || post.email
                            }}
                        </h4>
                        <span class="text-sm text-gray-500">
                            Posted
                            {{
                                formatDistanceToNow(post.createdAt?.toDate?.() || new Date(), {
                                    addSuffix: true,
                                })
                            }}
                        </span>
                    </div>
                    <button class="text-gray-400 hover:text-gray-600" aria-label="More options">
                        ⋮
                    </button>
                </div>
                <!-- Content -->
                <p class="mt-2 text-gray-700">
                    {{ post.content }}
                </p>

                <!-- Reactions / Actions -->
                <div class="mt-4 flex items-center space-x-6 text-gray-600">
                    <!-- Reaction -->
                    <div class="relative group">
                        <button class="flex items-center hover:text-indigo-600">
                            <span v-if="userReaction" class="mr-1">
                                {{ reactionTypes.find((r) => r.type === userReaction)?.label }}
                            </span>
                            <span>{{ userReaction || 'React' }}</span>
                            <span v-if="getTotalReactions(reactions) > 0" class="ml-1"> ({{ getTotalReactions(reactions) }}) </span>
                        </button>

                        <!-- Picker -->
                        <div
                            class="absolute bottom-full mb-2 left-0 bg-white shadow-lg rounded-full px-3 py-2 flex space-x-2 opacity-0 group-hover:opacity-100 transition"
                        >
                            <button
                                v-for="r in reactionTypes"
                                :key="r.type"
                                @click="setReaction(r.type)"
                                class="text-xl hover:scale-125 transition"
                                :class="r.color"
                            >
                                {{ r.label }}
                            </button>
                        </div>
                    </div>

                    <!-- Comment -->
                    <button @click="openCommentModal" class="flex items-center hover:text-indigo-600">
                        💬 Comment ({{ totalComments }})
                    </button>

                    <!-- Share -->
                    <button class="flex items-center hover:text-indigo-600">🔗 Share</button>
                </div>
            </div>
        </div>

        <!-- Comments Preview -->
        <div v-if="comments.length > 0" class="bg-gray-50 border-t px-4 py-3 space-y-2">
            <div
                v-for="comment in comments.slice(0, 2)"
                :key="comment.id"
                class="flex space-x-3"
            >
                <img
                :src="comment.photoURL || comment.user?.photoUrl || '/default-avatar.png'"
                    alt="Commenter"
                    class="w-8 h-8 rounded-full object-cover"
                />
                <div class="flex-1 bg-white p-2 rounded-md shadow">
                    <div class="flex justify-between items-center">
                    <span class="text-sm font-semibold">{{ comment.displayName || comment.user?.name }}</span>
                    <span class="text-xs text-gray-500">
                        {{ formatDistanceToNow(comment.createdAt?.toDate?.() || comment.createdAt, { addSuffix: true }) }}
                    </span>
                </div>
                <p class="text-sm text-gray-700">{{ comment.content || comment.text }}</p>
                    <div v-if="getTotalReactions(comment.reactions) > 0" class="mt-1 flex items-center space-x-1">
                        <span v-if="getTopReaction(comment.reactions)" class="text-sm">
                            {{ getTopReaction(comment.reactions)?.label }}
                        </span>
                        <span class="text-xs text-gray-500">{{ getTotalReactions(comment.reactions) }}</span>
                    </div>
                </div>
            </div>
            <button v-if="comments.length > 2" @click="openCommentModal" class="text-sm text-indigo-600 hover:underline">
                View more comments
            </button>
        </div>
    </div>

    <!-- Comment Modal -->
    <div v-if="showCommentModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <!-- Modal Header -->
            <div class="flex items-center justify-between p-6 border-b border-gray-200 bg-gray-50">
                <div class="flex items-center space-x-3">
                    <div class="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center">
                        <span class="text-white font-bold text-lg">
                            {{ (post?.user?.firstName || post?.user?.displayName || post.displayName || post.email || 'U').charAt(0).toUpperCase() }}
                        </span>
                    </div>
                    <div>
                        <h3 class="text-lg font-semibold text-gray-900">
                            {{ post?.user?.firstName || post?.user?.lastName
                                ? post?.user?.firstName + ' ' + post?.user?.lastName
                                : post?.user?.displayName || post.displayName || post.email }}'s post
                        </h3>
                        <p class="text-sm text-gray-500">Public post</p>
                    </div>
                </div>
                <button @click="closeCommentModal" class="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-gray-600 hover:text-gray-800 transition-colors">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>

            <!-- Original Post Content -->
            <div class="px-6 py-4 border-b border-gray-200 bg-white">
                <div class="flex space-x-3">
                    <img
                        :src="post?.user?.photoUrl || post?.photoURL || '/default-avatar.png'"
                        alt="User avatar"
                        class="w-10 h-10 rounded-full object-cover flex-shrink-0"
                    />
                    <div class="flex-1">
                        <div class="flex items-center space-x-2 mb-2">
                            <span class="font-semibold text-gray-900">
                                {{ post?.user?.firstName || post?.user?.lastName
                                    ? post?.user?.firstName + ' ' + post?.user?.lastName
                                    : post?.user?.displayName || post.displayName || post.email }}
                            </span>
                            <span class="text-sm text-gray-500">
                                {{ formatDistanceToNow(post.createdAt?.toDate?.() || new Date(), {
                                    addSuffix: true,
                                }) }}
                            </span>
                        </div>
                        <p class="text-gray-800 text-sm leading-relaxed mb-3">{{ post.content }}</p>
                    </div>
                </div>
            </div>

            <!-- Post Reactions Summary -->
            <div class="px-6 py-3 border-b border-gray-200 bg-white">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-6">
                        <div class="flex items-center space-x-2">
                            <div class="flex -space-x-1">
                                <div class="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs font-bold">👍</div>
                                <div class="w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold">❤️</div>
                                <div class="w-6 h-6 bg-yellow-500 rounded-full flex items-center justify-center text-white text-xs font-bold">😂</div>
                            </div>
                            <span class="text-sm text-gray-600 font-medium">{{ getTotalReactions(reactions) }}</span>
                        </div>
                        <div class="flex items-center space-x-4 text-sm text-gray-600">
                            <span class="hover:text-blue-600 cursor-pointer hover:underline">{{ totalComments }} comments</span>
                            <span class="hover:text-blue-600 cursor-pointer hover:underline">33 shares</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="px-6 py-2 border-b border-gray-200">
                <div class="flex items-center justify-between text-gray-600">
                    <!-- Like button on the left -->
                    <div class="relative group">
                        <button class="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors">
                            <span v-if="userReaction" class="text-lg">
                                {{ reactionTypes.find((r) => r.type === userReaction)?.label }}
                            </span>
                            <span class="font-medium">{{ userReaction || 'Like' }}</span>
                        </button>
                        <div class="absolute bottom-full mb-2 left-0 bg-white shadow-xl rounded-full px-4 py-2 flex space-x-3 opacity-0 group-hover:opacity-100 transition-all duration-200 border">
                            <button
                                v-for="r in reactionTypes"
                                :key="r.type"
                                @click="setReaction(r.type)"
                                class="text-2xl hover:scale-125 transition-transform duration-150"
                                :class="r.color"
                            >
                                {{ r.label }}
                            </button>
                        </div>
                    </div>
                    
                    <!-- Comment button in the center -->
                    <button class="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M21.99 4c0-1.1-.89-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
                        </svg>
                        <span class="font-medium">Comment</span>
                    </button>
                    
                    <!-- Share button on the right -->
                    <button class="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>
                        </svg>
                        <span class="font-medium">Share</span>
                    </button>
                </div>
            </div>

            <!-- Comment Sorting -->
            <div class="px-6 py-3 border-b border-gray-200 bg-gray-50">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        <svg class="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
                        </svg>
                        <span class="text-sm text-gray-600 font-medium">Sort comments by:</span>
                    </div>
                    <select v-model="commentSort" class="text-sm border border-gray-300 rounded-lg px-3 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                        <option value="most-relevant">Most relevant</option>
                        <option value="newest">Newest</option>
                        <option value="oldest">Oldest</option>
                    </select>
                </div>
            </div>

            <!-- Comments Section -->
            <div class="flex-1 overflow-y-auto bg-gray-50">
                <div class="px-6 py-4 space-y-4">
                    <!-- Loading State -->
                    <div v-if="loading" class="text-center py-12">
                        <div class="inline-flex items-center space-x-2 text-gray-500">
                            <div class="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                            <span>Loading comments...</span>
                        </div>
                    </div>
                    
                    <!-- No Comments State -->
                    <div v-else-if="comments.length === 0" class="text-center py-12">
                        <div class="text-gray-500">
                            <svg class="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
                            </svg>
                            <p class="text-lg font-medium text-gray-700">No comments yet</p>
                            <p class="text-sm text-gray-500">Be the first to share your thoughts!</p>
                        </div>
                    </div>
                    
                    <!-- Comments List -->
                    <div v-else v-for="comment in sortedComments" :key="comment.id" class="space-y-3">
                        <!-- Main Comment -->
                        <div class="flex space-x-3">
                            <div class="flex-shrink-0">
                                <img
                                    :src="comment.photoURL || comment.user?.photoUrl || '/default-avatar.png'"
                                    alt="Commenter"
                                    class="w-10 h-10 rounded-full object-cover"
                                />
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="bg-white rounded-2xl px-4 py-3 shadow-sm border border-gray-200" :class="{ 'opacity-70': comment.isOptimistic }">
                                    <div class="flex items-start justify-between mb-2">
                                        <div class="flex items-center space-x-2">
                                            <span class="font-semibold text-gray-900 text-sm">{{ comment.displayName || comment.user?.name }}</span>
                                            <span v-if="comment.isOptimistic" class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                                <div class="animate-spin rounded-full h-3 w-3 border-b border-blue-600 mr-1"></div>
                                                Posting...
                                            </span>
                                        </div>
                                        <div class="flex items-center space-x-2">
                                            <span class="text-xs text-gray-500">
                                                {{ formatDistanceToNow(comment.createdAt?.toDate?.() || comment.createdAt, { addSuffix: true }) }}
                                            </span>
                                            <button class="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100">
                                                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                                    <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                    <p class="text-gray-800 text-sm leading-relaxed mb-3">{{ comment.content || comment.text }}</p>
                                
                                    <!-- Comment Reactions -->
                                    <div class="flex items-center space-x-6 text-xs">
                                        <div class="relative group">
                                            <button 
                                                @click="setCommentReaction(comment.id, 'like')"
                                                class="flex items-center space-x-2 px-3 py-1.5 rounded-full hover:bg-gray-100 transition-colors"
                                                :class="comment.userReaction ? 'text-blue-600' : 'text-gray-500 hover:text-blue-600'"
                                            >
                                                <span v-if="comment.userReaction" class="text-sm">
                                                    {{ reactionTypes.find((r) => r.type === comment.userReaction)?.label }}
                                                </span>
                                                <span class="font-medium">{{ comment.userReaction || 'Like' }}</span>
                                                <span v-if="getTotalReactions(comment.reactions) > 0" class="text-gray-500">
                                                    {{ getTotalReactions(comment.reactions) }}
                                                </span>
                                            </button>
                                            <div class="absolute bottom-full mb-2 left-0 bg-white shadow-xl rounded-full px-4 py-2 flex space-x-3 opacity-0 group-hover:opacity-100 transition-all duration-200 border">
                                                <button
                                                    v-for="r in reactionTypes"
                                                    :key="r.type"
                                                    @click="setCommentReaction(comment.id, r.type)"
                                                    class="text-xl hover:scale-125 transition-transform duration-150"
                                                    :class="r.color"
                                                >
                                                    {{ r.label }}
                                                </button>
                                            </div>
                                        </div>
                                        <button @click="startReply(comment.id)" class="px-3 py-1.5 rounded-full hover:bg-gray-100 text-gray-500 hover:text-blue-600 font-medium transition-colors">
                                            Reply
                                        </button>
                                        <button class="px-3 py-1.5 rounded-full hover:bg-gray-100 text-gray-500 hover:text-blue-600 font-medium transition-colors">
                                            Share
                                        </button>
                                    </div>
                            </div>

                                <!-- Reply Input -->
                                <div v-if="replyingTo === comment.id" class="mt-3 ml-4">
                                    <div class="flex space-x-3">
                                        <img
                                            :src="currentUser?.photoUrl || '/default-avatar.png'"
                                            alt="Your avatar"
                                            class="w-8 h-8 rounded-full object-cover flex-shrink-0"
                                        />
                                        <div class="flex-1 flex space-x-2">
                                            <input
                                                v-model="replyText"
                                                @keyup.enter="submitReply"
                                                placeholder="Write a reply..."
                                                class="flex-1 text-sm border border-gray-300 rounded-full px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50"
                                            />
                                            <button @click="submitReply" class="px-4 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 text-sm font-medium transition-colors">
                                                Reply
                                            </button>
                                            <button @click="cancelReply" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-full hover:bg-gray-300 text-sm font-medium transition-colors">
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <!-- Replies -->
                                <div v-if="comment.replies.length > 0" class="mt-3 ml-4 space-y-3">
                                    <div v-for="reply in comment.replies" :key="reply.id" class="flex space-x-3">
                                        <img
                                            :src="reply.photoURL || reply.user?.photoUrl || '/default-avatar.png'"
                                            alt="Replier"
                                            class="w-8 h-8 rounded-full object-cover flex-shrink-0"
                                        />
                                        <div class="flex-1 min-w-0">
                                            <div class="bg-gray-100 rounded-2xl px-4 py-3" :class="{ 'opacity-70': reply.isOptimistic }">
                                                <div class="flex items-start justify-between mb-2">
                                                    <div class="flex items-center space-x-2">
                                                        <span class="font-semibold text-gray-900 text-sm">{{ reply.displayName || reply.user?.name }}</span>
                                                        <span v-if="reply.isOptimistic" class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                                            <div class="animate-spin rounded-full h-3 w-3 border-b border-blue-600 mr-1"></div>
                                                            Posting...
                                                        </span>
                                                    </div>
                                                    <span class="text-xs text-gray-500">
                                                        {{ formatDistanceToNow(reply.createdAt?.toDate?.() || reply.createdAt, { addSuffix: true }) }}
                                                    </span>
                                                </div>
                                                <p class="text-gray-800 text-sm leading-relaxed mb-3">{{ reply.content || reply.text }}</p>
                                        
                                                <!-- Reply Reactions -->
                                                <div class="flex items-center space-x-4 text-xs">
                                                    <div class="relative group">
                                                        <button 
                                                            @click="setCommentReaction(reply.id, 'like', true, comment.id)"
                                                            class="flex items-center space-x-2 px-3 py-1.5 rounded-full hover:bg-gray-200 transition-colors"
                                                            :class="reply.userReaction ? 'text-blue-600' : 'text-gray-500 hover:text-blue-600'"
                                                        >
                                                            <span v-if="reply.userReaction" class="text-sm">
                                                                {{ reactionTypes.find((r) => r.type === reply.userReaction)?.label }}
                                                            </span>
                                                            <span class="font-medium">{{ reply.userReaction || 'Like' }}</span>
                                                            <span v-if="getTotalReactions(reply.reactions) > 0" class="text-gray-500">
                                                                {{ getTotalReactions(reply.reactions) }}
                                                            </span>
                                                        </button>
                                                        <div class="absolute bottom-full mb-2 left-0 bg-white shadow-xl rounded-full px-4 py-2 flex space-x-3 opacity-0 group-hover:opacity-100 transition-all duration-200 border">
                                                            <button
                                                                v-for="r in reactionTypes"
                                                                :key="r.type"
                                                                @click="setCommentReaction(reply.id, r.type, true, comment.id)"
                                                                class="text-xl hover:scale-125 transition-transform duration-150"
                                                                :class="r.color"
                                                            >
                                                                {{ r.label }}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <button class="px-3 py-1.5 rounded-full hover:bg-gray-200 text-gray-500 hover:text-blue-600 font-medium transition-colors">
                                                        Reply
                                                    </button>
                                                    <button class="px-3 py-1.5 rounded-full hover:bg-gray-200 text-gray-500 hover:text-blue-600 font-medium transition-colors">
                                                        Share
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Comment Input -->
            <div class="border-t border-gray-200 bg-white p-6">
                <div class="flex space-x-3">
                    <img
                        :src="currentUser?.photoUrl || '/default-avatar.png'"
                        alt="Your avatar"
                        class="w-10 h-10 rounded-full object-cover flex-shrink-0"
                    />
                    <div class="flex-1">
                        <div class="text-sm text-gray-600 mb-2 font-medium">Comment as {{ currentUser?.name || 'Guest' }}</div>
                        <div class="flex space-x-3">
                            <input
                                v-model="newComment"
                                @keyup.enter="submitComment"
                                placeholder="Write a comment..."
                                class="flex-1 border border-gray-300 rounded-full px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50"
                            />
                            <button @click="submitComment" class="px-6 py-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 font-medium transition-colors">
                                Post
                            </button>
                        </div>
                        <div class="flex items-center space-x-6 mt-3 text-gray-500">
                            <button class="flex items-center space-x-2 px-3 py-2 rounded-full hover:bg-gray-100 transition-colors">
                                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                                </svg>
                                <span class="text-sm font-medium">Emoji</span>
                            </button>
                            <button class="flex items-center space-x-2 px-3 py-2 rounded-full hover:bg-gray-100 transition-colors">
                                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                                </svg>
                                <span class="text-sm font-medium">Photo</span>
                            </button>
                            <button class="flex items-center space-x-2 px-3 py-2 rounded-full hover:bg-gray-100 transition-colors">
                                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                                </svg>
                                <span class="text-sm font-medium">GIF</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
