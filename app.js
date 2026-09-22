/* ================= DELETE ACCOUNT ================= */
function openDeleteAccountModal(){
  document.getElementById('delete-reason').value = '';
  document.getElementById('delete-password').value = '';
  document.getElementById('delete-account-error').textContent = '';
  validateDeleteForm();
  document.getElementById('delete-account-modal').classList.add('show');
}
function validateDeleteForm(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const btn = document.getElementById('confirm-delete-btn');
  if(btn) btn.disabled = !(reason.length >= 5 && password.length >= 1);
}

async function confirmDeleteAccount(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const errEl = document.getElementById('delete-account-error');
  const btn = document.getElementById('confirm-delete-btn');
  errEl.textContent = '';

  if(reason.length < 5){
    errEl.textContent = 'Please bataiye account delete karne ki wajah (kam az kam kuch words).';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try{
    // Security ke liye password se dobara verify (Firebase sensitive actions ke
    // liye "recent login" maangta hai).
    const cred = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(auth.currentUser, cred);

    // Delete karne se pehle reason ko save kar lo (khud user ke record ke tor par).
    await addDoc(collection(db, 'account_deletions'), {
      uid: currentUser.uid,
      name: currentUser.name,
      email: currentUser.email,
      reason,
      deletedAt: serverTimestamp()
    });

    stopHeartbeat();
    cleanupCallListeners();
    if(unsubMessages) unsubMessages();
    if(unsubChats) unsubChats();
    if(unsubUsers) unsubUsers();

    await deleteDoc(doc(db, 'users', currentUser.uid));
    await deleteUser(auth.currentUser);

    closeModals();
    // onAuthStateChanged khud auth-screen dikha dega kyunke user ab exist nahi karta.
  }catch(e){
    const code = e.code || '';
    if(code.includes('wrong-password') || code.includes('invalid-credential')){
      errEl.textContent = 'Password galat hai.';
    } else if(code.includes('requires-recent-login')){
      errEl.textContent = 'Security ke liye pehle logout karke dobara login karein, phir delete try karein.';
    } else {
      errEl.textContent = 'Kuch masla hua: ' + (e.message || code);
    }
    btn.disabled = false;
    btn.textContent = 'Delete my account';
  }
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

  showCallOverlay(calleeUser?.name || 'Unknown', true, calleeUser?.photo);

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
        showIncomingBanner(change.doc.id, data.callerName, getUser(data.callerId)?.photo);
      }
    });
  });
}

let pendingIncomingCallId = null;
function showIncomingBanner(callId, callerName, callerPhoto){
  pendingIncomingCallId = callId;
  document.getElementById('incoming-avatar').innerHTML = avatarInner(callerName, callerPhoto);
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

  showCallOverlay(data.callerName, false, getUser(data.callerId)?.photo);
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

function showCallOverlay(name, isCaller, photo){
  document.getElementById('call-avatar').innerHTML = avatarInner(name, photo);
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
        senderId: currentUser.uid, senderName: currentUser.name, text, status:'sent', createdAt: serverTimestamp()
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
  openOnlineModal, openProfileModal, onProfilePhotoSelected,
  openDeleteAccountModal, validateDeleteForm, confirmDeleteAccount,
  startCall, acceptCall, declineCall, toggleMute, endCall
};/* ================= DELETE ACCOUNT ================= */
function openDeleteAccountModal(){
  document.getElementById('delete-reason').value = '';
  document.getElementById('delete-password').value = '';
  document.getElementById('delete-account-error').textContent = '';
  validateDeleteForm();
  document.getElementById('delete-account-modal').classList.add('show');
}
function validateDeleteForm(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const btn = document.getElementById('confirm-delete-btn');
  if(btn) btn.disabled = !(reason.length >= 5 && password.length >= 1);
}

async function confirmDeleteAccount(){
  const reason = document.getElementById('delete-reason').value.trim();
  const password = document.getElementById('delete-password').value;
  const errEl = document.getElementById('delete-account-error');
  const btn = document.getElementById('confirm-delete-btn');
  errEl.textContent = '';

  if(reason.length < 5){
    errEl.textContent = 'Please bataiye account delete karne ki wajah (kam az kam kuch words).';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try{
    // Security ke liye password se dobara verify (Firebase sensitive actions ke
    // liye "recent login" maangta hai).
    const cred = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(auth.currentUser, cred);

    // Delete karne se pehle reason ko save kar lo (khud user ke record ke tor par).
    await addDoc(collection(db, 'account_deletions'), {
      uid: currentUser.uid,
      name: currentUser.name,
      email: currentUser.email,
      reason,
      deletedAt: serverTimestamp()
    });

    stopHeartbeat();
    cleanupCallListeners();
    if(unsubMessages) unsubMessages();
    if(unsubChats) unsubChats();
    if(unsubUsers) unsubUsers();

    await deleteDoc(doc(db, 'users', currentUser.uid));
    await deleteUser(auth.currentUser);

    closeModals();
    // onAuthStateChanged khud auth-screen dikha dega kyunke user ab exist nahi karta.
  }catch(e){
    const code = e.code || '';
    if(code.includes('wrong-password') || code.includes('invalid-credential')){
      errEl.textContent = 'Password galat hai.';
    } else if(code.includes('requires-recent-login')){
      errEl.textContent = 'Security ke liye pehle logout karke dobara login karein, phir delete try karein.';
    } else {
      errEl.textContent = 'Kuch masla hua: ' + (e.message || code);
    }
    btn.disabled = false;
    btn.textContent = 'Delete my account';
  }
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

  showCallOverlay(calleeUser?.name || 'Unknown', true, calleeUser?.photo);

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
        showIncomingBanner(change.doc.id, data.callerName, getUser(data.callerId)?.photo);
      }
    });
  });
}

let pendingIncomingCallId = null;
function showIncomingBanner(callId, callerName, callerPhoto){
  pendingIncomingCallId = callId;
  document.getElementById('incoming-avatar').innerHTML = avatarInner(callerName, callerPhoto);
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

  showCallOverlay(data.callerName, false, getUser(data.callerId)?.photo);
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

function showCallOverlay(name, isCaller, photo){
  document.getElementById('call-avatar').innerHTML = avatarInner(name, photo);
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
        senderId: currentUser.uid, senderName: currentUser.name, text, status:'sent', createdAt: serverTimestamp()
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
  openOnlineModal, openProfileModal, onProfilePhotoSelected,
  openDeleteAccountModal, validateDeleteForm, confirmDeleteAccount,
  startCall, acceptCall, declineCall, toggleMute, endCall
};
