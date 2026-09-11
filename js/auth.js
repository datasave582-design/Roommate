// auth.js — Firebase Authentication + users/{uid} profile handling
import { auth, db, ROOT_PATH } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/**
 * Register a new user. `role` is written ONCE at account creation and is
 * never editable from the client afterwards (Firestore rules enforce this —
 * see firestore.rules). Selecting a role on the landing page only decides
 * which profile gets created; it grants no privilege by itself.
 */
export async function registerUser({ name, email, mobile, password, role }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  await setDoc(doc(db, "users", cred.user.uid), {
    uid: cred.user.uid,
    name,
    email,
    phone: mobile,
    photoURL: "",
    role,               // roomAdmin | landlord | roommate
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return cred.user;
}

export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logoutUser() {
  await signOut(auth);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Wait for auth state + load profile, then redirect to the correct
 * dashboard for that user's role. Used as a route guard at the top of
 * every protected page.
 */
export function requireAuth({ expectedRole, onReady }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = ROOT_PATH + "index.html";
      return;
    }
    const profile = await getUserProfile(user.uid);
    if (!profile) {
      window.location.href = ROOT_PATH + "index.html";
      return;
    }
    if (expectedRole && profile.role !== expectedRole) {
      // Logged-in user trying to open a dashboard that isn't theirs — bounce
      // them to their actual role's dashboard, never trust the URL.
      const dest = { roomAdmin: "admin/dashboard.html", landlord: "landlord/dashboard.html", roommate: "roommate/dashboard.html" };
      window.location.href = ROOT_PATH + (dest[profile.role] || "index.html");
      return;
    }
    onReady(user, profile);
  });
}
