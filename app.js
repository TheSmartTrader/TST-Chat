// ==========================================================
// TST Chat — live app logic (Firebase Auth + Firestore + WebRTC calling)
// ==========================================================
import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, serverTimestamp,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// STUN servers only (free). For reliable calling across all networks
// (mobile data, strict NAT/firewalls) add a TURN server later — see README.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let currentUser = null;     // { uid, name, email }
let allUsers = [];          // other registered users
let myChats = [];           // chats current user belongs to
let activeChatId = null;
let unsubMessages = null;
let unsubChats = null;
let unsubUsers = null;

let pc = null;              // RTCPeerConnection
let localStream = null;
let currentCallId = null;
let unsubIncomingCalls = null;
let unsubCallDoc = null;
let unsubRemoteCandidates = null;
let muted = false;

/* ================= AUTH ================= */
function showLogin(){
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('signup-form').style.display = 'none';
}
function showSignup(){
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('signup-form').style.display = 'block';
}

async function signup(){
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  if(!name || !email || password.length < 6){
    errEl.textContent = 'Naam, email, aur 6+ character password zaroori hai.';
    return;
  }
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, name, email, createdAt: serverTimestamp()
    });
    // onAuthStateChanged will take it from here
  }catch(e){
    errEl.textContent = friendlyError(e);
  }
}

async function login(){
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(e){
    errEl.textContent = friendlyError(e);
  }
}

async function logout(){
  cleanupCallListeners();
  if(unsubMessages) unsubMessages();
  if(unsubChats) unsubChats();
  if(unsubUsers) unsubUsers();
  await signOut(auth);
}

function friendlyError(e){
  const code = e.code || '';
  if(code.includes('email-already-in-use')) return 'Ye email pehle se registered hai. Login kar lo.';
  if(code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Email ya password galat hai.';
  if(code.includes('weak-password')) return 'Password kam az kam 6 characters ka ho.';
  if(code.includes('invalid-email')) return 'Email sahi format mein likho.';
  return 'Kuch masla hua: ' + (e.message || code);
}

onAuthStateChanged(auth, async (user)=>{
  if(user){
    const snap = await getDoc(doc(db, 'users', user.uid));
    const data = snap.exists() ? snap.data() : { name: user.email, email: user.email };
    currentUser = { uid: user.uid, name: data.name, email: data.email };
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    listenUsers();
    listenMyChats();
    listenIncomingCalls();
  } else {
    currentUser = null;
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
});

/* ================= USERS (contacts) ================= */
function listenUsers(){
  if(unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db, 'users'), (snap)=>{
    allUsers = snap.docs.map(d=>d.data()).filter(u=>u.uid !== currentUser.uid);
  });
}
function getUser(uid){ return allUsers.find(u=>u.uid===uid); }
function initials(name){ return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }

/* ================= CHATS LIST ================= */
function listenMyChats(){
  const q = query(collection(db,'chats'), where('members','array-contains', currentUser.uid));
  if(unsubChats) unsubChats();
  unsubChats = onSnapshot(q, (snap)=>{
    myChats = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    myChats.sort((a,b)=> (b.lastMessageTime?.toMillis?.()||0) - (a.lastMessageTime?.toMillis?.()||0));
    renderChatList();
    if(activeChatId) renderChatHeader();
  });
}

function chatDisplayName(chat){
  if(chat.type==='group') return chat.name;
  const otherUid = chat.members.find(m=>m!==currentUser.uid);
  const u = getUser(otherUid);
  return u ? u.name : 'Unknown user';
}

function renderChatList(){
  const list = document.getElementById('chat-list');
  const q = (document.getElementById('search-input').value||'').toLowerCase();
  list.innerHTML = '';
  myChats
    .filter(c=> chatDisplayName(c).toLowerCase().includes(q))
    .forEach(chat=>{
      const name = chatDisplayName(chat);
      const row = document.createElement('div');
      row.className = 'chat-row' + (chat.id===activeChatId?' active':'');
      row.onclick = ()=> openChat(chat.id);
      const av = document.createElement('div');
      av.className = 'avatar' + (chat.type==='group'?' group':'');
      av.textContent = initials(name);
      row.appendChild(av);
      const mid = document.createElement('div');
      mid.className = 'chat-row-mid';
      const time = chat.lastMessageTime?.toDate ? formatTime(chat.lastMessageTime.toDate()) : '';
      mid.innerHTML = `
        <div class="row-top">
          <div class="row-name">${escapeHtml(name)}</div>
          <div class="row-time">${time}</div>
        </div>
        <div class="row-bottom">
          <div class="row-preview">${escapeHtml(chat.lastMessage||'No messages yet')}</div>
        </div>`;
      row.appendChild(mid);
      list.appendChild(row);
    });
}

function escapeHtml(s){ const d=document.createElement('div'); d.textContent = s||''; return d.innerHTML; }
function formatTime(d){
  let h=d.getHours(), m=d.getMinutes();
  const ampm = h>=12?'PM':'AM'; h=h%12; if(h===0)h=12;
  return `${h}:${m.toString().padStart(2,'0')} ${ampm}`;
}

/* ================= CHAT VIEW / MESSAGES ================= */
function openChat(chatId){
  activeChatId = chatId;
  document.body.classList.add('chat-open');
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('active-chat').style.display = 'flex';
  renderChatHeader();

  if(unsubMessages) unsubMessages();
  const q = query(collection(db,'chats',chatId,'messages'), orderBy('createdAt','asc'));
  unsubMessages = onSnapshot(q, (snap)=>{
    const messages = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderMessages(messages);
  });

  renderChatList();
  document.getElementById('msg-input').focus();
}
function closeChat(){ document.body.classList.remove('chat-open'); }

function renderChatHeader(){
  const chat = myChats.find(c=>c.id===activeChatId);
  if(!chat) return;
  const name = chatDisplayName(chat);
  document.getElementById('ch-avatar').className = 'avatar' + (chat.type==='group'?' group':'');
  document.getElementById('ch-avatar').textContent = initials(name);
  document.getElementById('ch-name').textContent = name;
  if(chat.type==='group'){
    const names = chat.members.filter(m=>m!==currentUser.uid).map(uid=>getUser(uid)?.name?.split(' ')[0]||'?').join(', ');
    document.getElementById('ch-status').textContent = names;
  } else {
    document.getElementById('ch-status').textContent = '';
  }
}

function renderMessages(messages){
  const chat = myChats.find(c=>c.id===activeChatId);
  const wrap = document.getElementById('messages');
  wrap.innerHTML = '';
  let lastDay = null;
  messages.forEach(m=>{
    const created = m.createdAt?.toDate ? m.createdAt.toDate() : new Date();
    const dayStr = created.toDateString();
    if(dayStr !== lastDay){
      const chip = document.createElement('div');
      chip.className='day-chip';
      chip.textContent = dayStr === new Date().toDateString() ? 'Today' : created.toLocaleDateString();
      wrap.appendChild(chip);
      lastDay = dayStr;
    }
    const mine = m.senderId === currentUser.uid;
    const row = document.createElement('div');
    row.className = 'bubble-row ' + (mine?'out':'in');
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (mine?'out':'in');
    let senderHtml = '';
    if(chat?.type==='group' && !mine){
      senderHtml = `<span class="sender" style="color:${colorForSender(m.senderName||'')}">${escapeHtml(m.senderName)}</span>`;
    }
    bubble.innerHTML = `${senderHtml}<span class="msg-text">${escapeHtml(m.text)}</span><span class="meta">${formatTime(created)}</span>`;
    row.appendChild(bubble);
    wrap.appendChild(row);
  });
  wrap.scrollTop = wrap.scrollHeight;
}
function colorForSender(name){
  const colors=['#E17055','#0984E3','#00B894','#6C5CE7','#D63031','#00CEC9'];
  let h=0; for(let i=0;i<name.length;i++) h=name.charCodeAt(i)+((h<<5)-h);
  return colors[Math.abs(h)%colors.length];
}

async function sendMessage(){
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if(!text || !activeChatId) return;
  input.value = '';
  await addDoc(collection(db,'chats',activeChatId,'messages'), {
    senderId: currentUser.uid, senderName: currentUser.name, text, createdAt: serverTimestamp()
  });
  await updateDoc(doc(db,'chats',activeChatId), {
    lastMessage: text, lastMessageTime: serverTimestamp()
  });
}

/* ================= NEW CHAT / GROUP ================= */
function closeModals(){
  document.getElementById('new-chat-modal').classList.remove('show');
  document.getElementById('new-group-modal').classList.remove('show');
}
function openNewChatModal(){
  const box = document.getElementById('new-chat-contacts');
  box.innerHTML = '';
  if(allUsers.length===0){
    box.innerHTML = '<div style="padding:16px 18px;color:#667781;font-size:13.5px;">Abhi koi aur registered user nahi hai. Kisi aur ko sign up karwao.</div>';
  }
  allUsers.forEach(u=>{
    const row = document.createElement('div');
    row.className='contact-pick';
    row.innerHTML = `<div class="avatar" style="width:40px;height:40px;font-size:14px;">${initials(u.name)}</div>
      <div><div style="font-weight:600;font-size:14.5px;">${escapeHtml(u.name)}</div>
      <div style="font-size:12.5px;color:#667781;">${escapeHtml(u.email)}</div></div>`;
    row.onclick = async ()=>{
      closeModals();
      const chatId = [currentUser.uid, u.uid].sort().join('_');
      const existing = myChats.find(c=>c.id===chatId);
      if(existing){ openChat(chatId); return; }
      await setDoc(doc(db,'chats',chatId), {
        type:'dm', members:[currentUser.uid, u.uid],
        lastMessage:'', lastMessageTime: serverTimestamp(), createdAt: serverTimestamp()
      });
      openChat(chatId);
    };
    box.appendChild(row);
  });
  document.getElementById('new-chat-modal').classList.add('show');
}

let groupSelection = new Set();
function openNewGroupModal(){
  groupSelection = new Set();
  document.getElementById('group-name-input').value = '';
  const box = document.getElementById('new-group-contacts');
  box.innerHTML = '';
  allUsers.forEach(u=>{
    const row = document.createElement('div');
    row.className='contact-pick';
    row.innerHTML = `<input type="checkbox" id="grp-${u.uid}">
      <div class="avatar" style="width:40px;height:40px;font-size:14px;">${initials(u.name)}</div>
      <div style="font-weight:600;font-size:14.5px;">${escapeHtml(u.name)}</div>`;
    row.querySelector('input').onchange = (e)=>{
      if(e.target.checked) groupSelection.add(u.uid); else groupSelection.delete(u.uid);
      validateGroupForm();
    };
    row.onclick = (e)=>{
      if(e.target.tagName!=='INPUT'){
        const cb = row.querySelector('input'); cb.checked=!cb.checked; cb.dispatchEvent(new Event('change'));
      }
    };
    box.appendChild(row);
  });
  validateGroupForm();
  document.getElementById('new-group-modal').classList.add('show');
}
function validateGroupForm(){
  const name = document.getElementById('group-name-input').value.trim();
  document.getElementById('create-group-btn').disabled = !(name && groupSelection.size>=1);
}
async function createGroup(){
  const name = document.getElementById('group-name-input').value.trim();
  const members = Array.from(groupSelection);
  members.push(currentUser.uid);
  if(!name || members.length<2) return;
  const ref = await addDoc(collection(db,'chats'), {
    type:'group', name, members,
    lastMessage:`Group created by ${currentUser.name}`, lastMessageTime: serverTimestamp(), createdAt: serverTimestamp()
  });
  closeModals();
  openChat(ref.id);
}

/* ================= VOICE CALLING (WebRTC + Firestore signaling) ================= */
function getOtherUidForActiveChat(){
  const chat = myChats.find(c=>c.id===activeChatId);
  if(!chat || chat.type!=='dm') return null;
  return chat.members.find(m=>m!==currentUser.uid);
}

async function startCall(){
  const calleeUid = getOtherUidForActiveChat();
  if(!calleeUid){ alert('Voice call abhi sirf 1-to-1 chat mein available hai.'); return; }
  const calleeUser = getUser(calleeUid);

  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));

  const remoteAudio = document.getElementById('remote-audio');
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;
  pc.ontrack = (e)=> e.streams[0].getTracks().forEach(t=>remoteStream.addTrack(t));

  const callDocRef = doc(collection(db,'calls'));
  currentCallId = callDocRef.id;
  const callerCandidates = collection(callDocRef, 'callerCandidates');
  const calleeCandidates = collection(callDocRef, 'calleeCandidates');

  pc.onicecandidate = (e)=>{ if(e.candidate) addDoc(callerCandidates, e.candidate.toJSON()); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await setDoc(callDocRef, {
    callerId: currentUser.uid, callerName: currentUser.name,
    calleeId: calleeUid, calleeName: calleeUser?.name || '',
    offer: { type: offer.type, sdp: offer.sdp },
    status: 'ringing', createdAt: serverTimestamp()
  });

  showCallOverlay(calleeUser?.name || 'Unknown', true);

  unsubCallDoc = onSnapshot(callDocRef, async (snap)=>{
    const data = snap.data();
    if(!data) return;
    if(data.status==='accepted' && data.answer && pc.currentRemoteDescription===null){
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      document.getElementById('call-status').textContent = '00:00';
      document.getElementById('call-status').classList.remove('ringing');
      startCallTimer();
    }
    if(data.status==='declined' || data.status==='ended'){
      teardownCall(false);
    }
  });
  unsubRemoteCandidates = onSnapshot(calleeCandidates, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });
}

function listenIncomingCalls(){
  const q = query(collection(db,'calls'), where('calleeId','==', currentUser.uid), where('status','==','ringing'));
  if(unsubIncomingCalls) unsubIncomingCalls();
  unsubIncomingCalls = onSnapshot(q, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added'){
        const data = change.doc.data();
        showIncomingBanner(change.doc.id, data.callerName);
      }
    });
  });
}

let pendingIncomingCallId = null;
function showIncomingBanner(callId, callerName){
  pendingIncomingCallId = callId;
  document.getElementById('incoming-avatar').textContent = initials(callerName);
  document.getElementById('incoming-name').textContent = callerName;
  document.getElementById('incoming-call').classList.add('show');
}
function hideIncomingBanner(){
  document.getElementById('incoming-call').classList.remove('show');
}

async function acceptCall(){
  const callId = pendingIncomingCallId;
  hideIncomingBanner();
  if(!callId) return;
  currentCallId = callId;
  const callDocRef = doc(db,'calls',callId);
  const snap = await getDoc(callDocRef);
  const data = snap.data();
  if(!data) return;

  pc = new RTCPeerConnection(RTC_CONFIG);
  localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));

  const remoteAudio = document.getElementById('remote-audio');
  const remoteStream = new MediaStream();
  remoteAudio.srcObject = remoteStream;
  pc.ontrack = (e)=> e.streams[0].getTracks().forEach(t=>remoteStream.addTrack(t));

  const callerCandidates = collection(callDocRef, 'callerCandidates');
  const calleeCandidates = collection(callDocRef, 'calleeCandidates');
  pc.onicecandidate = (e)=>{ if(e.candidate) addDoc(calleeCandidates, e.candidate.toJSON()); };

  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await updateDoc(callDocRef, {
    answer: { type: answer.type, sdp: answer.sdp }, status:'accepted'
  });

  showCallOverlay(data.callerName, false);
  document.getElementById('call-status').textContent = '00:00';
  document.getElementById('call-status').classList.remove('ringing');
  startCallTimer();

  unsubRemoteCandidates = onSnapshot(callerCandidates, (snap)=>{
    snap.docChanges().forEach(change=>{
      if(change.type==='added') pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
    });
  });
  unsubCallDoc = onSnapshot(callDocRef, (snap)=>{
    const d = snap.data();
    if(d && (d.status==='ended')) teardownCall(false);
  });
}

async function declineCall(){
  const callId = pendingIncomingCallId;
  hideIncomingBanner();
  if(!callId) return;
  await updateDoc(doc(db,'calls',callId), { status:'declined' });
  pendingIncomingCallId = null;
}

function showCallOverlay(name, isCaller){
  document.getElementById('call-avatar').textContent = initials(name);
  document.getElementById('call-name').textContent = name;
  document.getElementById('call-status').textContent = isCaller ? 'Calling…' : 'Connecting…';
  document.getElementById('call-status').classList.add('ringing');
  muted = false;
  document.getElementById('mute-btn').classList.remove('active');
  document.getElementById('call-overlay').classList.add('show');
}

let callTimerInterval = null, callSeconds = 0;
function startCallTimer(){
  callSeconds = 0;
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(()=>{
    callSeconds++;
    const m=Math.floor(callSeconds/60).toString().padStart(2,'0');
    const s=(callSeconds%60).toString().padStart(2,'0');
    document.getElementById('call-status').textContent = `${m}:${s}`;
  },1000);
}

function toggleMute(){
  muted = !muted;
  if(localStream) localStream.getAudioTracks().forEach(t=> t.enabled = !muted);
  document.getElementById('mute-btn').classList.toggle('active', muted);
}

async function endCall(){
  if(currentCallId){
    try{ await updateDoc(doc(db,'calls',currentCallId), { status:'ended' }); }catch(e){}
  }
  teardownCall(true);
}

function teardownCall(logMessage){
  document.getElementById('call-overlay').classList.remove('show');
  clearInterval(callTimerInterval);
  if(pc){ pc.close(); pc = null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  if(unsubCallDoc){ unsubCallDoc(); unsubCallDoc = null; }
  if(unsubRemoteCandidates){ unsubRemoteCandidates(); unsubRemoteCandidates = null; }

  if(logMessage && activeChatId && callSeconds >= 0){
    const chat = myChats.find(c=>c.id===activeChatId);
    if(chat){
      const m=Math.floor(callSeconds/60).toString().padStart(2,'0');
      const s=(callSeconds%60).toString().padStart(2,'0');
      const text = callSeconds>0 ? `📞 Voice call · ${m}:${s}` : `📞 Call ended`;
      addDoc(collection(db,'chats',activeChatId,'messages'), {
        senderId: currentUser.uid, senderName: currentUser.name, text, createdAt: serverTimestamp()
      });
      updateDoc(doc(db,'chats',activeChatId), { lastMessage:text, lastMessageTime: serverTimestamp() });
    }
  }
  currentCallId = null;
  callSeconds = 0;
}

function cleanupCallListeners(){
  if(unsubIncomingCalls){ unsubIncomingCalls(); unsubIncomingCalls = null; }
  teardownCall(false);
}

/* ================= EXPOSE TO WINDOW (called from index.html inline handlers) ================= */
window.TST = {
  showLogin, showSignup, signup, login, logout,
  renderChatList, openChat, closeChat, sendMessage,
  openNewChatModal, openNewGroupModal, closeModals, validateGroupForm, createGroup,
  startCall, acceptCall, declineCall, toggleMute, endCall
};
