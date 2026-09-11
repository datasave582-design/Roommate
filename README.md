# The Roommate — Phase 1 (Room Admin + Roommate)

"Room ka poora hisaab, sabke saamne clear."

## What's built in this phase
- Landing page with 3-role selection (Room Admin / Makan Malik / Roommate)
- Email/password auth: register, login, logout, forgot password
- **Room Admin**: create room (unique room code), approve/reject join requests,
  add/archive expenses (equal or custom split, shared or personal), record
  payments, live balance dashboard, auto-suggested settlements, notifications,
  remove roommate (soft — history kept)
- **Roommate**: join-by-code flow with pending-approval state, read-only
  dashboard (balance, share, room expenses, rent info, notifications)
- Money handled in integer paise everywhere (no floating-point drift)
- Firestore Security Rules are the real authorization layer — role, adminUid,
  and ownerUid can never be changed from the browser
- PWA shell (manifest + service worker) with offline app-shell caching; browser install UI appears when supported

**Not yet built (Phase 2):** Landlord/Makan Malik portal (properties, rooms,
tenants, rent, notices), CSV/print reports, FCM push notifications, room-code
regeneration, expense editing (archive works; edit doesn't yet).

## Deploy steps

1. **Install Firebase CLI** (if you haven't): `npm install -g firebase-tools`
2. **Login & select the project:**
   ```
   firebase login
   firebase use roommate-b1018
   ```
3. **Enable Email/Password sign-in** in Firebase Console → Authentication → Sign-in method.
4. **Deploy security rules & indexes:**
   ```
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   ⚠️ Test the rules in the Firebase Console Rules Playground before going live —
   review each collection's allow/deny against a few real create/read/update calls.
5. **Deploy hosting** (or upload this folder to any static host):
   ```
   firebase init hosting   # point public dir to this folder
   firebase deploy --only hosting
   ```

## File map
```
index.html              landing + login/register
manifest.json, service-worker.js, icon-192.png, icon-512.png   PWA
firestore.rules          security rules (all collections)
firestore.indexes.json   composite indexes actually used by the app
js/firebase-config.js    Firebase init (your config, already filled in)
js/auth.js               register/login/logout/reset + role-based route guard
js/common.js             money (paise) helpers, toast, validation, PWA install
js/room-data.js          all room/expense/payment/balance/settlement logic
admin/dashboard.html+js  Room Admin app
roommate/dashboard.html+js  Roommate app
```
