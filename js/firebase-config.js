// firebase-config.js — single source of Firebase init for the whole app
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyAvBAD9PeHBaxVXT6xBe8l3s35KYqmdvCM",
  authDomain: "roommate-b1018.firebaseapp.com",
  projectId: "roommate-b1018",
  storageBucket: "roommate-b1018.firebasestorage.app",
  messagingSenderId: "413723211610",
  appId: "1:413723211610:web:9c047d5191e18df0dde563",
  measurementId: "G-ESJCWE4L2Q"
};

// The site can be deployed at a domain root (e.g. Firebase Hosting) OR under a
// sub-path (e.g. GitHub Project Pages: username.github.io/repo-name/). Every
// redirect in the app must work in both cases, so we compute the project's
// actual root URL here — once — from this file's own location, instead of
// hardcoding "/index.html" style absolute paths anywhere else.
export const ROOT_PATH = new URL("..", import.meta.url).href;

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Offline-capable Firestore cache so PWA has "useful offline experience"
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) })
});

export let analytics = null;
isSupported().then((ok) => { if (ok) analytics = getAnalytics(app); }).catch(() => {});
