# TST Chat — Live Setup Guide

Ye files aap ke **asli, live, real-time** TST Chat app ke hain — Firebase Auth + Firestore
(real-time messaging + groups) + WebRTC (voice calls) ke sath.

## 1. Firebase config daalo
`firebase-config.js` file kholo aur Firebase Console se mile keys paste karo:

Firebase Console > Project Settings (⚙️) > General tab > "Your apps" > Web app > `firebaseConfig`

## 2. Authentication enable karo
Firebase Console > Build > Authentication > Sign-in method > **Email/Password** > Enable > Save

## 3. Firestore Database banao
Firebase Console > Build > Firestore Database > Create database > (Test mode se shuru karo)

Phir **Rules** tab mein jao aur is repo ki `firestore.rules` file ka content paste kar ke **Publish** kar do
(taake koi aur user aap ka data na parh/likh sake).

## 4. GitHub par push karo
```bash
cd tst-chat-live
git init
git add .
git commit -m "TST Chat live version"
git branch -M main
git remote add origin https://github.com/<aapka-username>/tst-chat.git
git push -u origin main
```

## 5. Live karo — do options hain

### Option A: Firebase Hosting (recommended, free, HTTPS by default)
```bash
npm install -g firebase-tools
firebase login
cd tst-chat-live
firebase init hosting
# "public directory" mein "." (current folder) likho
# "Single-page app" — No
firebase deploy
```
Deploy hone ke baad aap ko ek live URL milega jaisे `https://tst-chat-xxxx.web.app`

### Option B: GitHub Pages (free)
GitHub repo > Settings > Pages > Branch: `main` > Save.
URL milega: `https://<username>.github.io/tst-chat/`

## 6. WPBuilder se Android APK banao
Jo bhi live URL Step 5 se mila (Firebase Hosting ya GitHub Pages), wahi URL WPBuilder mein
"Website URL" field mein daal do aur APK build kar lo. App ka naam "TST Chat" rakhna,
icon bhi upload kar sakte ho.

**Note:** Voice call microphone permission ke liye WPBuilder ki settings mein
"Enable microphone access" / "WebRTC permissions" ka option agar ho to zaroor ON karna,
warna app ke andar call kaam nahi karegi.

## Important limitations (honestly batana zaroori hai)

- **Voice call reliability**: Is code mein sirf free **STUN** servers use ho rahe hain.
  Zyada tar Wi-Fi/home networks par call theek chalegi, lekin kuch mobile data / office
  networks (jahan strict NAT/firewall ho) par call connect nahi hogi. Isay fix karne ke
  liye ek **TURN server** chahiye hota hai — free/cheap options: metered.ca ka free TURN,
  ya Twilio Network Traversal Service. Jab zaroorat ho to bata dena, `RTC_CONFIG` mein
  `app.js` ke andar ek line add karni hogi.
- **Group voice calls** abhi support nahi hain — sirf 1-to-1 call. Group call ke liye
  alag architecture (SFU jaise LiveKit/Agora) chahiye hota hai.
- **Video call** abhi nahi hai — chahiye ho to easily add ho sakta hai (audio wali call
  ka hi code extend hoga).
- Firestore "Test mode" 30 din baad khud band ho jata hai — Step 3 ki rules zaroor publish
  karna warna app data reject karne lag jayegi.

## File structure
```
tst-chat-live/
├── index.html        (UI markup)
├── style.css          (WhatsApp-style theme)
├── app.js             (Firebase auth, chat, calling logic)
├── firebase-config.js (aap ke Firebase keys yahan)
├── firestore.rules    (security rules)
└── README.md          (ye file)
```
