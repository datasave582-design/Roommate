# The Roommate — Ready-to-use

A responsive room-management app for **Room Admin, Makan Malik and Roommate**.

## Included
- Gmail / Google one-tap-style sign-in for all three roles
- Persistent Firebase login (browser local persistence) + automatic dashboard redirect
- Email/password login and password reset
- Room Admin: room, members, expenses, payments, balances, settlements and notifications
- Roommate: join by room code, approval flow, balances, expenses and notifications
- **Makan Malik portal is active (no SOON badge):**
  - Create and manage properties
  - Add rooms with rent, floor, type and status
  - Add/update tenant details
  - Record rent payments and payment mode
  - Publish property notices
  - Property/room/tenant/payment overview
- Responsive mobile + desktop UI
- PWA manifest + service worker
- Firestore security rules with role/owner checks

## Firebase setup

1. Firebase Console → Authentication → Sign-in method → enable **Google** and **Email/Password**.
2. Firebase Console → Authentication → Settings → Authorized domains: add your live hosting domain.
3. Deploy rules:
   `firebase deploy --only firestore:rules,firestore:indexes`
4. Deploy/upload the project to your hosting.

### Important about Gmail auto-login
Google login is real Firebase Authentication. The browser keeps the Firebase session locally, so after the first successful login the app automatically restores the session and opens the correct dashboard. A new Google user is assigned the role selected before Google login.

If Google sign-in shows an `unauthorized-domain` error, add the exact website domain under Firebase Authentication → Settings → Authorized domains.

## Files
- `index.html` — responsive landing/login/register + Google login
- `js/auth.js` — Firebase auth, Google auth, role routing
- `js/firebase-config.js` — Firebase configuration
- `admin/` — Room Admin
- `roommate/` — Roommate
- `landlord/` — Makan Malik
- `firestore.rules` — security
