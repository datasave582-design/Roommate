import { auth, db, ROOT_PATH } from "../js/firebase-config.js";
import { requireAuth, logoutUser } from "../js/auth.js";
import {
  collection, getDocs, query, where, serverTimestamp, doc, updateDoc, setDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  ensureLandlordCode, listenLandlordRequests, approveLandlordRequest, rejectLandlordRequest,
  listenLandlordConnections, assignLandlordAdminBuilding, sendLandlordNotification
} from "../js/room-data.js";

const $ = id => document.getElementById(id);
let me = null, profile = null, buildings = [], connections = [], pendingRequests = [];

function toast(x){
  const e=$("toast"); e.textContent=x; e.classList.remove("hidden");
  clearTimeout(window.tt); window.tt=setTimeout(()=>e.classList.add("hidden"),3200);
}
function esc(s){return String(s??"").replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function openModal(title,html){$("modalTitle").textContent=title;$("modalBody").innerHTML=html;$("modal").classList.remove("hidden")}
function closeModal(){$("modal").classList.add("hidden")}
function errorText(e, fallback){
  const c=e?.code||"";
  if(c==="permission-denied") return "Firebase permission denied. Please publish the included Firestore Rules and login again.";
  if(c==="failed-precondition") return "Firestore needs an index or is not ready. Check Firebase Console → Firestore → Indexes.";
  if(c==="unavailable") return "Firebase is temporarily unavailable. Check internet and retry.";
  if(c==="unauthenticated") return "Login session expired. Please login again.";
  return e?.message ? `${fallback}: ${e.message}` : fallback;
}

async function loadBuildings(){
  const q=query(collection(db,"properties"),where("ownerUid","==",me.uid));
  const snap=await getDocs(q);
  buildings=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
  renderBuildings();
}

function renderStats(){
  $("statBuildings").textContent=buildings.length;
  $("statAdmins").textContent=connections.length;
  $("statRequests").textContent=pendingRequests.length;
}
function renderBuildings(){
  renderStats();
  const html=buildings.length ? buildings.map(b=>{
    const assigned=connections.filter(c=>c.buildingId===b.id).length;
    return `<div class="card building-card">
      <div class="row" style="align-items:flex-start;gap:12px">
        <div style="min-width:0;flex:1">
          <div class="person-name">🏢 ${esc(b.name)}</div>
          <div class="person-meta">${esc(b.address||"Address not added")}${b.city?", "+esc(b.city):""}</div>
          <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px">
            <span class="pill pill-blue">${assigned} Admin${assigned===1?"":"s"}</span>
            ${b.city?`<span class="pill">📍 ${esc(b.city)}</span>`:""}
          </div>
        </div>
        <button class="btn btn-outline buildingManage" data-id="${esc(b.id)}" style="width:auto;padding:9px 12px">Manage</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty-state"><div class="emoji">🏢</div><h3>No buildings yet</h3><p>Add your first building and assign connected Room Admins.</p><button class="btn btn-primary" id="emptyAddBuilding" style="width:auto">+ Add Building</button></div>`;
  $("buildingList").innerHTML=html;
  document.querySelectorAll(".buildingManage").forEach(b=>b.onclick=()=>buildingManageForm(buildings.find(x=>x.id===b.dataset.id)));
  $("emptyAddBuilding")?.addEventListener("click",propertyForm);
}

function renderRequests(reqs){
  pendingRequests=reqs||[]; renderStats();
  const card=$("adminRequestsCard");
  if(!pendingRequests.length){card.style.display="none";$("adminRequestsList").innerHTML="";return;}
  card.style.display="block";
  $("adminRequestsList").innerHTML=pendingRequests.map(r=>`<div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:8px">
    <div class="row" style="gap:10px"><div style="flex:1"><div class="person-name">👨‍💼 Room Admin Request</div><div class="person-meta">A Room Admin wants to connect to your Makan Malik account.</div></div>
    <div style="display:flex;gap:7px;flex-wrap:wrap"><button class="btn btn-primary approveAdmin" data-id="${esc(r.id)}" data-uid="${esc(r.requestedBy)}" style="width:auto;padding:8px 12px">Approve</button><button class="btn btn-text rejectAdmin" data-id="${esc(r.id)}" style="width:auto;padding:8px 12px">Reject</button></div></div></div>`).join("");
  document.querySelectorAll(".approveAdmin").forEach(b=>b.onclick=async()=>{
    try{b.disabled=true;await approveLandlordRequest(b.dataset.id,b.dataset.uid,me.uid);toast("✅ Room Admin approved. Now assign a building.");}
    catch(e){console.error(e);toast(errorText(e,"Could not approve request"));}finally{b.disabled=false;}
  });
  document.querySelectorAll(".rejectAdmin").forEach(b=>b.onclick=async()=>{
    try{b.disabled=true;await rejectLandlordRequest(b.dataset.id);toast("Request rejected.");}
    catch(e){console.error(e);toast(errorText(e,"Could not reject request"));}finally{b.disabled=false;}
  });
}

function renderConnections(){
  renderStats();
  const html=connections.length ? connections.map((c,i)=>{
    const building=buildings.find(b=>b.id===c.buildingId);
    return `<div class="card"><div class="row" style="gap:10px"><div style="flex:1"><div class="person-name">👨‍💼 Room Admin ${i+1}</div><div class="person-meta">${building?`🏢 ${esc(building.name)}`:"⚠️ No building assigned"}</div></div><button class="btn btn-outline manageAdmin" data-id="${esc(c.id)}" style="width:auto">Manage</button></div></div>`;
  }).join("") : `<div class="empty-state"><div class="emoji">🔗</div><h3>No connected Room Admins</h3><p>Give your code to a Room Admin. Approve their request here.</p></div>`;
  $("adminList").innerHTML=html;
  document.querySelectorAll(".manageAdmin").forEach(b=>b.onclick=()=>adminManageForm(connections.find(c=>c.id===b.dataset.id)));
}

function propertyForm(edit=null){
  openModal(edit?"Edit Building":"Add Building",`
    <div class="field"><label>Building Name</label><input id="fName" value="${esc(edit?.name||"")}" placeholder="Sharma Building" maxlength="80" required></div>
    <div class="field"><label>Address</label><input id="fAddress" value="${esc(edit?.address||"")}" placeholder="Building address" maxlength="180"></div>
    <div class="field"><label>City</label><input id="fCity" value="${esc(edit?.city||"")}" placeholder="Noida" maxlength="60"></div>
    <button id="saveProperty" class="btn btn-primary">${edit?"Save Changes":"Create Building"}</button>`);
  $("saveProperty").onclick=async()=>{
    const btn=$("saveProperty");
    try{
      const name=$("fName").value.trim(),address=$("fAddress").value.trim(),city=$("fCity").value.trim();
      if(!name)return toast("Building name is required.");
      btn.disabled=true;btn.textContent="Saving…";
      if(edit){
        await updateDoc(doc(db,"properties",edit.id),{name,address,city,updatedAt:serverTimestamp()});
        Object.assign(edit,{name,address,city});
        toast("✅ Building updated.");
      }else{
        const ref=doc(collection(db,"properties"));
        await setDoc(ref,{ownerUid:me.uid,name,address,city,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
        buildings.unshift({id:ref.id,ownerUid:me.uid,name,address,city,createdAt:{toMillis:()=>Date.now()}});
        toast("✅ Building added.");
      }
      renderBuildings();renderConnections();closeModal();
    }catch(e){console.error(e);toast(errorText(e,edit?"Could not update building":"Could not create building"));}
    finally{if($("saveProperty")){btn.disabled=false;}}
  };
}

async function deleteBuilding(building){
  const assigned=connections.filter(c=>c.buildingId===building.id);
  const ok=confirm(`Delete “${building.name}”?\n\n${assigned.length?assigned.length+" connected Admin(s) will be unassigned first.\n":""}This building record cannot be recovered.`);
  if(!ok)return;
  try{
    for(const c of assigned) await assignLandlordAdminBuilding(c.id,me.uid,null);
    await deleteDoc(doc(db,"properties",building.id));
    buildings=buildings.filter(b=>b.id!==building.id);
    connections=connections.map(c=>c.buildingId===building.id?{...c,buildingId:null}:c);
    renderBuildings();renderConnections();toast("🗑️ Building deleted.");
  }catch(e){console.error(e);toast(errorText(e,"Could not delete building"));}
}

function buildingManageForm(building){
  const assigned=connections.filter(c=>c.buildingId===building.id).length;
  openModal("🏢 Building Management",`
    <div class="card" style="box-shadow:none;border:1px solid var(--border);margin-bottom:12px"><div class="person-name">${esc(building.name)}</div><div class="person-meta">${esc(building.address||"Address not added")}${building.city?", "+esc(building.city):""}</div><div class="person-meta" style="margin-top:7px">${assigned} connected Admin${assigned===1?"":"s"}</div></div>
    <button id="editBuilding" class="btn btn-outline">✏️ Edit Building</button>
    <button id="deleteBuilding" class="btn btn-danger" style="margin-top:8px">🗑️ Delete Building</button>`);
  $("editBuilding").onclick=()=>propertyForm(building);
  $("deleteBuilding").onclick=async()=>{closeModal();await deleteBuilding(building)};
}

function adminManageForm(conn){
  if(!conn)return;
  const opts=buildings.map(b=>`<option value="${esc(b.id)}" ${conn.buildingId===b.id?"selected":""}>${esc(b.name)}</option>`).join("");
  openModal("👨‍💼 Room Admin Management",`
    <div class="field"><label>Building Assignment</label><select id="adminBuilding"><option value="">No building assigned</option>${opts}</select></div>
    <button id="saveAdminBuilding" class="btn btn-primary">Save Assignment</button>
    <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
    <div class="section-title" style="margin:0 0 10px">📢 Send Notification</div>
    <div class="field"><label>Title</label><input id="noticeTitle" maxlength="80" placeholder="Rent reminder"></div>
    <div class="field"><label>Message</label><textarea id="noticeMessage" rows="4" maxlength="500" placeholder="Monthly rent is due on the 5th."></textarea></div>
    <button id="sendOneNotice" class="btn btn-primary">Send to this Admin</button>`);
  $("saveAdminBuilding").onclick=async()=>{try{await assignLandlordAdminBuilding(conn.id,me.uid,$("adminBuilding").value||null);connections=connections.map(c=>c.id===conn.id?{...c,buildingId:$("adminBuilding").value||null}:c);renderBuildings();renderConnections();closeModal();toast("✅ Building assignment saved.")}catch(e){console.error(e);toast(errorText(e,"Could not save building assignment"))}};
  $("sendOneNotice").onclick=async()=>{try{const title=$("noticeTitle").value.trim(),message=$("noticeMessage").value.trim();if(!title||!message)return toast("Enter title and message.");await sendLandlordNotification(me.uid,[conn.id],{title,message,type:"landlord"});closeModal();toast("📢 Notification sent.")}catch(e){console.error(e);toast(errorText(e,"Could not send notification"))}};
}

async function loadLandlordCode(){
  $("landlordCode").textContent="Loading…";
  try{
    const code=await ensureLandlordCode(me.uid);
    if(!code)throw {code:"not-found",message:"No code was returned by Firebase."};
    $("landlordCode").textContent=code;
    $("codeStatus").textContent="Active • Give this code to your Room Admin";
  }catch(e){
    console.error("Landlord code error",e);
    $("landlordCode").textContent="ERROR";
    $("codeStatus").textContent=`${e?.code||"firebase-error"} — tap Fix Code to retry`;
    toast(errorText(e,"Makan Malik code could not be generated"));
  }
}
function copyLandlordCode(){
  const code=$("landlordCode").textContent.trim();
  if(!/^RM-[A-Z0-9]{5}$/.test(code))return toast("पहले Makan Malik code generate होने दें.");
  navigator.clipboard?.writeText(code).then(()=>toast("✅ Code copied")).catch(()=>toast("Code: "+code));
}
function broadcastForm(){
  if(!connections.length)return toast("No connected Room Admins.");
  const buildingOptions=buildings.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
  openModal("📢 Send Notice",`<div class="field"><label>Send To</label><select id="broadcastTarget"><option value="all">All connected Admins</option>${buildingOptions}</select></div><div class="field"><label>Type</label><select id="broadcastType"><option value="notice">📢 General Notice</option><option value="rent">💰 Rent</option><option value="maintenance">🛠 Maintenance</option></select></div><div class="field"><label>Title</label><input id="broadcastTitle" maxlength="80" placeholder="Important notice"></div><div class="field"><label>Message</label><textarea id="broadcastMessage" rows="4" maxlength="500"></textarea></div><button id="sendBroadcast" class="btn btn-primary">Send Notification</button>`);
  $("sendBroadcast").onclick=async()=>{try{const title=$("broadcastTitle").value.trim(),message=$("broadcastMessage").value.trim();if(!title||!message)return toast("Enter title and message.");let targets=connections;if($("broadcastTarget").value!=="all")targets=connections.filter(c=>c.buildingId===$("broadcastTarget").value);if(!targets.length)return toast("No Admin assigned to this building.");await sendLandlordNotification(me.uid,targets.map(c=>c.id),{title,message,type:$("broadcastType").value});closeModal();toast(`✅ Notification sent to ${targets.length} Admin${targets.length===1?"":"s"}`)}catch(e){console.error(e);toast(errorText(e,"Could not send notifications"))}};
}
function profileForm(){openModal("👤 Makan Malik Profile",`<div class="card" style="box-shadow:none;border:1px solid var(--border)"><div class="person-name">${esc(profile?.name||me.displayName||"Makan Malik")}</div><div class="person-meta">${esc(profile?.email||me.email||"")}</div><div class="person-meta" style="margin-top:5px">Role: Makan Malik</div></div><button id="profileLogout" class="btn btn-danger" style="margin-top:12px">↪ Logout</button>`);$("profileLogout").onclick=async()=>{await logoutUser();location.href=ROOT_PATH+"index.html"}}

$("addBuildingBtn").onclick=()=>propertyForm();
$("broadcastBtn").onclick=broadcastForm;
$("copyLandlordCode").onclick=copyLandlordCode;
$("fixCodeBtn").onclick=loadLandlordCode;
$("closeModal").onclick=closeModal;
$("modal").onclick=e=>{if(e.target.id==="modal")closeModal()};
$("logoutBtn").onclick=async()=>{await logoutUser();location.href=ROOT_PATH+"index.html"};
$("homeNav").onclick=()=>window.scrollTo({top:0,behavior:"smooth"});
$("noticeNav").onclick=broadcastForm;
$("profileNav").onclick=profileForm;

requireAuth({expectedRole:"landlord",onReady:async(user,p)=>{
  me=user;profile=p;
  $("welcome").textContent=p.name||user.displayName||"Makan Malik";
  $("loader").classList.add("hidden");$("app").classList.remove("hidden");
  await loadLandlordCode();
  try{await loadBuildings();}catch(e){console.error(e);$("buildingList").innerHTML=`<div class="empty-state"><div class="emoji">⚠️</div><h3>Buildings could not be loaded</h3><p>${esc(errorText(e,"Firebase error"))}</p></div>`;toast(errorText(e,"Could not load buildings"));}
  try{
    listenLandlordRequests(me.uid,renderRequests,e=>{console.error(e);toast(errorText(e,"Could not load Admin requests"))});
    listenLandlordConnections(me.uid,list=>{connections=list;renderConnections()},e=>{console.error(e);toast(errorText(e,"Could not load connections"))});
  }catch(e){console.error(e);toast(errorText(e,"Connection data could not be loaded"));}
}});
