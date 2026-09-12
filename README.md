# The Roommate — Room Admin + Makan Malik + Roommate

"Room ka poora hisaab, sabke saamne clear."

## What's built in this phase
- Landing page with 3 active roles (Room Admin / Makan Malik / Roommate)
- Email/password auth: register, login, logout, forgot password
- Google/Gmail login with browser-local persistence and Android redirect fallback
- Returning users are automatically routed to their correct dashboard
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

- **Makan Malik:** create/manage properties and rooms, rent, due date, vacancy/occupancy, tenant contact, rent-payment records, and dashboard statistics.

Still optional/future: CSV/print reports, FCM push notifications, room-code regeneration.


## Critical landlord/building fix
The landlord connection flow requires the `landlordCodes/{code}` Firestore rule. The previous build could show `—` for the Makan Malik code and `Could not create building` when the deployed Firebase rules did not contain the matching landlord permissions. This package now includes the missing code-index rules, transaction-safe code creation, landlord-role checks, and a Copy button for the code.

After replacing the deployed files, publish the rules **before testing**:
```
firebase use roommate-b1018
firebase deploy --only firestore:rules,firestore:indexes,hosting
```
Then sign out/in once on the Makan Malik account and refresh. The dashboard should show a non-empty Makan Malik code. Enter that exact code in the Room Admin dashboard, send the request, approve it from Makan Malik, then assign the Admin to a building.

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

## Makan Malik ↔ Room Admin connection (latest)
1. Makan Malik dashboard shows a unique **Room Admin Connection Code**.
2. Room Admin enters that code and sends an approval request.
3. Makan Malik sees **Room Admin Approval Requests** and can Approve/Reject.
4. After approval, the Room Admin profile is linked to that Makan Malik.
5. Room Admin can create the room only after Makan Malik approval; the room stores `landlordUid` so all three roles are connected.
6. Makan Malik can see connected rooms and manage monthly rent, due date, tenant details, room status, and record rent payments.
7. Deploy the included `firestore.rules` to Firebase before testing this workflow.
\n\n## Landlord building fix\n- Building creation now uses the authenticated Firebase UID explicitly.\n- Newly created buildings render immediately without waiting for a second query.\n- Landlord code is loaded independently so connection listeners cannot block Buildings.\n- Firestore rules allow landlords to read/update/delete only their own properties.\n- Room Admin connection requests now include the required connectionCode field.\n
## v5 fixes (12 Sep 2026)
- Fixed the `users/{uid}` update rule so optional `roomId`/`landlordUid` fields do not block creation/sync of `landlordCode`.
- Landlord code lookup is now sourced from `landlordCodes/{code}` and can recover old accounts where the profile has a code but the index is missing.
- Building list rules now explicitly support `get` and `list` using `ownerUid`, so the landlord's `where("ownerUid", "==", uid)` query is authorized.
- Dashboard errors now expose the Firebase error code/message instead of only a generic failure toast.
- Re-validated every JavaScript file with `node --check` and all JSON config files with a JSON parser.

## V6 landlord dashboard fixes
- Makan Malik code generation was hardened with recovery + transaction/direct-create fallback and a visible **Fix** button.
- Added **Copy Code** and active code status.
- Added building **Manage / Edit / Delete** controls. Deleting a building first unassigns connected Room Admins.
- Added Pending Requests count and improved Admin approval/assignment UI.
- Added Profile popup with Logout.
- Added explicit Firestore composite indexes for `propertyRequests(landlordUid,status)` and `landlordConnections(landlordUid,status)` so landlord request/connection listeners do not silently fail.
- Added listener error handling so Firebase errors are shown instead of leaving empty sections.
- Static validation: all JavaScript files pass `node --check`; Firestore indexes JSON parses successfully.

### Important
The package is statically validated, but production Firebase behavior still requires publishing `firestore.rules` and `firestore.indexes.json` to project `roommate-b1018`. Firebase rules/indexes are enforced by Firebase after deployment; this environment cannot publish to the user's Firebase project.
