import { auth, db, ROOT_PATH } from "../js/firebase-config.js";
import { requireAuth, logoutUser } from "../js/auth.js";
import {
  collection, addDoc, getDocs, query, where, serverTimestamp, doc, updateDoc, setDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { ensureLandlordCode, listenLandlordRequests, approveLandlordRequest, rejectLandlordRequest, listenLandlordConnections, assignLandlordAdminBuilding, sendLandlordNotification } from "../js/room-data.js";

const $=id=>document.getElementById(id); let me=null, buildings=[], connections=[];
function toast(x){const e=$("toast");e.textContent=x;e.classList.remove("hidden");clearTimeout(window.tt);window.tt=setTimeout(()=>e.classList.add("hidden"),2600)}
function esc(s){return String(s??"").replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function openModal(title,html){$("modalTitle").textContent=title;$("modalBody").innerHTML=html;$("modal").classList.remove("hidden")}
function closeModal(){$("modal").classList.add("hidden")}

async function loadConnections(){
  listenLandlordRequests(me.uid, reqs=>renderRequests(reqs));
  listenLandlordConnections(me.uid, list=>{connections=list; renderConnections();});
}
function renderRequests(reqs){
  const card=$("adminRequestsCard");
  if(!reqs.length){card.style.display="none";$("adminRequestsList").innerHTML="";return;}
  card.style.display="block";
  $("adminRequestsList").innerHTML=reqs.map(r=>`<div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:8px"><div class="row"><div><div class="person-name">Room Admin Request</div><div class="person-meta">A Room Admin wants to connect with your building account.</div></div><div style="display:flex;gap:8px"><button class="btn btn-outline approveAdmin" data-id="${esc(r.id)}" data-uid="${esc(r.requestedBy)}" style="width:auto;padding:8px 12px">Approve</button><button class="btn btn-text rejectAdmin" data-id="${esc(r.id)}" style="width:auto;padding:8px 12px">Reject</button></div></div></div>`).join("");
  document.querySelectorAll(".approveAdmin").forEach(b=>b.onclick=async()=>{try{b.disabled=true;await approveLandlordRequest(b.dataset.id,b.dataset.uid,me.uid);toast("Room Admin approved.")}catch(e){console.error(e);toast("Could not approve request")}finally{b.disabled=false}});
  document.querySelectorAll(".rejectAdmin").forEach(b=>b.onclick=async()=>{try{await rejectLandlordRequest(b.dataset.id);toast("Request rejected")}catch(e){console.error(e);toast("Could not reject request")}});
}

async function loadBuildings(){
  if(!me?.uid) throw new Error("Landlord session not ready.");
  const q=query(collection(db,"properties"),where("ownerUid","==",me.uid));
  const snap=await getDocs(q);
  buildings=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
    const av=a.createdAt?.toMillis?.() ?? 0, bv=b.createdAt?.toMillis?.() ?? 0;
    return bv-av;
  });
  renderBuildings();
  renderConnections();
}
function renderBuildings(){
  $("statBuildings").textContent=buildings.length;
  $("statAdmins").textContent=connections.length;
  $("buildingList").innerHTML=buildings.length?buildings.map(b=>`<div class="card"><div class="row"><div><h3>${esc(b.name)}</h3><div class="person-meta">${esc(b.address||"")}${b.city?", "+esc(b.city):""}</div></div><span class="pill pill-blue">${connections.filter(c=>c.buildingId===b.id).length} Admin${connections.filter(c=>c.buildingId===b.id).length===1?"":"s"}</span></div></div>`).join(""):`<div class="empty-state"><div class="emoji">🏢</div><h3>Add your first building</h3><p>Create buildings only. Roommate and Room Admin private data is never shown here.</p></div>`;
}
function renderConnections(){
  $("statAdmins").textContent=connections.length;
  const html=connections.length?connections.map((c,i)=>{
    const building=buildings.find(b=>b.id===c.buildingId);
    const label=`Room Admin ${i+1}`;
    return `<div class="card"><div class="row"><div><h3>👨‍💼 ${label}</h3><div class="person-meta">Connected · ${esc(building?.name||"No building assigned")}</div></div><button class="btn btn-outline manageAdmin" data-id="${esc(c.id)}" style="width:auto">Manage</button></div></div>`;
  }).join(""): `<div class="empty-state"><div class="emoji">🔗</div><h3>No connected Room Admins</h3><p>Approve a Room Admin request to connect them to your building.</p></div>`;
  $("adminList").innerHTML=html;
  document.querySelectorAll(".manageAdmin").forEach(b=>b.onclick=()=>adminManageForm(connections.find(c=>c.id===b.dataset.id)));
}
function adminManageForm(conn){
  const opts=buildings.map(b=>`<option value="${esc(b.id)}" ${conn.buildingId===b.id?"selected":""}>${esc(b.name)}</option>`).join("");
  openModal("Room Admin — Building & Notifications",`
    <div class="field"><label>Building</label><select id="adminBuilding"><option value="">No building assigned</option>${opts}</select></div>
    <button id="saveAdminBuilding" class="btn btn-outline">Save Building</button>
    <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
    <div class="section-title" style="margin:0 0 10px">📢 Send Notification</div>
    <div class="field"><label>Title</label><input id="noticeTitle" maxlength="80" placeholder="Rent reminder"></div>
    <div class="field"><label>Message</label><textarea id="noticeMessage" rows="4" maxlength="500" placeholder="Monthly rent is due on the 5th."></textarea></div>
    <button id="sendOneNotice" class="btn btn-primary">Send to this Admin</button>`);
  $("saveAdminBuilding").onclick=async()=>{try{await assignLandlordAdminBuilding(conn.id,me.uid,$("adminBuilding").value||null);closeModal();toast("Building assignment saved")}catch(e){console.error(e);toast("Could not save building")}};
  $("sendOneNotice").onclick=async()=>{try{const title=$("noticeTitle").value.trim(),message=$("noticeMessage").value.trim();if(!title||!message)return toast("Enter title and message");await sendLandlordNotification(me.uid,[conn.id],{title,message,type:"landlord"});closeModal();toast("Notification sent")}catch(e){console.error(e);toast("Could not send notification")}};
}
function propertyForm(){
  openModal("Add Building",`
    <div class="field"><label>Building Name</label><input id="fName" placeholder="Sharma Building" autocomplete="organization" required></div>
    <div class="field"><label>Address</label><input id="fAddress" placeholder="Building address" autocomplete="street-address"></div>
    <div class="field"><label>City</label><input id="fCity" placeholder="Noida" autocomplete="address-level2"></div>
    <button id="saveProperty" class="btn btn-primary">Create Building</button>
  `);

  $("saveProperty").onclick=async()=>{
    const btn=$("saveProperty");
    try{
      if(!me?.uid || !auth.currentUser?.uid) throw {code:"auth/invalid-user",message:"Login session expired. Please login again."};
      const name=$("fName").value.trim();
      const address=$("fAddress").value.trim();
      const city=$("fCity").value.trim();
      if(!name) return toast("Building name is required");

      btn.disabled=true;
      btn.textContent="Creating…";

      // Explicit ownerUid is required by the Firestore rule. The owner is
      // always taken from the authenticated Firebase user, never from input.
      const propertyRef=doc(collection(db,"properties"));
      const propertyData={
        ownerUid:auth.currentUser.uid,
        name,
        address,
        city,
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      };
      await setDoc(propertyRef,propertyData);
      const ref=propertyRef;

      // Immediately show the newly created building. This also makes the UI
      // responsive even if the subsequent list refresh is delayed.
      buildings.unshift({
        id:ref.id,
        ownerUid:auth.currentUser.uid,
        name,
        address,
        city,
        createdAt:{toMillis:()=>Date.now()}
      });
      renderBuildings();
      closeModal();
      toast("✅ Building added successfully");
    }catch(e){
      console.error("Building creation failed:",e);
      const code=e?.code||"";
      let msg="Could not create building.";
      if(code==="permission-denied") msg="Firebase permission denied. Publish the included firestore.rules for project roommate-b1018.";
      else if(code==="unauthenticated" || code==="auth/invalid-user") msg="Login session expired. Please login again.";
      else if(code==="failed-precondition") msg="Firestore is not ready. Check Firebase project/database setup.";
      else if(e?.message) msg=`Could not create building: ${e.message}`;
      console.error("BUILDING_ERROR_CODE",code,"BUILDING_ERROR_MESSAGE",e?.message||e);
      toast(msg);
    }finally{
      if($("saveProperty")) {
        $("saveProperty").disabled=false;
        $("saveProperty").textContent="Create Building";
      }
    }
  };
}
function broadcastForm(){
  if(!connections.length)return toast("No connected Room Admins.");
  const buildingOptions=buildings.map(b=>`<option value="${esc(b.id)}">${esc(b.name)} (${connections.filter(c=>c.buildingId===b.id).length} Admins)</option>`).join("");
  openModal("Send to Room Admins",`
    <div class="field"><label>Send To</label><select id="broadcastTarget"><option value="all">All connected Admins</option>${buildingOptions}</select></div>
    <div class="field"><label>Notification Type</label><select id="broadcastType"><option value="rent">💰 Rent Notification</option><option value="notice">📢 General Notice</option><option value="maintenance">🛠 Maintenance</option></select></div>
    <div class="field"><label>Title</label><input id="broadcastTitle" maxlength="80" placeholder="Rent due reminder"></div>
    <div class="field"><label>Message</label><textarea id="broadcastMessage" rows="4" maxlength="500" placeholder="Please collect/communicate this month's rent reminder."></textarea></div>
    <button id="sendBroadcast" class="btn btn-primary">Send Notification</button>`);
  $("sendBroadcast").onclick=async()=>{try{const title=$("broadcastTitle").value.trim(),message=$("broadcastMessage").value.trim();if(!title||!message)return toast("Enter title and message");let targets=connections;if($("broadcastTarget").value!=="all")targets=connections.filter(c=>c.buildingId===$("broadcastTarget").value);if(!targets.length)return toast("No Admin assigned to this building.");await sendLandlordNotification(me.uid,targets.map(c=>c.id),{title,message,type:$("broadcastType").value});closeModal();toast(`Notification sent to ${targets.length} Admin${targets.length===1?"":"s"}`)}catch(e){console.error(e);toast("Could not send notifications")}};
}

$("addBuildingBtn").onclick=propertyForm;
$("broadcastBtn").onclick=broadcastForm;
$("closeModal").onclick=closeModal;
$("modal").onclick=e=>{if(e.target.id==="modal")closeModal()};
$("logoutBtn").onclick=async()=>{await logoutUser();location.href=ROOT_PATH+"index.html"};
$("homeNav").onclick=()=>{};
$("noticeNav").onclick=broadcastForm;
$("profileNav").onclick=()=>toast("Your landlord account is secure. Room Admin/Roommate private data is not visible here.");

requireAuth({
  expectedRole:"landlord",
  onReady:async(user,profile)=>{
    me=user;
    $("welcome").textContent=profile.name||user.displayName||"Makan Malik";
    $("loader").classList.add("hidden");
    $("app").classList.remove("hidden");

    // Load the landlord code independently; a connection-listener failure
    // must never prevent the Buildings section from rendering.
    try{
      const code=await ensureLandlordCode(me.uid);
      $("landlordCode").textContent=code||"—";
    }catch(e){
      console.error("Landlord code load failed:",e);
      $("landlordCode").textContent="—";
    }

    try{ await loadBuildings(); }
    catch(e){
      console.error("Building list load failed:",e);
      $("buildingList").innerHTML=`<div class="empty-state"><div class="emoji">⚠️</div><h3>Buildings could not be loaded</h3><p>Deploy the latest Firestore rules, then refresh this page.</p></div>`;
      toast("Could not load buildings. Check Firestore rules.");
    }

    try{ await loadConnections(); }
    catch(e){
      console.error("Connection load failed:",e);
      toast("Building dashboard loaded. Connection data needs Firestore rules.");
    }
  }
});
