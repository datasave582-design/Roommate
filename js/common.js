// common.js — money helpers (integer paise), toast, validation, small UI utils

// ---- Money: always store/compute in integer paise, only format for display ----
export function rupeesToPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
export function paiseToRupees(paise) {
  return (Number(paise) || 0) / 100;
}
export function formatMoney(paise) {
  const rupees = paiseToRupees(paise);
  const sign = rupees < 0 ? "-" : "";
  const abs = Math.abs(rupees);
  return sign + "₹" + abs.toLocaleString("en-IN", { minimumFractionDigits: abs % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

// ---- Toast ----
let toastTimer = null;
export function showToast(msg) {
  let el = document.getElementById("__toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "__toast";
    el.className = "toast hidden";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ---- Friendly error mapping (never expose raw Firebase errors) ----
export function friendlyError(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/user-not-found": "No account found with these details.",
    "auth/wrong-password": "Incorrect password. Please try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "An account already exists with this email.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Please check your connection.",
    "auth/operation-not-allowed": "This account type is not available yet.",
    "auth/admin-restricted-operation": "This action is currently restricted by the Firebase project settings.",
    "permission-denied": "You don't have permission to perform this action.",
    "not-found": "The requested item could not be found."
  };
  return map[code] || "Something went wrong. Please try again.";
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
export function validateMobile(mobile) {
  return /^[6-9]\d{9}$/.test(String(mobile).trim());
}

// ---- Button loading-state guard (prevents duplicate submissions) ----
export function withLoading(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await fn(...args);
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };
}

// ---- Room code generator (client-side proposal; uniqueness enforced server-side via transaction) ----
export function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0,O,1,I)
  let code = "RM-";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

export function formatDate(ts) {
  const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ---- Date <input type="date"> helpers ----
// new Date("YYYY-MM-DD") parses as UTC midnight, which can land on the wrong
// calendar day once converted back to local time for users west of UTC.
// These helpers always work in local time so the date picked is the date saved.
export function dateInputToDate(str) {
  if (!str) return new Date();
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function dateToInputValue(ts) {
  const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- PWA: register service worker + show an install affordance only when the browser actually offers one ----
// Computed from this file's own location (always "<root>/js/common.js" on every
// page) so registration works whether the site is deployed at a domain root or
// under a sub-path (e.g. GitHub Project Pages: username.github.io/repo-name/).
const SITE_ROOT = new URL("..", import.meta.url).href;
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SITE_ROOT + "service-worker.js").catch(() => {});
  });
}
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (sessionStorage.getItem("installPromptDismissed")) return;
  const btn = document.createElement("button");
  btn.textContent = "⬇️ Install App";
  btn.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:90;background:#0F2A47;color:#fff;border:none;border-radius:24px;padding:11px 18px;font-weight:600;font-size:0.85rem;box-shadow:0 6px 16px rgba(0,0,0,0.25);";
  btn.onclick = async () => {
    btn.remove();
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    sessionStorage.setItem("installPromptDismissed", "1");
  };
  document.body.appendChild(btn);
});

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
export function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}


/**
 * Register the PWA service worker from the same app root. Safe to call on
 * every page; browsers reuse an existing registration.
 */
export async function registerServiceWorker(rootPath) {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const swUrl = new URL("service-worker.js", rootPath).href;
    return await navigator.serviceWorker.register(swUrl, { scope: rootPath });
  } catch (err) {
    console.warn("Service worker registration failed:", err);
    return null;
  }
}
