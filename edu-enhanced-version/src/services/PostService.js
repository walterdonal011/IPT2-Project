// src/services/PostService.js
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
    increment,
    getDoc,
} from 'firebase/firestore'

export class PostService {
    constructor(useNested = false) {
        // Switch between flat or nested collections
        this.useNested = useNested
    }

    // Get reference to the user's posts collection
    getPostsCollection(uid = null) {
        if (this.useNested) {
            const userId = uid || auth.currentUser?.uid
            return collection(db, 'posts', userId, 'userPosts')
        } else {
            return collection(db, 'posts')
        }
    }

    // Create a post
    async create(content) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to post')
        if (!content.trim()) throw new Error('No content')

        return await addDoc(this.getPostsCollection(), {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email,
            photoURL: user.photoURL,
            content: content,
            createdAt: serverTimestamp(),
            reactions: {
                like: 0,
                love: 0,
                haha: 0,
                wow: 0,
                sad: 0,
                angry: 0,
            },
            userReactions: {}, // uid -> reaction type
            commentsCount: 0,
            sharesCount: 0,
        })
    }

    // Update a post
    async update(postId, newContent, uid = null) {
        const ref = this.useNested
            ? doc(db, 'posts', uid || auth.currentUser.uid, 'userPosts', postId)
            : doc(db, 'posts', postId)
        return await updateDoc(ref, { content: newContent })
    }

    // Delete a post
    async delete(postId, uid = null) {
        const ref = this.useNested
            ? doc(db, 'posts', uid || auth.currentUser.uid, 'userPosts', postId)
            : doc(db, 'posts', postId)
        return await deleteDoc(ref)
    }

    // Listen to all posts (real-time)
    listenAll(callback) {
        const q = query(this.getPostsCollection(), orderBy('createdAt', 'desc'))
        return onSnapshot(q, (snapshot) => {
            callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })))
        })
    }

    // Listen only to current user's posts
    listenMine(callback) {
        if (this.useNested) {
            const q = query(this.getPostsCollection(), orderBy('createdAt', 'desc'))
            return onSnapshot(q, (snapshot) => {
                callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })))
            })
        } else {
            const user = auth.currentUser
            const q = query(
                this.getPostsCollection(),
                where('uid', '==', user.uid),
                orderBy('createdAt', 'desc'),
            )
            return onSnapshot(q, (snapshot) => {
                callback(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })))
            })
        }
    }

    // Add reaction to a post
    async addReaction(postId, reactionType) {
        const user = auth.currentUser
        if (!user) throw new Error('You must be logged in to react')

        const postRef = doc(this.getPostsCollection(), postId)
        const postDoc = await getDoc(postRef)
        
        if (!postDoc.exists()) throw new Error('Post not found')

        const postData = postDoc.data()
        const currentUserReaction = postData.userReactions?.[user.uid]

        // If user already reacted with the same type, remove it
        if (currentUserReaction === reactionType) {
            await updateDoc(postRef, {
                [`reactions.${reactionType}`]: increment(-1),
                [`userReactions.${user.uid}`]: null
            })
        } else {
            // If user had a different reaction, remove it first
            if (currentUserReaction) {
                await updateDoc(postRef, {
                    [`reactions.${currentUserReaction}`]: increment(-1)
                })
            }
            
            // Add new reaction
            await updateDoc(postRef, {
                [`reactions.${reactionType}`]: increment(1),
                [`userReactions.${user.uid}`]: reactionType
            })
        }
    }

    // Get post with user details
    async getPostWithUser(postId) {
        const postRef = doc(this.getPostsCollection(), postId)
        const postDoc = await getDoc(postRef)
        
        if (!postDoc.exists()) throw new Error('Post not found')

        const postData = postDoc.data()
        
        // Get user details
        const userRef = doc(db, 'users', postData.uid)
        const userDoc = await getDoc(userRef)
        
        return {
            id: postDoc.id,
            ...postData,
            user: userDoc.exists() ? userDoc.data() : {
                firstName: postData.displayName?.split(' ')[0] || '',
                lastName: postData.displayName?.split(' ').slice(1).join(' ') || '',
                photoUrl: postData.photoURL,
                email: postData.email
            }
        }
    }
}
