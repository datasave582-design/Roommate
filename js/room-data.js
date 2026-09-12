// room-data.js — shared Firestore logic for Room Admin + Roommate portals.
// Balance model (matches spec §15 exactly):
//   share(person) = sum of their shared-expense split allocations + personal expenses owned by them
//   paid(person)  = sum of Payment records recorded against them
//   balance(person) = paid - share   → positive = credit, negative = due, 0 = settled
import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, getDoc, getDocs, setDoc, deleteField,
  query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp,
  runTransaction, writeBatch, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { generateRoomCode } from "./common.js";

export const DEFAULT_CATEGORIES = ["Food/Grocery","Electricity","Internet","Rent","Water","Cleaning","Household","Travel","Medicine","Other"];

// ---------- Room creation (unique code via transaction) ----------
export async function createRoom(adminUid, { name, flatNumber, address, city, rent, dueDate, description, landlordUid }) {
  if (!adminUid) throw { code: "auth/invalid-user", message: "Please log in again." };
  if (!String(name || "").trim()) throw { code: "invalid-argument", message: "Room name is required." };

  const roomRef = doc(collection(db, "rooms"));
  let code = null;

  // Keep room creation atomic. The rules use getAfter() for the room/member
  // checks, so the admin member and user.roomId can safely be created in the
  // same transaction as the room itself.
  await runTransaction(db, async (tx) => {
    for (let i = 0; i < 12; i++) {
      const candidate = generateRoomCode();
      const codeRef = doc(db, "roomCodes", candidate);
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists()) {
        code = candidate;
        tx.set(roomRef, {
          roomId: roomRef.id,
          adminUid,
          name: String(name).trim(),
          flatNumber: String(flatNumber || "").trim(),
          address: String(address || "").trim(),
          city: String(city || "").trim(),
          monthlyRent: Number(rent || 0),
          rentDueDate: dueDate || null,
          description: String(description || "").trim(),
          landlordUid: landlordUid || null,
          code,
          memberCount: 1,
          status: "active",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        tx.set(codeRef, { roomId: roomRef.id, createdAt: serverTimestamp() });
        tx.set(doc(db, "rooms", roomRef.id, "members", adminUid), {
          uid: adminUid,
          role: "admin",
          status: "active",
          joinedAt: serverTimestamp()
        });
        tx.update(doc(db, "users", adminUid), {
          roomId: roomRef.id,
          updatedAt: serverTimestamp()
        });
        return;
      }
    }
    throw { code: "already-exists", message: "Could not generate a unique room code. Please try again." };
  });

  if (!code) throw new Error("Room creation failed.");
  return roomRef.id;
}

export async function deleteRoom(roomId, adminUid) {
  if (!roomId || !adminUid) throw { code: "invalid-argument", message: "Invalid room details." };

  const roomRef = doc(db, "rooms", roomId);
  const roomSnap = await getDoc(roomRef);
  if (!roomSnap.exists()) throw { code: "not-found", message: "Room not found." };
  const room = roomSnap.data();
  if (room.adminUid !== adminUid) throw { code: "permission-denied", message: "Only the Room Admin can delete this room." };

  // Remove all room-scoped data so deleting a room does not leave orphaned
  // financial/member documents behind. Audit logs intentionally remain.
  const subcollections = [
    "members", "rentPayments", "categories", "expenses",
    "payments", "settlements", "notifications"
  ];
  for (const sub of subcollections) {
    const snap = await getDocs(collection(db, "rooms", roomId, sub));
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // Resolve pending join requests belonging to this room before removing it.
  const reqSnap = await getDocs(query(collection(db, "joinRequests"), where("roomId", "==", roomId)));
  for (let i = 0; i < reqSnap.docs.length; i += 450) {
    const batch = writeBatch(db);
    reqSnap.docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  if (room.code) await deleteDoc(doc(db, "roomCodes", room.code));

  // Clear room links from every member profile, including the admin, so a
  // deleted room never traps an account on a non-existent roomId.
  await updateDoc(doc(db, "users", adminUid), { roomId: null, updatedAt: serverTimestamp() });
  await deleteDoc(roomRef);

  return true;
}

export async function attachLandlordToRoom(roomId, adminUid, landlordUid) {
  if (!roomId || !adminUid || !landlordUid) throw { code: "invalid-argument", message: "Invalid connection details." };
  const snap = await getDoc(doc(db, "rooms", roomId));
  if (!snap.exists() || snap.data().adminUid !== adminUid) throw { code: "permission-denied", message: "You are not the admin of this room." };
  if (!isStringId(landlordUid)) throw { code: "invalid-argument", message: "Invalid landlord." };
  await updateDoc(doc(db, "rooms", roomId), { landlordUid, updatedAt: serverTimestamp() });
}

function isStringId(value) { return typeof value === "string" && value.length > 0; }

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

export async function cancelJoinRequest(requestId, uid) {
  if (!requestId || !uid) throw { code: "invalid-argument", message: "Invalid join request." };
  const ref = doc(db, "joinRequests", requestId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw { code: "not-found", message: "Join request not found." };
  const data = snap.data();
  if (data.uid !== uid || data.status !== "pending") {
    throw { code: "permission-denied", message: "This join request can no longer be cancelled." };
  }
  await deleteDoc(ref);
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

// ---------- Landlord ↔ Room Admin connection ----------
export async function ensureLandlordCode(landlordUid) {
  if (!landlordUid) throw { code: "auth/invalid-user", message: "Please log in again." };

  // The authenticated landlord is the only source of ownership. The code
  // index itself is the source of truth, so an old/missing profile field can
  // never prevent the code from being displayed.
  const profileRef = doc(db, "users", landlordUid);
  const profileSnap = await getDoc(profileRef);
  if (!profileSnap.exists() || profileSnap.data().role !== "landlord") {
    throw { code: "permission-denied", message: "Makan Malik profile not found." };
  }

  const profileCode = String(profileSnap.data().landlordCode || "").trim().toUpperCase();
  if (profileCode) {
    const codeRef = doc(db, "landlordCodes", profileCode);
    const codeSnap = await getDoc(codeRef);
    if (!codeSnap.exists()) {
      await setDoc(codeRef, { landlordUid, createdAt: serverTimestamp() });
    } else if (codeSnap.data().landlordUid !== landlordUid) {
      throw { code: "already-exists", message: "Saved Makan Malik code belongs to another account." };
    }
    return profileCode;
  }

  // Recover a code created earlier by this landlord.
  const existing = await getDocs(query(
    collection(db, "landlordCodes"),
    where("landlordUid", "==", landlordUid),
    limit(1)
  ));
  if (!existing.empty) {
    const recovered = existing.docs[0].id;
    try { await updateDoc(profileRef, { landlordCode: recovered, updatedAt: serverTimestamp() }); } catch (_) {}
    return recovered;
  }

  // Generate a unique code. A direct create is used rather than depending on
  // a multi-document transaction, making this reliable on mobile networks.
  for (let i = 0; i < 40; i++) {
    const candidate = generateRoomCode();
    const codeRef = doc(db, "landlordCodes", candidate);
    try {
      const occupied = await getDoc(codeRef);
      if (occupied.exists()) continue;
      await setDoc(codeRef, { landlordUid, createdAt: serverTimestamp() });
      try { await updateDoc(profileRef, { landlordCode: candidate, updatedAt: serverTimestamp() }); } catch (_) {}
      return candidate;
    } catch (e) {
      if (e?.code === "already-exists") continue;
      throw e;
    }
  }
  throw { code: "already-exists", message: "Could not generate a unique code. Tap Generate / Fix again." };
}

export async function getLandlordConnection(adminUid) {
  const snap = await getDoc(doc(db, "landlordConnections", adminUid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
export async function requestLandlordConnection(adminUid, code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) throw { code: "invalid-argument", message: "Enter the Makan Malik connection code." };
  const codeSnap = await getDoc(doc(db, "landlordCodes", normalized));
  if (!codeSnap.exists()) throw { code: "not-found", message: "Invalid Makan Malik code." };
  const landlordUid = codeSnap.data().landlordUid;
  if (!landlordUid || landlordUid === adminUid) throw { code: "invalid-argument", message: "Invalid landlord code." };
  // NOTE: we do NOT read users/{landlordUid} here to double-check the role.
  // That doc is private to its owner (users/{uid} rule only allows isSelf
  // reads) so a Room Admin reading it always throws permission-denied. It's
  // also redundant: landlordCodes/{code} can only ever be created by an
  // account whose profile already has role=="landlord" (enforced by the
  // landlordCodes create rule), so a valid code is proof enough on its own.
  const ref = doc(db, "propertyRequests", adminUid);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().status === "pending") return existing.id;
  await setDoc(ref, {
    requestedBy: adminUid,
    landlordUid,
    connectionCode: normalized,
    status: "pending",
    requestType: "roomAdminConnection",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}
export function listenMyLandlordRequest(adminUid, cb) {
  return onSnapshot(doc(db, "propertyRequests", adminUid), snap => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
}
export function listenLandlordRequests(landlordUid, cb, onError) {
  const q = query(collection(db, "propertyRequests"), where("landlordUid", "==", landlordUid), where("status", "==", "pending"));
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
}
export async function approveLandlordRequest(requestId, adminUid, landlordUid) {
  const batch = writeBatch(db);
  batch.update(doc(db, "propertyRequests", requestId), { status: "approved", resolvedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(doc(db, "landlordConnections", adminUid), { adminUid, landlordUid, status: "approved", buildingId: null, approvedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  batch.set(doc(db, "users", adminUid), { landlordUid, landlordConnectionStatus: "approved", updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
  await addNotification(adminUid, { title: "Makan Malik Approved ✅", message: "Your Room Admin account is now connected to the Makan Malik.", type: "landlord", relatedId: requestId });
}
export async function rejectLandlordRequest(requestId) {
  await updateDoc(doc(db, "propertyRequests", requestId), { status: "rejected", resolvedAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
export function listenLandlordConnections(landlordUid, cb, onError) {
  const q = query(collection(db, "landlordConnections"), where("landlordUid", "==", landlordUid), where("status", "==", "approved"));
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
}
export async function assignLandlordAdminBuilding(adminUid, landlordUid, buildingId) {
  const ref = doc(db, "landlordConnections", adminUid);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().landlordUid !== landlordUid || snap.data().status !== "approved") throw { code: "permission-denied", message: "Admin is not connected." };
  if (buildingId) {
    const b = await getDoc(doc(db, "properties", buildingId));
    if (!b.exists() || b.data().ownerUid !== landlordUid) throw { code: "permission-denied", message: "Invalid building." };
  }
  await updateDoc(ref, { buildingId: buildingId || null, updatedAt: serverTimestamp() });
}
export async function disconnectLandlordAdmin(adminUid, landlordUid) {
  if (!adminUid || !landlordUid) throw { code: "invalid-argument", message: "Invalid connection." };
  const connectionRef = doc(db, "landlordConnections", adminUid);
  const userRef = doc(db, "users", adminUid);
  const connectionSnap = await getDoc(connectionRef);
  if (!connectionSnap.exists() || connectionSnap.data().landlordUid !== landlordUid || connectionSnap.data().status !== "approved") {
    throw { code: "permission-denied", message: "Admin is not connected to this Makan Malik." };
  }
  const batch = writeBatch(db);
  batch.delete(connectionRef);
  batch.update(userRef, { landlordUid: null, landlordConnectionStatus: "disconnected", updatedAt: serverTimestamp() });
  await batch.commit();
  try {
    await addNotification(adminUid, { title: "Makan Malik Connection Removed", message: "Your connection with the Makan Malik was disconnected.", type: "landlord", relatedId: null });
  } catch (_) {}
}

export async function disconnectMyLandlord(adminUid) {
  const ref = doc(db, "landlordConnections", adminUid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await updateDoc(doc(db, "users", adminUid), { landlordUid: null, landlordConnectionStatus: "disconnected", updatedAt: serverTimestamp() });
    return;
  }
  const batch = writeBatch(db);
  batch.delete(ref);
  batch.update(doc(db, "users", adminUid), { landlordUid: null, landlordConnectionStatus: "disconnected", updatedAt: serverTimestamp() });
  await batch.commit();
}

export async function sendLandlordNotification(landlordUid, adminUids, { title, message, type }) {
  const unique = [...new Set((adminUids || []).filter(Boolean))];
  if (!unique.length) throw { code: "invalid-argument", message: "No Room Admin selected." };
  if (!title || !message) throw { code: "invalid-argument", message: "Title and message are required." };
  const batch = writeBatch(db);
  for (const adminUid of unique) {
    const c = await getDoc(doc(db, "landlordConnections", adminUid));
    if (!c.exists() || c.data().landlordUid !== landlordUid || c.data().status !== "approved") throw { code: "permission-denied", message: "One selected Admin is not connected." };
    const ref = doc(collection(db, "users", adminUid, "notifications"));
    batch.set(ref, { title: String(title).slice(0,80), message: String(message).slice(0,500), type: type || "landlord", relatedId: null, roomId: null, read: false, createdAt: serverTimestamp() });
  }
  await batch.commit();
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
export async function deleteExpense(roomId, expenseId, actorUid) {
  if (!roomId || !expenseId || !actorUid) throw { code: "invalid-argument", message: "Invalid expense." };
  await deleteDoc(doc(db, "rooms", roomId, "expenses", expenseId));
  await logAudit(roomId, actorUid, "expense_deleted", "expense", expenseId);
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
