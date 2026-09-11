// room-data.js — shared Firestore logic for Room Admin + Roommate portals.
// Balance model (matches spec §15 exactly):
//   share(person) = sum of their shared-expense split allocations + personal expenses owned by them
//   paid(person)  = sum of Payment records recorded against them
//   balance(person) = paid - share   → positive = credit, negative = due, 0 = settled
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, getDoc, getDocs, setDoc, deleteField,
  query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp,
  runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { generateRoomCode } from "./common.js";

export const DEFAULT_CATEGORIES = ["Food/Grocery","Electricity","Internet","Rent","Water","Cleaning","Household","Travel","Medicine","Other"];

// ---------- Room creation (unique code via transaction) ----------
export async function createRoom(adminUid, { name, flatNumber, address, city, rent, dueDate, description }) {
  const roomRef = doc(collection(db, "rooms"));
  let code;
  await runTransaction(db, async (tx) => {
    let codeRef, codeSnap;
    for (let i = 0; i < 8; i++) {
      code = generateRoomCode();
      codeRef = doc(db, "roomCodes", code);
      codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists()) break;
      code = null;
    }
    if (!code) throw new Error("Could not generate a unique room code, please try again.");

    tx.set(roomRef, {
      roomId: roomRef.id,
      adminUid,
      name, flatNumber, address, city,
      monthlyRent: rent || 0,
      rentDueDate: dueDate || null,
      description: description || "",
      code,
      memberCount: 1,
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    tx.set(codeRef, { roomId: roomRef.id, createdAt: serverTimestamp() });
    tx.update(doc(db, "users", adminUid), { roomId: roomRef.id, updatedAt: serverTimestamp() });
  });

  // The admin's own member-entry MUST be written as a separate request, after
  // the transaction above has actually committed. Firestore rules resolve
  // get()/exists() calls against the database state at the START of a
  // transaction — they never see writes made earlier in that same
  // transaction. isRoomAdmin() (used by the members/{uid} create rule) reads
  // the room via get(), so if this write stayed inside the transaction that
  // creates the room itself, the rule would always see "room doesn't exist
  // yet" and reject it — which is exactly what was happening before this fix.
  await setDoc(doc(db, "rooms", roomRef.id, "members", adminUid), {
    uid: adminUid, role: "admin", status: "active", joinedAt: serverTimestamp()
  });

  return roomRef.id;
}

export async function getRoomByAdmin(adminUid) {
  const q = query(collection(db, "rooms"), where("adminUid", "==", adminUid), limit(1));
  const snap = await getDocs(q);
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Direct single-document lookup — used instead of getRoomByAdmin() as the
// primary path on dashboard load. A `where(adminUid==...)` collection query's
// security rule can't always be proven safe by Firestore's query validator,
// which silently denies it; reading rooms/{roomId} by the id already stored
// on the user's own profile (users/{uid}.roomId, set in createRoom()) is a
// single-document read and doesn't hit that restriction.
export async function getRoomById(roomId) {
  const snap = await getDoc(doc(db, "rooms", roomId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function listenRoom(roomId, cb) {
  return onSnapshot(doc(db, "rooms", roomId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}

// ---------- Join requests ----------
export async function requestJoinRoom(uid, code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) throw { code: "not-found", message: "Please enter a room code." };

  const codeSnap = await getDoc(doc(db, "roomCodes", normalizedCode));
  if (!codeSnap.exists()) throw { code: "not-found", message: "Invalid room code." };

  const roomId = codeSnap.data().roomId;
  if (!roomId) throw { code: "not-found", message: "Invalid room code." };

  // The applicant can read their own profile. Copy the small public-facing
  // fields into the request so the room admin does not need permission to
  // read an unapproved user's private profile.
  const userSnap = await getDoc(doc(db, "users", uid));
  if (!userSnap.exists()) throw { code: "not-found", message: "Account profile not found." };
  const profile = userSnap.data();

  const existing = await getDocs(query(
    collection(db, "joinRequests"),
    where("uid", "==", uid),
    where("roomId", "==", roomId),
    where("status", "==", "pending")
  ));
  if (!existing.empty) return existing.docs[0].id;

  const ref = await addDoc(collection(db, "joinRequests"), {
    uid,
    roomId,
    status: "pending",
    applicant: {
      name: String(profile.name || "").slice(0, 100),
      phone: String(profile.phone || "").slice(0, 20),
      email: String(profile.email || "").slice(0, 160)
    },
    createdAt: serverTimestamp()
  });
  return ref.id;
}

export function listenPendingRequests(roomId, cb) {
  const q = query(collection(db, "joinRequests"), where("roomId", "==", roomId), where("status", "==", "pending"));
  return onSnapshot(q, async (snap) => {
    const reqs = [];
    for (const d of snap.docs) {
      const data = d.data();
      reqs.push({
        id: d.id,
        ...data,
        user: data.applicant || { name: "Unknown", phone: "" }
      });
    }
    cb(reqs);
  });
}

export async function approveJoinRequest(requestId, roomId, uid) {
  const batch = writeBatch(db);
  batch.set(doc(db, "rooms", roomId, "members", uid), {
    uid, role: "roommate", status: "active", joinedAt: serverTimestamp()
  });
  batch.update(doc(db, "joinRequests", requestId), { status: "approved", resolvedAt: serverTimestamp() });
  batch.update(doc(db, "users", uid), { roomId, updatedAt: serverTimestamp() });
  await batch.commit();
  await addNotification(uid, { title: "Request Approved 🎉", message: "You've been added to the room.", type: "system", relatedId: roomId, roomId });
}

export async function rejectJoinRequest(requestId) {
  await updateDoc(doc(db, "joinRequests", requestId), { status: "rejected", resolvedAt: serverTimestamp() });
}

export function listenMembers(roomId, cb) {
  const q = query(collection(db, "rooms", roomId, "members"), where("status", "in", ["active", "inactive"]));
  return onSnapshot(q, async (snap) => {
    const members = [];
    for (const d of snap.docs) {
      const data = d.data();
      const userSnap = await getDoc(doc(db, "users", data.uid));
      members.push({ ...data, profile: userSnap.exists() ? userSnap.data() : { name: "Unknown" } });
    }
    cb(members);
  });
}

export async function setMemberStatus(roomId, uid, status) {
  await updateDoc(doc(db, "rooms", roomId, "members", uid), { status });
}

// ---------- Categories ----------
export async function addCustomCategory(roomId, name) {
  await setDoc(doc(db, "rooms", roomId, "categories", name), { name, createdAt: serverTimestamp() });
}
export function listenCategories(roomId, cb) {
  return onSnapshot(collection(db, "rooms", roomId, "categories"), (snap) => {
    cb(snap.docs.map(d => d.data().name));
  });
}

// ---------- Expenses ----------
export async function addExpense(roomId, actorUid, expense) {
  const ref = await addDoc(collection(db, "rooms", roomId, "expenses"), {
    ...expense,
    createdBy: actorUid,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  await logAudit(roomId, actorUid, "expense_added", "expense", ref.id);
  return ref.id;
}
export async function updateExpense(roomId, expenseId, actorUid, patch) {
  await updateDoc(doc(db, "rooms", roomId, "expenses", expenseId), { ...patch, updatedAt: serverTimestamp() });
  await logAudit(roomId, actorUid, "expense_edited", "expense", expenseId);
}
export async function archiveExpense(roomId, expenseId, actorUid) {
  await updateDoc(doc(db, "rooms", roomId, "expenses", expenseId), { archived: true, updatedAt: serverTimestamp() });
  await logAudit(roomId, actorUid, "expense_archived", "expense", expenseId);
}

export function listenExpenses(roomId, monthKey, cb, pageSize = 100) {
  const q = query(
    collection(db, "rooms", roomId, "expenses"),
    where("month", "==", monthKey),
    orderBy("date", "desc"),
    limit(pageSize)
  );
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

// ---------- Payments ----------
export async function addPayment(roomId, actorUid, payment) {
  const ref = await addDoc(collection(db, "rooms", roomId, "payments"), {
    ...payment,
    createdBy: actorUid,
    createdAt: serverTimestamp()
  });
  await logAudit(roomId, actorUid, "payment_recorded", "payment", ref.id);
  return ref.id;
}
export function listenPayments(roomId, monthKey, cb) {
  const q = query(
    collection(db, "rooms", roomId, "payments"),
    where("month", "==", monthKey),
    orderBy("date", "desc")
  );
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

// ---------- Balance calculation (client-side, derived — never stored as editable) ----------
export function computeBalances(members, expenses, payments, settlements = []) {
  const balances = {};
  members.forEach(m => { balances[m.uid] = { share: 0, paid: 0, name: m.profile?.name || "Unknown" }; });

  expenses.filter(e => !e.archived).forEach(e => {
    if (e.expenseType === "personal") {
      const owner = e.personalOwner;
      if (balances[owner]) balances[owner].share += e.amountPaise;
    } else {
      (e.splits || []).forEach(s => {
        if (balances[s.uid]) balances[s.uid].share += s.amountPaise;
      });
    }
  });
  payments.forEach(p => {
    if (balances[p.paidBy]) balances[p.paidBy].paid += p.amountPaise;
  });

  // A completed settlement is a real transfer of money: it reduces the
  // debtor's outstanding amount and the creditor's outstanding credit.
  settlements.filter(s => s.status === "completed").forEach(s => {
    const amount = Number(s.amountPaise);
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    if (balances[s.fromUid]) balances[s.fromUid].paid += amount;
    if (balances[s.toUid]) balances[s.toUid].paid -= amount;
  });

  return Object.entries(balances).map(([uid, v]) => ({
    uid, name: v.name, share: v.share, paid: v.paid, balance: v.paid - v.share
  }));
}

// Greedy debt-simplification: minimum transfers to settle all balances
export function suggestSettlements(balanceList) {
  const debtors = balanceList.filter(b => b.balance < 0).map(b => ({ ...b, amt: -b.balance })).sort((a, b) => b.amt - a.amt);
  const creditors = balanceList.filter(b => b.balance > 0).map(b => ({ ...b, amt: b.balance })).sort((a, b) => b.amt - a.amt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) transfers.push({ fromUid: debtors[i].uid, fromName: debtors[i].name, toUid: creditors[j].uid, toName: creditors[j].name, amountPaise: pay });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt <= 0) i++;
    if (creditors[j].amt <= 0) j++;
  }
  return transfers;
}

export async function recordSettlement(roomId, actorUid, settlement) {
  const ref = await addDoc(collection(db, "rooms", roomId, "settlements"), {
    ...settlement,
    status: "completed",
    date: serverTimestamp(),
    createdAt: serverTimestamp()
  });
  await logAudit(roomId, actorUid, "settlement_recorded", "settlement", ref.id);
  return ref.id;
}
export function listenSettlements(roomId, cb) {
  const q = query(collection(db, "rooms", roomId, "settlements"), orderBy("createdAt", "desc"), limit(50));
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

// ---------- Notifications ----------
export async function addNotification(recipientUid, { title, message, type, relatedId, roomId: notificationRoomId }) {
  await addDoc(collection(db, "users", recipientUid, "notifications"), {
    title, message, type: type || "system", relatedId: relatedId || null,
    roomId: notificationRoomId || null,
    read: false, createdAt: serverTimestamp()
  });
}
export async function notifyRoom(roomId, members, payload, excludeUid) {
  const targets = members.filter(m => m.status === "active" && m.uid !== excludeUid);
  await Promise.all(targets.map(m => addNotification(m.uid, { ...payload, roomId })));
}
export function listenMyNotifications(uid, cb) {
  const q = query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"), limit(30));
  return onSnapshot(q, (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}
export async function markNotificationRead(uid, notifId) {
  await updateDoc(doc(db, "users", uid, "notifications", notifId), { read: true });
}
export async function markAllNotificationsRead(uid, notifs) {
  const batch = writeBatch(db);
  notifs.filter(n => !n.read).forEach(n => batch.update(doc(db, "users", uid, "notifications", n.id), { read: true }));
  await batch.commit();
}

// ---------- Audit log ----------
async function logAudit(roomId, actorUid, action, targetType, targetId) {
  await addDoc(collection(db, "auditLogs"), {
    roomId, actorUid, action, targetType, targetId, timestamp: serverTimestamp()
  }).catch(() => {}); // never block the primary action on audit-log failure
}
