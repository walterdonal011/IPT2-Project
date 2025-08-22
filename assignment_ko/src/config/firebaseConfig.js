import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBASHpXjYy7Jf1RP0hno17ygpZd5yxiax4",
  authDomain: "ipt2-project.firebaseapp.com",
  projectId: "ipt2-project",
  storageBucket: "ipt2-project.firebasestorage.app",
  messagingSenderId: "934693512984",
  appId: "1:934693512984:web:f8f7c051fba532b1c9206d"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Firebase services
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)