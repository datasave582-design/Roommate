import { auth, ROOT_PATH } from "../js/firebase-config.js";
import { requireAuth, logoutUser } from "../js/auth.js";
import {
  formatMoney, rupeesToPaise, showToast, friendlyError, withLoading,
  escapeHtml, formatDate, monthKey, monthLabel, dateInputToDate, dateToInputValue, registerServiceWorker
} from "../js/common.js";
import {
  DEFAULT_CATEGORIES, createRoom, getRoomById, listenRoom,
  requestLandlordConnection, listenMyLandlordRequest, attachLandlordToRoom,
  listenMembers, listenPendingRequests, approveJoinRequest, rejectJoinRequest, setMemberStatus,
  listenCategories, addCustomCategory,
  addExpense, updateExpense, archiveExpense, deleteExpense, listenExpenses,
  addPayment, listenPayments,
  computeBalances, suggestSettlements, recordSettlement, listenSettlements,
  listenMyNotifications, markNotificationRead, markAllNotificationsRead, notifyRoom
} from "../js/room-data.js";

const $ = (id) => document.getElementById(id);
registerServiceWorker(new URL("../", import.meta.url).href);
let currentUser = null, currentProfile = null, roomId = null, roomData = null;
let members = [], categories = [...DEFAULT_CATEGORIES], expenses = [], payments = [], settlements = [];
let selectedMonth = monthKey();

requireAuth({
  expectedRole: "roomAdmin",
  onReady: async (user, profile) => {
    currentUser = user;
    currentProfile = profile;
    $("loader").classList.add("hidden");
    try {
      const room = profile?.roomId ? await getRoomById(profile.roomId) : null;
      listenMyLandlordRequest(user.uid, (req) => {
        if (req?.status === "approved" && currentProfile?.landlordConnectionStatus !== "approved") {
          location.reload();
          return;
        }
        renderLandlordConnection(req, room);
      });
      if (!room) {
        $("createRoomOverlay").classList.remove("hidden");
        renderLandlordConnection(null, null);
      } else {
        if (profile?.landlordUid && !room.landlordUid) {
          try { await attachLandlordToRoom(room.id, user.uid, profile.landlordUid); room.landlordUid = profile.landlordUid; } catch (e) { console.error(e); }
        }
        if (room.landlordUid) $("landlordBadge").textContent = "🏠 Makan Malik connected";
        else $("landlordBadge").textContent = "🏠 Connect Makan Malik";
        $("landlordBadge").style.cursor = room.landlordUid ? "default" : "pointer";
        bootRoom(room.id);
      }
    } catch (err) {
      $("loader").classList.remove("hidden");
      $("loader").innerHTML = `<div style="padding:24px;text-align:center;color:var(--red,#c0392b);">
        Couldn't load your room. ${escapeHtml(friendlyError(err))}<br><br>
        <button class="btn btn-primary" style="width:auto;padding:10px 20px;" onclick="location.reload()">Retry</button>
      </div>`;
    }
  }
});

function renderLandlordConnection(req, room) {
  const connected = currentProfile?.landlordConnectionStatus === "approved" && currentProfile?.landlordUid;
  if (connected) {
    $("landlordConnectStatus").innerHTML = "✅ <b>Makan Malik approved.</b> You can create/manage the room.";
    if (!room) $("createRoomSection").classList.remove("hidden");
    else $("createRoomSection").classList.add("hidden");
    return;
  }
  $("createRoomSection").classList.add("hidden");
  if (req?.status === "pending") {
    $("landlordConnectStatus").innerHTML = "⏳ Approval request sent. Waiting for Makan Malik.";
  } else if (req?.status === "rejected") {
    $("landlordConnectStatus").innerHTML = "❌ Request rejected. You can send another request with the correct code.";
  } else {
    $("landlordConnectStatus").textContent = "No Makan Malik approval yet.";
  }
}

$("landlordBadge").addEventListener("click", () => {
  if (!roomId || !roomData?.landlordUid) {
    $("createRoomOverlay").classList.remove("hidden");
    renderLandlordConnection(null, roomData);
  }
});

$("connectLandlordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await withLoading($("connectLandlordBtn"), async () => {
    try {
      await requestLandlordConnection(currentUser.uid, $("landlordCodeInput").value.trim());
      showToast("Request sent to Makan Malik.");
    } catch (err) { showToast(friendlyError(err)); }
  })();
});

$("createRoomForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await withLoading($("crBtn"), async () => {
    try {
      const id = await createRoom(currentUser.uid, {
        name: $("crName").value.trim(),
        flatNumber: $("crFlat").value.trim(),
        address: $("crAddress").value.trim(),
        city: $("crCity").value.trim(),
        rent: rupeesToPaise($("crRent").value || 0),
        dueDate: $("crDueDate").value ? Number($("crDueDate").value) : null,
        description: $("crDesc").value.trim(),
        landlordUid: currentProfile?.landlordUid || null
      });
      $("createRoomOverlay").classList.add("hidden");
      bootRoom(id);
    } catch (err) {
      showToast(friendlyError(err));
    }
  })();
});

function bootRoom(id) {
  roomId = id;
  $("app").classList.remove("hidden");
  populateMonthSelects();

  listenRoom(roomId, (room) => {
    roomData = room;
    if (!room) return;
    $("roomNameText").textContent = room.name;
    $("roomCodeText").textContent = room.code;
    $("landlordBadge").textContent = room.landlordUid ? "🏠 Makan Malik connected" : "🏠 Makan Malik not connected";
    const h = new Date().getHours();
    $("greetText").textContent = (h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening") + ", " + (auth.currentUser.displayName || "Admin") + " 👋";
  });

  listenMembers(roomId, (m) => { members = m; renderRoommates(); renderExpenseForm(); recomputeAndRender(); });
  listenPendingRequests(roomId, (reqs) => renderJoinRequests(reqs));
  listenCategories(roomId, (custom) => { categories = [...DEFAULT_CATEGORIES, ...custom]; renderCategoryChips(); });
  listenMyNotifications(currentUser.uid, (list) => renderNotifications(list));
  listenSettlements(roomId, (list) => { settlements = list; renderSettlementHistory(); });

  subscribeMonth(selectedMonth);
}

let unsubExp = null, unsubPay = null;
function subscribeMonth(mk) {
  if (unsubExp) unsubExp();
  if (unsubPay) unsubPay();
  unsubExp = listenExpenses(roomId, mk, (list) => { expenses = list; recomputeAndRender(); });
  unsubPay = listenPayments(roomId, mk, (list) => { payments = list; recomputeAndRender(); });
}

function populateMonthSelects() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = monthKey(d);
    opts.push(`<option value="${mk}">${monthLabel(mk)}</option>`);
  }
  $("monthSelect").innerHTML = opts.join("");
  $("expMonthSelect").innerHTML = opts.join("");
  [$("monthSelect"), $("expMonthSelect")].forEach(sel => {
    sel.addEventListener("change", (e) => {
      selectedMonth = e.target.value;
      [$("monthSelect"), $("expMonthSelect")].forEach(s => s.value = selectedMonth);
      subscribeMonth(selectedMonth);
    });
  });
}

// ================= HOME =================
function recomputeAndRender() {
  if (!members.length) return;
  const activeMembers = members.filter(m => m.status === "active");
  const balances = computeBalances(activeMembers, expenses, payments, settlements);
  const totalExpenses = expenses.filter(e => !e.archived).reduce((s, e) => s + e.amountPaise, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amountPaise, 0);
  const pending = Math.max(0, totalExpenses - totalPaid);

  $("statExpenses").textContent = formatMoney(totalExpenses);
  $("statMembers").textContent = activeMembers.length;
  $("statPaid").textContent = formatMoney(totalPaid);
  $("statPending").textContent = formatMoney(pending);
  $("monthLabelText").textContent = monthLabel(selectedMonth);

  if (!balances.length) {
    $("whoOwesList").innerHTML = emptyState("👥", "No roommates yet", "Share your room code to add roommates.");
  } else {
    $("whoOwesList").innerHTML = balances.map(personRowHtml).join("");
  }

  const recent = expenses.filter(e => !e.archived).slice(0, 5);
  $("recentExpenses").innerHTML = recent.length ? recent.map(expenseRowHtml).join("")
    : emptyState("📋", "No expenses yet", "Tap + to add your first expense.");

  renderExpensesTab();
  renderBalanceTab(balances);
}

function personRowHtml(b) {
  const pill = b.balance > 0 ? `<span class="pill pill-green">+${formatMoney(b.balance)} Credit</span>`
    : b.balance < 0 ? `<span class="pill pill-red">${formatMoney(Math.abs(b.balance))} Due</span>`
    : `<span class="pill pill-gray">✅ Settled</span>`;
  return `<div class="person-row">
    <div><div class="person-name">${escapeHtml(b.name)}</div>
    <div class="person-meta">Share ${formatMoney(b.share)} · Paid ${formatMoney(b.paid)}</div></div>
    ${pill}
  </div>`;
}
function expenseRowHtml(e) {
  return `<div class="expense-row" data-id="${e.id}">
    <div><div class="expense-title">${escapeHtml(e.title)}</div>
    <div class="expense-meta">${escapeHtml(e.category)} · ${escapeHtml(memberName(e.paidBy))} · ${formatDate(e.date)}</div></div>
    <div class="expense-amt">${formatMoney(e.amountPaise)}</div>
  </div>`;
}
function memberName(uid) {
  const m = members.find(x => x.uid === uid);
  return m ? m.profile.name : "—";
}
function emptyState(emoji, title, sub) {
  return `<div class="empty-state"><div class="emoji">${emoji}</div><div style="font-weight:600;color:var(--text);margin-bottom:4px;">${title}</div><div>${sub}</div></div>`;
}

// ================= EXPENSES TAB =================
let activeCategoryFilter = null;
function renderExpensesTab() {
  $("expCategoryFilter").innerHTML = ["All", ...new Set(expenses.map(e => e.category))].map(c =>
    `<div class="chip ${((c === "All" && !activeCategoryFilter) || c === activeCategoryFilter) ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</div>`
  ).join("");
  $("expCategoryFilter").querySelectorAll(".chip").forEach(chip => {
    chip.onclick = () => { activeCategoryFilter = chip.dataset.cat === "All" ? null : chip.dataset.cat; renderExpensesTab(); };
  });

  let list = expenses.filter(e => !e.archived);
  if (activeCategoryFilter) list = list.filter(e => e.category === activeCategoryFilter);
  const sort = $("expSort").value;
  list = [...list].sort((a, b) => {
    if (sort === "oldest") return a.date?.seconds - b.date?.seconds;
    if (sort === "highest") return b.amountPaise - a.amountPaise;
    if (sort === "lowest") return a.amountPaise - b.amountPaise;
    return b.date?.seconds - a.date?.seconds;
  });
  $("expensesList").innerHTML = list.length ? list.map(e => `
    <div class="expense-row" data-id="${e.id}">
      <div><div class="expense-title">${escapeHtml(e.title)}</div>
      <div class="expense-meta">${escapeHtml(e.category)} · ${escapeHtml(memberName(e.paidBy))} · ${formatDate(e.date)}</div></div>
      <div style="text-align:right;">
        <div class="expense-amt">${formatMoney(e.amountPaise)}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button class="btn-text" style="padding:2px;font-size:0.75rem;" data-edit="${e.id}">Edit</button>
          <button class="btn-text danger-text" style="padding:2px;font-size:0.75rem;" data-remove="${e.id}">Remove</button>
        </div>
      </div>
    </div>`).join("") : emptyState("📋", "No expenses found", "Try a different filter or month.");

  $("expensesList").querySelectorAll("[data-remove]").forEach(btn => {
    btn.onclick = () => confirmAction("Remove this expense?", "This will permanently remove the expense from the room. This action cannot be undone.", async () => {
      await deleteExpense(roomId, btn.dataset.remove, currentUser.uid);
      showToast("Expense removed.");
    });
  });
  $("expensesList").querySelectorAll("[data-edit]").forEach(btn => {
    btn.onclick = () => {
      const exp = expenses.find(x => x.id === btn.dataset.edit);
      if (exp) openExpenseForm(exp);
    };
  });
}
$("expSort").addEventListener("change", renderExpensesTab);

// ================= ROOMMATES TAB =================
function renderJoinRequests(reqs) {
  if (!reqs.length) { $("joinRequestsWrap").innerHTML = ""; return; }
  $("joinRequestsWrap").innerHTML = `<div class="section-title" style="margin-top:0;">🔔 New Requests</div>` +
    reqs.map(r => `
    <div class="card row" data-req="${r.id}">
      <div><div class="person-name">${escapeHtml(r.user?.name || "Unknown")}</div><div class="person-meta">${escapeHtml(r.user?.phone || "")}</div></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline" style="width:auto;padding:8px 14px;" data-reject="${r.id}">Reject</button>
        <button class="btn btn-primary" style="width:auto;padding:8px 14px;" data-approve="${r.id}" data-uid="${r.uid}">Accept</button>
      </div>
    </div>`).join("");
  $("joinRequestsWrap").querySelectorAll("[data-approve]").forEach(btn => {
    btn.onclick = async () => { await approveJoinRequest(btn.dataset.approve, roomId, btn.dataset.uid); showToast("Roommate approved."); };
  });
  $("joinRequestsWrap").querySelectorAll("[data-reject]").forEach(btn => {
    btn.onclick = async () => { await rejectJoinRequest(btn.dataset.reject); showToast("Request rejected."); };
  });
}

function renderRoommates() {
  const list = members.filter(m => m.role !== "admin");
  $("membersList").innerHTML = list.length ? list.map(m => `
    <div class="person-row">
      <div><div class="person-name">${escapeHtml(m.profile.name)}</div>
      <div class="person-meta">${escapeHtml(m.profile.phone || "")} · Joined ${formatDate(m.joinedAt)}</div></div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="pill ${m.status === "active" ? "pill-green" : "pill-gray"}">${m.status === "active" ? "Active" : "Inactive"}</span>
        ${m.status === "active" ? `<button class="btn-text" data-deactivate="${m.uid}">Remove</button>` : ""}
      </div>
    </div>`).join("") : emptyState("👥", "No roommates yet", "Share your room code to get started.");
  $("membersList").querySelectorAll("[data-deactivate]").forEach(btn => {
    btn.onclick = () => confirmAction("Remove this roommate?", "Their financial history will be kept, but they'll lose access to the room.", async () => {
      await setMemberStatus(roomId, btn.dataset.deactivate, "inactive");
      showToast("Roommate removed.");
    });
  });
}
$("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(roomData?.code || "").then(() => showToast("Room code copied."));
});

// ================= BALANCE TAB =================
function renderBalanceTab(balances) {
  $("balanceList").innerHTML = balances.length ? balances.map(personRowHtml).join("") : emptyState("💰", "No balances yet", "");
  const transfers = suggestSettlements(balances);
  $("settlementsList").innerHTML = transfers.length ? transfers.map((t, i) => `
    <div class="person-row">
      <div class="person-meta" style="font-size:0.88rem;color:var(--text);"><b>${escapeHtml(t.fromName)}</b> → <b>${escapeHtml(t.toName)}</b> ${formatMoney(t.amountPaise)}</div>
      <button class="btn btn-outline" style="width:auto;padding:7px 12px;" data-settle="${i}">Mark Completed</button>
    </div>`).join("") : emptyState("✅", "All settled up", "No pending transfers this month.");
  $("settlementsList").querySelectorAll("[data-settle]").forEach(btn => {
    btn.onclick = async () => {
      const t = transfers[Number(btn.dataset.settle)];
      await recordSettlement(roomId, currentUser.uid, { fromUid: t.fromUid, toUid: t.toUid, amountPaise: t.amountPaise, note: `${t.fromName} to ${t.toName}` });
      showToast("Settlement recorded.");
    };
  });
}
function renderSettlementHistory() {
  $("settlementHistory").innerHTML = settlements.length ? settlements.map(s => `
    <div class="expense-row"><div><div class="expense-title">${escapeHtml(memberName(s.fromUid))} → ${escapeHtml(memberName(s.toUid))}</div>
    <div class="expense-meta">${formatDate(s.date)} · ✅ Completed</div></div><div class="expense-amt">${formatMoney(s.amountPaise)}</div></div>`).join("")
    : emptyState("💸", "No settlements yet", "");
}

// ================= TAB NAV =================
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    if (item.dataset.tab === "add") { $("addChoiceOverlay").classList.remove("hidden"); return; }
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    ["home", "expenses", "roommates", "balance"].forEach(t => $("tab-" + t).classList.add("hidden"));
    $("tab-" + item.dataset.tab).classList.remove("hidden");
  });
});
$("fabAdd").addEventListener("click", () => $("addChoiceOverlay").classList.remove("hidden"));
$("choiceExpense").addEventListener("click", () => { $("addChoiceOverlay").classList.add("hidden"); openExpenseForm(); });
$("choicePayment").addEventListener("click", () => { $("addChoiceOverlay").classList.add("hidden"); openPaymentForm(); });
$("addChoiceOverlay").addEventListener("click", (e) => { if (e.target.id === "addChoiceOverlay") e.target.classList.add("hidden"); });

// ================= EXPENSE FORM =================
let expenseType = "shared", splitType = "equal";
function renderCategoryChips() {
  $("exCategoryChips").innerHTML = categories.map((c, i) => `<div class="chip ${i === 0 ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</div>`).join("")
    + `<div class="chip" id="addCatChip">+ Custom</div>`;
  $("exCategoryChips").querySelectorAll(".chip[data-cat]").forEach(chip => {
    chip.onclick = () => { $("exCategoryChips").querySelectorAll(".chip").forEach(c => c.classList.remove("active")); chip.classList.add("active"); };
  });
  $("addCatChip").onclick = async () => {
    const name = prompt("New category name:");
    if (name && name.trim()) { await addCustomCategory(roomId, name.trim()); }
  };
}
function renderExpenseForm() {
  const active = members.filter(m => m.status === "active");
  const opts = active.map(m => `<option value="${m.uid}">${escapeHtml(m.profile.name)}</option>`).join("");
  $("exPaidBy").innerHTML = opts;
  $("exPersonalOwner").innerHTML = opts;
  $("payPaidBy").innerHTML = opts;
  renderSplitRows();
}
document.querySelectorAll('[data-type]').forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll('[data-type]').forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    expenseType = chip.dataset.type;
    $("personalOwnerField").style.display = expenseType === "personal" ? "block" : "none";
    $("splitTypeField").style.display = expenseType === "personal" ? "none" : "block";
    $("participantsField").style.display = expenseType === "personal" ? "none" : "block";
  });
});
document.querySelectorAll('[data-split]').forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll('[data-split]').forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    splitType = chip.dataset.split;
    renderSplitRows();
  });
});
function renderSplitRows() {
  const active = members.filter(m => m.status === "active");
  $("splitRows").innerHTML = active.map(m => `
    <div class="split-row" data-uid="${m.uid}">
      <label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;">
        <input type="checkbox" class="split-check" checked> ${escapeHtml(m.profile.name)}
      </label>
      ${splitType === "custom" ? `<input type="number" class="split-amt" min="0" step="0.01" placeholder="₹0">` : `<span class="split-equal-amt" style="font-size:0.85rem;color:var(--text-dim);"></span>`}
    </div>`).join("");
  $("splitRows").querySelectorAll(".split-check, .split-amt").forEach(el => el.addEventListener("input", updateSplitPreview));
  updateSplitPreview();
}
function updateSplitPreview() {
  const amount = rupeesToPaise($("exAmount").value || 0) || 0;
  const rows = [...$("splitRows").querySelectorAll(".split-row")];
  const checked = rows.filter(r => r.querySelector(".split-check").checked);
  if (splitType === "equal") {
    const each = checked.length ? Math.floor(amount / checked.length) : 0;
    rows.forEach(r => {
      const isChecked = r.querySelector(".split-check").checked;
      const label = r.querySelector(".split-equal-amt");
      if (label) label.textContent = isChecked ? formatMoney(each) : "—";
    });
    $("splitTotalNote").textContent = checked.length ? `${formatMoney(each)} × ${checked.length} people` : "Select at least one participant.";
  } else {
    const total = checked.reduce((s, r) => s + (rupeesToPaise(r.querySelector(".split-amt").value || 0) || 0), 0);
    const ok = total === amount && amount > 0;
    $("splitTotalNote").innerHTML = `Split total: <b style="color:${ok ? "var(--green)" : "var(--red)"}">${formatMoney(total)}</b> of ${formatMoney(amount)} ${ok ? "✓" : ""}`;
  }
}
$("exAmount").addEventListener("input", updateSplitPreview);

let editingExpenseId = null;
function openExpenseForm(existing = null) {
  $("expenseForm").reset();
  editingExpenseId = existing ? existing.id : null;
  const titleEl = $("expenseOverlay").querySelector(".sheet-title");
  const submitBtn = $("exSubmitBtn");
  if (titleEl) titleEl.textContent = existing ? "✏️ Edit Expense" : "➕ Add Expense";
  if (submitBtn) submitBtn.textContent = existing ? "Save Changes" : "Save Expense";

  expenseType = existing ? existing.expenseType : "shared";
  splitType = existing ? (existing.splitType || "equal") : "equal";
  document.querySelectorAll('[data-type]').forEach(c => c.classList.toggle("active", c.dataset.type === expenseType));
  document.querySelectorAll('[data-split]').forEach(c => c.classList.toggle("active", c.dataset.split === splitType));
  $("personalOwnerField").style.display = expenseType === "personal" ? "block" : "none";
  $("splitTypeField").style.display = expenseType === "personal" ? "none" : "block";
  $("participantsField").style.display = expenseType === "personal" ? "none" : "block";
  renderCategoryChips();
  renderSplitRows();

  if (existing) {
    $("exTitle").value = existing.title || "";
    $("exAmount").value = (existing.amountPaise / 100).toString();
    $("exPaidBy").value = existing.paidBy || "";
    $("exDate").value = dateToInputValue(existing.date);
    $("exNote").value = existing.note || "";
    $("exCategoryChips").querySelectorAll(".chip[data-cat]").forEach(chip => {
      chip.classList.toggle("active", chip.dataset.cat === existing.category);
    });
    if (expenseType === "personal") {
      $("exPersonalOwner").value = existing.personalOwner || "";
    } else {
      const splitUids = new Set((existing.splits || []).map(s => s.uid));
      $("splitRows").querySelectorAll(".split-row").forEach(row => {
        const checked = splitUids.has(row.dataset.uid);
        row.querySelector(".split-check").checked = checked;
        if (splitType === "custom" && checked) {
          const s = existing.splits.find(x => x.uid === row.dataset.uid);
          row.querySelector(".split-amt").value = s ? (s.amountPaise / 100).toString() : "";
        }
      });
    }
    updateSplitPreview();
  } else {
    $("exDate").value = dateToInputValue(new Date());
  }
  $("expenseOverlay").classList.remove("hidden");
}
$("expenseOverlay").addEventListener("click", (e) => { if (e.target.id === "expenseOverlay") { e.target.classList.add("hidden"); editingExpenseId = null; } });

$("expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await withLoading($("exSubmitBtn"), async () => {
    try {
      const title = $("exTitle").value.trim();
      const amountPaise = rupeesToPaise($("exAmount").value);
      const category = $("exCategoryChips").querySelector(".chip.active")?.dataset.cat || "Other";
      const paidBy = $("exPaidBy").value;
      const dateVal = dateInputToDate($("exDate").value);
      if (!title) return showToast("Please enter a title.");
      if (!amountPaise || amountPaise <= 0) return showToast("Please enter a valid amount.");

      let splits = [];
      if (expenseType === "shared") {
        const rows = [...$("splitRows").querySelectorAll(".split-row")].filter(r => r.querySelector(".split-check").checked);
        if (!rows.length) return showToast("Select at least one participant.");
        if (splitType === "equal") {
          const each = Math.floor(amountPaise / rows.length);
          let remainder = amountPaise - each * rows.length;
          splits = rows.map((r, i) => ({ uid: r.dataset.uid, amountPaise: each + (i < remainder ? 1 : 0) }));
        } else {
          splits = rows.map(r => ({ uid: r.dataset.uid, amountPaise: rupeesToPaise(r.querySelector(".split-amt").value || 0) || 0 }));
          const total = splits.reduce((s, x) => s + x.amountPaise, 0);
          if (total !== amountPaise) return showToast("Split total must exactly equal the expense amount.");
        }
      }

      const expenseDoc = {
        title, amountPaise, category, paidBy,
        date: dateVal, month: monthKey(dateVal),
        expenseType, splits,
        personalOwner: expenseType === "personal" ? $("exPersonalOwner").value : null,
        splitType: expenseType === "shared" ? splitType : null,
        note: $("exNote").value.trim()
      };
      if (editingExpenseId) {
        await updateExpense(roomId, editingExpenseId, currentUser.uid, expenseDoc);
        await notifyRoom(roomId, members, { title: "Expense Updated", message: `${title} — ${formatMoney(amountPaise)}`, type: "expense", relatedId: null }, currentUser.uid);
        showToast("Expense updated.");
      } else {
        await addExpense(roomId, currentUser.uid, expenseDoc);
        await notifyRoom(roomId, members, { title: "New Expense Added", message: `${title} — ${formatMoney(amountPaise)}`, type: "expense", relatedId: null }, currentUser.uid);
        showToast("Expense saved.");
      }
      if (monthKey(dateVal) !== selectedMonth) { selectedMonth = monthKey(dateVal); $("monthSelect").value = selectedMonth; $("expMonthSelect").value = selectedMonth; subscribeMonth(selectedMonth); }
      $("expenseOverlay").classList.add("hidden");
      editingExpenseId = null;
    } catch (err) {
      showToast(friendlyError(err));
    }
  })();
});

// ================= PAYMENT FORM =================
function openPaymentForm() {
  $("paymentForm").reset();
  $("payDate").value = dateToInputValue(new Date());
  document.querySelectorAll('#payMethodChips .chip').forEach(c => c.classList.toggle("active", c.dataset.method === "Cash"));
  $("paymentOverlay").classList.remove("hidden");
}
$("paymentOverlay").addEventListener("click", (e) => { if (e.target.id === "paymentOverlay") e.target.classList.add("hidden"); });
document.querySelectorAll('#payMethodChips .chip').forEach(chip => {
  chip.addEventListener("click", () => { document.querySelectorAll('#payMethodChips .chip').forEach(c => c.classList.remove("active")); chip.classList.add("active"); });
});
$("paymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await withLoading($("paySubmitBtn"), async () => {
    try {
      const amountPaise = rupeesToPaise($("payAmount").value);
      if (!amountPaise || amountPaise <= 0) return showToast("Please enter a valid amount.");
      const dateVal = dateInputToDate($("payDate").value);
      await addPayment(roomId, currentUser.uid, {
        paidBy: $("payPaidBy").value,
        amountPaise,
        date: dateVal, month: monthKey(dateVal),
        method: document.querySelector("#payMethodChips .chip.active")?.dataset.method || "Cash",
        reference: $("payRef").value.trim(),
        note: $("payNote").value.trim()
      });
      if (monthKey(dateVal) !== selectedMonth) { selectedMonth = monthKey(dateVal); $("monthSelect").value = selectedMonth; $("expMonthSelect").value = selectedMonth; subscribeMonth(selectedMonth); }
      $("paymentOverlay").classList.add("hidden");
      showToast("Payment recorded.");
    } catch (err) {
      showToast(friendlyError(err));
    }
  })();
});

// ================= NOTIFICATIONS =================
function renderNotifications(list) {
  const unread = list.filter(n => !n.read).length;
  $("notifDot").classList.toggle("hidden", unread === 0);
  $("notifList").innerHTML = list.length ? list.map(n => `
    <div class="expense-row" data-notif="${n.id}" style="opacity:${n.read ? 0.6 : 1};">
      <div><div class="expense-title">${escapeHtml(n.title)}</div><div class="expense-meta">${escapeHtml(n.message)} · ${formatDate(n.createdAt)}</div></div>
    </div>`).join("") : emptyState("🔔", "No notifications", "");
  $("notifList").querySelectorAll("[data-notif]").forEach(el => {
    el.onclick = () => markNotificationRead(currentUser.uid, el.dataset.notif);
  });
  window.__latestNotifs = list;
}
$("notifBtn").addEventListener("click", () => $("notifOverlay").classList.remove("hidden"));
$("notifOverlay").addEventListener("click", (e) => { if (e.target.id === "notifOverlay") e.target.classList.add("hidden"); });
$("markAllReadBtn").addEventListener("click", async () => {
  await markAllNotificationsRead(currentUser.uid, window.__latestNotifs || []);
});

// ================= CONFIRM MODAL =================
let confirmCb = null;
function confirmAction(title, msg, cb) {
  $("confirmTitle").textContent = title;
  $("confirmMsg").textContent = msg;
  confirmCb = cb;
  $("confirmOverlay").classList.remove("hidden");
}
$("confirmCancel").addEventListener("click", () => $("confirmOverlay").classList.add("hidden"));
$("confirmOk").addEventListener("click", async () => {
  $("confirmOverlay").classList.add("hidden");
  if (confirmCb) await confirmCb();
});

// ================= LOGOUT =================
$("logoutBtn").addEventListener("click", () => confirmAction("Log out?", "You'll need to log in again to access your room.", async () => {
  await logoutUser();
  window.location.href = ROOT_PATH + "index.html";
}));
