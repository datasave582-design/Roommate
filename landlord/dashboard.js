import { auth, ROOT_PATH } from "../js/firebase-config.js";
import { requireAuth, logoutUser, getUserProfile } from "../js/auth.js";
import { formatMoney, showToast, friendlyError, withLoading, escapeHtml, formatDate, monthKey, monthLabel, registerServiceWorker } from "../js/common.js";
import {
  requestJoinRoom, listenRoom, listenMembers, listenExpenses, listenPayments,
  computeBalances, listenSettlements, listenMyNotifications, markNotificationRead, markAllNotificationsRead
} from "../js/room-data.js";
import { onSnapshot, doc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { db } from "../js/firebase-config.js";
import { collection, query, where, onSnapshot as onSnap2 } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
registerServiceWorker(new URL("../", import.meta.url).href);
let currentUser = null, myProfile = null, roomId = null, members = [], expenses = [], payments = [], settlements = [];
let selectedMonth = monthKey();

requireAuth({
  expectedRole: "roommate",
  onReady: async (user, profile) => {
    currentUser = user; myProfile = profile;
    $("loader").classList.add("hidden");
    if (profile.roomId) {
      bootRoom(profile.roomId);
    } else {
      watchForPendingOrApproval();
    }
  }
});

function watchForPendingOrApproval() {
  // Show the join form immediately as the default state so there's no blank
  // flash while we wait for the (usually near-instant) snapshot below to
  // tell us whether a pending request already exists.
  $("joinOverlay").classList.remove("hidden");
  const q = query(collection(db, "joinRequests"), where("uid", "==", currentUser.uid), where("status", "==", "pending"));
  onSnap2(q, (snap) => {
    if (!snap.empty) {
      $("joinOverlay").classList.add("hidden");
      $("pendingOverlay").classList.remove("hidden");
    } else {
      $("pendingOverlay").classList.add("hidden");
      $("joinOverlay").classList.remove("hidden");
    }
  });
  // Watch own profile for roomId appearing after approval
  onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
    const data = snap.data();
    if (data && data.roomId) {
      $("joinOverlay").classList.add("hidden");
      $("pendingOverlay").classList.add("hidden");
      bootRoom(data.roomId);
    }
  });
}

$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await withLoading($("joinBtn"), async () => {
    try {
      await requestJoinRoom(currentUser.uid, $("joinCode").value.trim().toUpperCase());
      showToast("Request sent to Room Admin.");
    } catch (err) {
      const el = $("joinError");
      el.textContent = err.message || friendlyError(err);
      el.classList.remove("hidden");
    }
  })();
});

let booted = false;
function bootRoom(id) {
  if (booted) return;
  booted = true;
  roomId = id;
  $("app").classList.remove("hidden");
  populateMonthSelect();

  listenRoom(roomId, (room) => {
    if (!room) return;
    $("roomNameText").textContent = room.name;
    renderRentInfo(room);
    const h = new Date().getHours();
    $("greetText").textContent = "Hello, " + (myProfile.name || "") + " 👋";
  });
  listenMembers(roomId, (m) => { members = m; recomputeAndRender(); });
  listenMyNotifications(currentUser.uid, renderNotifications);
  listenSettlements(roomId, (list) => { settlements = list; recomputeAndRender(); });
  subscribeMonth(selectedMonth);
}

let unsubExp = null, unsubPay = null;
function subscribeMonth(mk) {
  if (unsubExp) unsubExp();
  if (unsubPay) unsubPay();
  unsubExp = listenExpenses(roomId, mk, (list) => { expenses = list; recomputeAndRender(); });
  unsubPay = listenPayments(roomId, mk, (list) => { payments = list; recomputeAndRender(); });
}
function populateMonthSelect() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = monthKey(d);
    opts.push(`<option value="${mk}">${monthLabel(mk)}</option>`);
  }
  $("expMonthSelect").innerHTML = opts.join("");
  $("expMonthSelect").addEventListener("change", (e) => { selectedMonth = e.target.value; subscribeMonth(selectedMonth); });
}

function recomputeAndRender() {
  if (!members.length) return;
  const active = members.filter(m => m.status === "active");
  const balances = computeBalances(active, expenses, payments, settlements);
  const mine = balances.find(b => b.uid === currentUser.uid) || { share: 0, paid: 0, balance: 0 };
  const totalExpenses = expenses.filter(e => !e.archived).reduce((s, e) => s + e.amountPaise, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amountPaise, 0);

  const balEl = $("myBalance");
  balEl.textContent = mine.balance > 0 ? `+${formatMoney(mine.balance)} Credit` : mine.balance < 0 ? `${formatMoney(Math.abs(mine.balance))} Due` : "✅ Settled";
  balEl.style.color = mine.balance > 0 ? "var(--green)" : mine.balance < 0 ? "var(--red)" : "var(--text)";

  $("statShare").textContent = formatMoney(mine.share);
  $("statMyPaid").textContent = formatMoney(mine.paid);
  $("statRoomExp").textContent = formatMoney(totalExpenses);
  $("statRoomPending").textContent = formatMoney(Math.max(0, totalExpenses - totalPaid));

  const recent = expenses.filter(e => !e.archived).slice(0, 6);
  $("recentExpenses").innerHTML = recent.length ? recent.map(e => `
    <div class="expense-row"><div><div class="expense-title">${escapeHtml(e.title)}</div>
    <div class="expense-meta">${escapeHtml(e.category)} · ${formatDate(e.date)}</div></div>
    <div class="expense-amt">${formatMoney(e.amountPaise)}</div></div>`).join("")
    : `<div class="empty-state"><div class="emoji">📋</div>No expenses yet this month.</div>`;
  $("expensesList").innerHTML = $("recentExpenses").innerHTML;

  $("balanceList").innerHTML = balances.map(b => {
    const pill = b.balance > 0 ? `<span class="pill pill-green">+${formatMoney(b.balance)}</span>` : b.balance < 0 ? `<span class="pill pill-red">${formatMoney(Math.abs(b.balance))}</span>` : `<span class="pill pill-gray">✅</span>`;
    return `<div class="person-row"><div><div class="person-name">${escapeHtml(b.name)}${b.uid === currentUser.uid ? " (You)" : ""}</div>
    <div class="person-meta">Share ${formatMoney(b.share)} · Paid ${formatMoney(b.paid)}</div></div>${pill}</div>`;
  }).join("");

  $("profileCard").innerHTML = `
    <div class="person-row"><div class="person-meta">Name</div><div class="person-name">${escapeHtml(myProfile.name)}</div></div>
    <div class="person-row"><div class="person-meta">Mobile</div><div class="person-name">${escapeHtml(myProfile.phone)}</div></div>
    <div class="person-row"><div class="person-meta">Email</div><div class="person-name">${escapeHtml(myProfile.email)}</div></div>
    <div class="person-row"><div class="person-meta">Role</div><div class="person-name">Roommate</div></div>`;
}

function renderRentInfo(room) {
  $("rentInfo").innerHTML = `
    <div class="person-row"><div class="person-meta">Monthly Rent</div><div class="person-name">${formatMoney(room.monthlyRent || 0)}</div></div>
    <div class="person-row"><div class="person-meta">Due Date</div><div class="person-name">${room.rentDueDate ? room.rentDueDate + " of every month" : "—"}</div></div>`;
}

function renderNotifications(list) {
  const unread = list.filter(n => !n.read).length;
  $("notifDot").classList.toggle("hidden", unread === 0);
  $("notifList").innerHTML = list.length ? list.map(n => `
    <div class="expense-row" data-notif="${n.id}" style="opacity:${n.read ? 0.6 : 1};">
      <div><div class="expense-title">${escapeHtml(n.title)}</div><div class="expense-meta">${escapeHtml(n.message)} · ${formatDate(n.createdAt)}</div></div>
    </div>`).join("") : `<div class="empty-state"><div class="emoji">🔔</div>No notifications</div>`;
  $("notifList").querySelectorAll("[data-notif]").forEach(el => el.onclick = () => markNotificationRead(currentUser.uid, el.dataset.notif));
  window.__latestNotifs = list;
}
$("notifBtn").addEventListener("click", () => $("notifOverlay").classList.remove("hidden"));
$("notifOverlay").addEventListener("click", (e) => { if (e.target.id === "notifOverlay") e.target.classList.add("hidden"); });
$("markAllReadBtn").addEventListener("click", () => markAllNotificationsRead(currentUser.uid, window.__latestNotifs || []));

document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    ["home", "expenses", "balance", "profile"].forEach(t => $("tab-" + t).classList.add("hidden"));
    $("tab-" + item.dataset.tab).classList.remove("hidden");
  });
});
$("logoutBtn").addEventListener("click", async () => { await logoutUser(); window.location.href = ROOT_PATH + "index.html"; });
