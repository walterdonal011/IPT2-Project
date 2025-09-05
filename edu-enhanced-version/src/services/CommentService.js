// src/services/CommentService.js
import { db, auth } from '@/config/firebaseConfig'
import {
    collection,
    addDoc,
    updateDoc,
    deleteDoc,
    doc,
    onSnapshot,
    query,
    where,
    serverTimestamp,
    orderBy,
    getDocs,
    arrayUnion,
    arrayRemove,
    increment,
} from 'firebase/firestore'

export class CommentService {
    constructor() {
        this.commentsCollection = 'comments'
        this.reactionsCollection = 'reactions'
    }

    // Get comments for a specific post
    getCommentsCollection(postId) {
        return collection(db, 'posts', postId, this.commentsCollection)
    }

    // Get reactions for a specific comment
    getReactionsCollection(postId, commentId) {
        return collection(db, 'posts', postId, this.commentsCollection, commentId, this.reactionsCollection)
    }

    // Add a comment to a post
    async addComment(postId, content, parentCommentId = null) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to comment')
        if (!content.trim()) throw new Error('Comment cannot be empty')

        const commentData = {
            postId,
            parentCommentId, // null for top-level comments
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email,
            photoURL: user.photoURL,
            content: content.trim(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            reactions: {
                like: 0,
                love: 0,
                haha: 0,
                wow: 0,
                sad: 0,
                angry: 0,
            },
            userReactions: {}, // uid -> reaction type
            repliesCount: 0,
        }

        const docRef = await addDoc(this.getCommentsCollection(postId), commentData)
        
        // Update post comment count
        await this.updatePostCommentCount(postId, 1)
        
        return docRef.id
    }

    // Add a reply to a comment
    async addReply(postId, parentCommentId, content) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to reply')
        if (!content.trim()) throw new Error('Reply cannot be empty')

        const replyData = {
            postId,
            parentCommentId,
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email,
            photoURL: user.photoURL,
            content: content.trim(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            reactions: {
                like: 0,
                love: 0,
                haha: 0,
                wow: 0,
                sad: 0,
                angry: 0,
            },
            userReactions: {},
        }

        const docRef = await addDoc(this.getCommentsCollection(postId), replyData)
        
        // Update parent comment replies count
        await this.updateCommentRepliesCount(postId, parentCommentId, 1)
        
        return docRef.id
    }

    // Listen to comments for a post (real-time)
    listenToComments(postId, callback) {
        console.log('Setting up comment listener for post:', postId)
        const q = query(
            this.getCommentsCollection(postId),
            where('parentCommentId', '==', null), // Only top-level comments
            orderBy('createdAt', 'desc')
        )
        
        return onSnapshot(q, (snapshot) => {
            console.log('Comment listener triggered, docs count:', snapshot.docs.length)
            const comments = snapshot.docs.map(doc => {
                const data = doc.data()
                console.log('Comment data:', data)
                return {
                    id: doc.id,
                    ...data,
                    replies: [] // Will be populated separately
                }
            })
            callback(comments)
        }, (error) => {
            console.error('Comment listener error:', error)
        })
    }

    // Listen to replies for a specific comment
    listenToReplies(postId, parentCommentId, callback) {
        console.log('Setting up reply listener for comment:', parentCommentId, 'in post:', postId)
        const q = query(
            this.getCommentsCollection(postId),
            where('parentCommentId', '==', parentCommentId),
            orderBy('createdAt', 'asc')
        )
        
        return onSnapshot(q, (snapshot) => {
            console.log('Reply listener triggered for comment', parentCommentId, 'docs count:', snapshot.docs.length)
            const replies = snapshot.docs.map(doc => {
                const data = doc.data()
                console.log('Reply data:', data)
                return {
                    id: doc.id,
                    ...data
                }
            })
            callback(replies)
        }, (error) => {
            console.error('Reply listener error:', error)
        })
    }

    // Add or update reaction to a comment
    async addReaction(postId, commentId, reactionType) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to react')

        const commentRef = doc(this.getCommentsCollection(postId), commentId)
        const commentDoc = await getDocs(query(this.getCommentsCollection(postId), where('__name__', '==', commentId)))
        
        if (commentDoc.empty) throw new Error('Comment not found')

        const commentData = commentDoc.docs[0].data()
        const currentUserReaction = commentData.userReactions?.[user.uid]

        // If user already reacted with the same type, remove it
        if (currentUserReaction === reactionType) {
            await updateDoc(commentRef, {
                [`reactions.${reactionType}`]: increment(-1),
                [`userReactions.${user.uid}`]: null
            })
        } else {
            // If user had a different reaction, remove it first
            if (currentUserReaction) {
                await updateDoc(commentRef, {
                    [`reactions.${currentUserReaction}`]: increment(-1)
                })
            }
            
            // Add new reaction
            await updateDoc(commentRef, {
                [`reactions.${reactionType}`]: increment(1),
                [`userReactions.${user.uid}`]: reactionType
            })
        }
    }

    // Update post comment count
    async updatePostCommentCount(postId, incrementBy) {
        const postRef = doc(db, 'posts', postId)
        await updateDoc(postRef, {
            commentsCount: increment(incrementBy)
        })
    }

    // Update comment replies count
    async updateCommentRepliesCount(postId, commentId, incrementBy) {
        const commentRef = doc(this.getCommentsCollection(postId), commentId)
        await updateDoc(commentRef, {
            repliesCount: increment(incrementBy)
        })
    }

    // Delete a comment
    async deleteComment(postId, commentId) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to delete')

        const commentRef = doc(this.getCommentsCollection(postId), commentId)
        const commentDoc = await getDocs(query(this.getCommentsCollection(postId), where('__name__', '==', commentId)))
        
        if (commentDoc.empty) throw new Error('Comment not found')
        
        const commentData = commentDoc.docs[0].data()
        
        // Check if user owns the comment
        if (commentData.uid !== user.uid) {
            throw new Error('You can only delete your own comments')
        }

        // If it's a top-level comment, update post comment count
        if (!commentData.parentCommentId) {
            await this.updatePostCommentCount(postId, -1)
        } else {
            // If it's a reply, update parent comment replies count
            await this.updateCommentRepliesCount(postId, commentData.parentCommentId, -1)
        }

        // Delete the comment
        await deleteDoc(commentRef)
    }

    // Update comment content
    async updateComment(postId, commentId, newContent) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to update')

        const commentRef = doc(this.getCommentsCollection(postId), commentId)
        const commentDoc = await getDocs(query(this.getCommentsCollection(postId), where('__name__', '==', commentId)))
        
        if (commentDoc.empty) throw new Error('Comment not found')
        
        const commentData = commentDoc.docs[0].data()
        
        // Check if user owns the comment
        if (commentData.uid !== user.uid) {
            throw new Error('You can only update your own comments')
        }

        await updateDoc(commentRef, {
            content: newContent.trim(),
            updatedAt: serverTimestamp()
        })
    }
}
