# THE ROOMMATE — Landlord Building Creation Fix

## IMPORTANT
After uploading this project, deploy the included `firestore.rules` to the SAME Firebase project shown in `js/firebase-config.js` (`roommate-b1018`).

Firebase Console → Firestore Database → Rules → replace rules with this file → Publish.

Then log out and log in again once.

The landlord Building button now:
- uses the authenticated Firebase UID;
- creates the document in `properties`;
- immediately shows the building after a successful write;
- reports Firebase permission/network errors instead of hiding them.

If the app still says `Firebase Permission Denied`, the published Firebase Rules are not the included rules (or were published to another Firebase project).
