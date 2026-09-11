// firebase-config.js — single source of Firebase init for the whole app
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAvBAD9PeHBaxVXT6xBe8l3s35KYqmdvCM",
  authDomain: "roommate-b1018.firebaseapp.com",
  projectId: "roommate-b1018",
  storageBucket: "roommate-b1018.firebasestorage.app",
  messagingSenderId: "413723211610",
  appId: "1:413723211610:web:9c047d5191e18df0dde563",
  measurementId: "G-ESJCWE4L2Q"
};

// Works on GitHub Pages (root or project sub-path) and Firebase Hosting.
export const ROOT_PATH = new URL("..", import.meta.url).href;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Keep Firestore initialization deliberately simple. Optional persistent-cache
// APIs can break an otherwise healthy app in some mobile WebViews, so the app
// uses the standard Firestore instance here. Firebase itself still handles
// transient network state safely.
export const db = getFirestore(app);
