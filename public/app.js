const root=document.getElementById('root');
const toast=document.getElementById('toast');
const state={view:'dispatch',selected:'J001',filter:'all',crew:'A',dashboard:null,detail:null,inbox:null,modal:null,busy:false,session:null,refreshSeq:0,lastSyncAt:null};
const esc=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const humanStatus=s=>String(s??'').replaceAll('_',' ');
const status=s=>`<span class="status ${esc(s)}">${esc(humanStatus(s))}</span>`;
const fmt=ms=>new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(ms))+' ET';
const button=(label,action,style='',more='')=>`<button class="button ${style}" type="button" data-action="${action}" ${more}>${label}</button>`;
function notice(message,error=false){toast.textContent=message;toast.className='show'+(error?' error':'');clearTimeout(notice.timer);notice.timer=setTimeout(()=>toast.className='',4500);}
async function api(path,{method='GET',body=null,crew=false}={}){
 const headers={'Content-Type':'application/json'};
 if(state.session?.mode==='preview'){
  if(method!=='GET')headers['X-CSRF-Token']=state.session.csrfToken;
 } else if(crew)headers['X-Demo-Crew-Token']=`northbridge-demo-${state.crew.toLowerCase()}`;
 else headers['X-Demo-Role']='dispatcher';
 const r=await fetch(path,{method,headers,body:body==null?undefined:JSON.stringify(body)});
 const data=await r.json().catch(()=>({error:'Service returned a non-JSON response'}));
 if(!r.ok){
  if(r.status===401&&state.session?.mode==='preview'){
    state.session={mode:'preview',authenticated:false};state.dashboard=null;state.inbox=null;
    state.modal=null;render();
  }
  throw Error(data.error||`Request failed (${r.status})`);
 }
 return data;
}
function syncLabel(healthy){
 const statusEl=document.getElementById('sync-status');if(!statusEl)return;
 const timestamp=state.lastSyncAt?new Date(state.lastSyncAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'never';
 statusEl.dataset.state=healthy?'ok':'stale';
 statusEl.textContent=healthy?`Updated ${timestamp}`:`Disconnected · last update ${timestamp}`;
}
async function refresh({background=false}={}){
 const seq=++state.refreshSeq;
 try{
  if(state.session?.mode==='preview' && state.session.role==='crew'){
    const inbox=await api('/api/crew/inbox',{crew:true});
    if(seq!==state.refreshSeq||(background&&(state.modal||document.querySelector('dialog[open]'))))return;
    state.view='crew';state.crew=state.session.crewId;state.inbox=inbox;
    state.dashboard=null;state.detail=null;
  }else{
    const dashboard=await api('/api/dashboard');
    const selected=dashboard.jobs.some(x=>x.id===state.selected)?state.selected:dashboard.jobs[0]?.id;
    const detail=selected?await api(`/api/jobs/${encodeURIComponent(selected)}`):null;
    const inbox=state.view==='crew'?await api('/api/crew/inbox',{crew:true}):null;
    if(seq!==state.refreshSeq||(background&&(state.modal||document.querySelector('dialog[open]'))))return;
    state.dashboard=dashboard;state.selected=selected;state.detail=detail;
    if(inbox)state.inbox=inbox;
  }
  state.lastSyncAt=Date.now();syncLabel(true);render();
 }catch(error){if(seq===state.refreshSeq)syncLabel(false);throw error;}
}
function metric(label,value,hint){return `<div class="metric"><div class="eyebrow">${label}</div><div class="num">${esc(value)}</div><div class="hint">${hint}</div></div>`;}
function render(){
 document.querySelectorAll('.tab').forEach(b=>{
  b.hidden=state.session?.mode==='preview' && state.session.authenticated && (b.dataset.view===(state.session.role==='crew'?'dispatch':'crew')); 
  b.classList.toggle('active',b.dataset.view===state.view);b.setAttribute('aria-current',String(b.dataset.view===state.view));
 });
 const logout=document.getElementById('preview-logout');if(logout)logout.hidden=state.session?.mode!=='preview'||!state.session.authenticated;
 root.innerHTML=state.session?.mode==='preview'&&!state.session.authenticated?renderLogin():
  (state.dashboard||state.inbox)?(state.view==='dispatch'?renderDispatch():renderCrew()):'<div class="loading">Loading synthetic dispatch data…</div>';
 if(state.modal)root.insertAdjacentHTML('beforeend',renderModal());
}
function renderLogin(){
 return `<div class="layout" style="max-width:620px;margin:45px auto"><section class="panel clock-card"><span class="eyebrow">NORTHBRIDGE / RESTRICTED PREVIEW</span><h1>Sign in to preview</h1><p class="lead">Synthetic demo only. Each preview session has an explicit dispatcher or crew role; no customer data or external messages are connected.</p>
 <form id="login-form" class="form-grid">
  <label class="full"><span class="field-label">Role</span><select name="role" id="login-role"><option value="dispatcher">Dispatcher</option><option value="crew">Crew</option></select></label>
  <label class="full" id="login-crew-wrap" hidden><span class="field-label">Crew</span><select name="crewId">${'ABCDEFGH'.split('').map(id=>`<option>${id}</option>`).join('')}</select></label>
  <label class="full"><span class="field-label">Access key</span><input type="password" name="key" required minlength="32" autocomplete="off" placeholder="Enter your private preview key"></label>
  <div class="form-actions full"><button class="button primary" type="submit">Sign in</button></div>
  <p class="note full">Keys are supplied separately by the preview operator, not included in GitHub. Sessions expire after eight hours or when the server restarts.</p>
 </form></section></div>`;
}
function renderDispatch(){
 const d=state.dashboard;
 const jobs=d.jobs.filter(j=>state.filter==='all'||j.status===state.filter);
 const s=state.detail;
 return `<div class="layout">
  <div class="heading"><div><span class="eyebrow">SERVICE OPERATIONS / DISPATCH CONSOLE</span><h1>Dispatch overview</h1><p class="lead">Coordinate crew offers and exceptions with an auditable, deterministic workflow.</p></div>
   <div class="actions">${button('↻ Refresh','refresh')}${button('Shadow-mode pilot','pilot-open')}${button('Integrity check','diagnostics-open')}${button('+ New service request','create-open','primary')}</div></div>
  <section class="metrics" aria-label="Operational counts">${metric('OPEN REQUESTS',d.metrics.open,'Not completed or cancelled')}${metric('ASSIGNED / COMPLETED',d.metrics.assigned,'Including work in progress')}${metric('PENDING OFFERS',d.metrics.pending,'Awaiting crew response')}${metric('ACTIVE CONFLICTS',d.metrics.conflicts,'Current duplicate assignments')}</section>
  <div class="workspace"><div>
    <section class="panel"><div class="panel-title"><div><h2>Service requests</h2><p class="panel-sub">${jobs.length} shown · select a request to inspect</p></div><label><span class="field-label">Filter</span><select class="filter" id="filter"><option value="all" ${state.filter==='all'?'selected':''}>All requests</option>${['new','review','offering','unassigned','assigned','en_route','arrived','in_progress','completed','cancelled'].map(x=>`<option value="${x}" ${state.filter===x?'selected':''}>${humanStatus(x)}</option>`).join('')}</select></label></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Request</th><th>Priority</th><th>Region</th><th>Status</th></tr></thead><tbody>${jobs.map(j=>`<tr data-job="${esc(j.id)}" tabindex="0" role="button" aria-label="Inspect ${esc(j.title)}" class="${j.id===state.selected?'selected':''}"><td><span class="job-name">${esc(j.title)}</span><span class="job-id">${esc(j.id)}</span></td><td class="${esc(j.urgency)}">${esc(j.urgency)}</td><td>${esc(j.region)}</td><td>${status(j.status)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">No requests match this filter</td></tr>'}</tbody></table></div></section>
    <section class="panel" style="margin-top:18px"><div class="panel-title"><div><h2>Attention required</h2><p class="panel-sub">Exceptions with a next action, not success claims</p></div><span class="tag">${d.exceptions.length} cases</span></div><div class="exception-list">${d.exceptions.map(e=>`<button class="exception" data-job="${esc(e.jobId)}"><span class="mark">!</span><span><strong>${esc(e.kind)}</strong><small>${esc(e.jobId)} · Open to review and recover</small></span></button>`).join('')||'<div class="empty">No outstanding exceptions.</div>'}</div></section>
  </div><section class="panel detail-panel">${s?renderDetail(s):'<div class="empty">Select a request</div>'}</section></div>
  <div class="bottom-grid"><section class="panel clock-card"><span class="eyebrow">SIMULATED OPERATIONS CLOCK</span><div class="clock-time">${fmt(d.clock.nowMs)}</div><p class="lead">Deadlines use persisted server-authoritative demo time. Advance to process expired offers.</p><div class="clock-row" style="margin-top:16px"><select id="minutes" aria-label="Clock advance interval"><option value="1">+1 minute</option><option value="4">+4 minutes</option><option value="5">+5 minutes</option><option value="10">+10 minutes</option></select>${button('Advance clock','advance','primary')}${button('Run worker','tick')}</div></section>
   <section class="panel clock-card"><span class="eyebrow">CREW CAPACITY / STATUS</span><div style="margin-top:12px">${d.crews.map(c=>`<div class="ranking-row"><span class="rank-symbol ${c.remaining?'':'no'}">${esc(c.id)}</span><div class="rank-copy"><strong>${esc(c.name)}</strong><p>${esc(c.remaining)} free of ${esc(c.max_capacity)} slots · ${esc(c.availability)}</p></div><button type="button" class="button small" data-crew-edit="${esc(c.id)}">Edit</button></div>`).join('')}</div></section></div>
 <p class="note">Synthetic organization, locations and people. In-app notifications are simulations; no SMS, route ETA, automatic staffing judgment, or connected integrations. ${button('Reset synthetic data','reset-open','ghost small')}${button('Export audit CSV','export','ghost small')}</p>
 </div>`;
}
function renderDetail(x){
 const j=x.job; const rank=x.ranking.ranking;
 const pending=x.offers.find(o=>o.status==='pending');
 const step={assigned:'en_route',en_route:'arrived',arrived:'in_progress',in_progress:'completed'}[j.status];
 const sequence=x.sequence?.status;
 return `<div class="detail"><div class="detail-head"><div><span class="eyebrow">REQUEST DETAIL / ${esc(j.id)}</span><h3>${esc(j.title)}</h3></div>${status(j.status)}</div>
  <p class="lead">${esc(j.job_type)} · ${esc(j.urgency.toUpperCase())}</p>
  <dl class="info-grid"><div><dt>Service address</dt><dd>${esc(j.address||'Not supplied')}</dd></div><div><dt>Region</dt><dd>${esc(j.region)}</dd></div><div><dt>Location evidence</dt><dd>${esc(humanStatus(j.location_status))}</dd></div><div><dt>Current assignment</dt><dd>${x.assignment?esc(x.assignment.crew_id):'Not assigned'}</dd></div></dl>
  <div>${j.skills.map(t=>`<span class="skill">${esc(t)}</span>`).join('')}</div>
  ${x.ranking.reviewReasons.length?`<div class="callout warning" style="margin-top:15px"><strong>Location review needed:</strong> ${esc(x.ranking.reviewReasons.join('; '))}</div>`:''}
  <div class="inline-controls">${['new','unassigned'].includes(j.status)?button(j.status==='unassigned'?'Restart offers':'Start offer sequence','start','primary'):''}${j.status==='review'?button('Confirm location','confirm-open','primary'):''}
   ${sequence==='active'?button('Pause escalation','pause'):''}${sequence==='paused'?button('Resume escalation','resume','primary'):''}
   ${step?button('Mark '+humanStatus(step),'step','primary'):''}${['new','unassigned','offering'].includes(j.status)?button('Manual assignment','override-open'):''}
   ${!['completed','cancelled'].includes(j.status)?button('Cancel job','cancel','danger'):''}</div>
  ${pending?`<div class="callout" style="margin-top:15px"><strong>Pending offer to Crew ${esc(pending.crew_id)}</strong> · Offer ${esc(pending.ordinal)} expires ${fmt(pending.expires_ms)}. ${sequence==='paused'?'Escalation paused; expiry still applies.':''}</div>`:''}
  <div class="section-rule"></div><h4>Eligibility ranking</h4><p class="note">${esc(x.ranking.metric)}</p><div>${rank.map((r,i)=>`<div class="ranking-row"><span class="rank-symbol ${r.eligible?'':'no'}">${r.eligible?i+1:'×'}</span><div class="rank-copy"><strong>${esc(r.name)} (${esc(r.crewId)})</strong><p>${r.eligible?'Eligible · '+r.remaining+' capacity slot(s) available':esc(r.reasons.join('; '))}</p></div><span class="note">${r.proximityKm==null?'No coordinate':r.proximityKm.toFixed(1)+' km'}</span></div>`).join('')}</div>
  <div class="section-rule"></div><h4>Offer history &amp; notification evidence</h4>
  ${x.offers.length?x.offers.map(o=>`<div class="ranking-row"><span class="rank-symbol ${o.status==='accepted'?'':'no'}">${esc(o.ordinal)}</span><div class="rank-copy"><strong>Crew ${esc(o.crew_id)} · ${esc(humanStatus(o.status))}</strong><p>${fmt(o.created_ms)} → ${fmt(o.expires_ms)}</p></div>${o.status==='pending'?`<button class="button small" data-action="retry" data-offer="${esc(o.id)}">Retry channel</button>`:status(o.status)}</div>`).join(''):'<p class="note">No offer attempts yet.</p>'}
  ${x.notifications.map(n=>`<p class="note"><strong>${n.status==='failed'?'⚠':'✓'} ${esc(humanStatus(n.status))}:</strong> ${esc(n.detail)}</p>`).join('')}
  <div class="section-rule"></div><h4>State event timeline</h4><div class="timeline">${x.timeline.map(e=>`<div class="event"><strong>${esc(humanStatus(e.kind))}</strong><p>${esc(e.detail)}</p><time>${fmt(e.at_ms)}</time></div>`).join('')||'<p class="note">No events recorded</p>'}</div>
 </div>`;
}
function renderCrew(){
 const inbox=state.inbox;
 return `<div class="layout crew-layout"><div class="heading"><div><span class="eyebrow">CREW RESPONSE / DEMONSTRATION</span><h1>Crew offer inbox</h1><p class="lead">A crew can view and respond only to offers addressed to its demo identity.</p></div>${button('↻ Refresh inbox','refresh')}</div>
  <div class="panel crew-card"><div class="eyebrow">SELECT SYNTHETIC CREW</div><div class="crew-controls"><label><span class="field-label">${state.session?.mode==='preview'?'Authenticated crew':'Demo identity'}</span>${state.session?.mode==='preview'?`<strong>${esc(state.inbox?.crewId||state.crew)} · ${esc(state.inbox?.name||'Crew')}</strong>`:`<select id="crew-select">${state.dashboard.crews.map(c=>`<option value="${esc(c.id)}" ${c.id===state.crew?'selected':''}>${esc(c.id)} · ${esc(c.name)}</option>`).join('')}</select>`}</label></div>
  <p class="note">${state.session?.mode==='preview'?'Crew role is enforced by a server-side session; switching identities is disabled.':'This switcher is deliberate demo impersonation. The server still checks each synthetic credential against the recipient of every offer; it is not a production authentication system.'}</p><div class="section-rule"></div>
  <h2>${inbox?esc(inbox.name):'Crew'} · incoming offers</h2><p class="lead">Server clock: ${fmt((state.dashboard?.clock||state.inbox?.clock).nowMs)}. Acceptance is valid strictly before expiration; clicking after expiry will be rejected.</p>
  ${inbox?.offers.length?inbox.offers.map(o=>`<article class="offer-card"><div class="offer-header"><div><span class="eyebrow">${esc(o.job_id)} / ${esc(o.urgency)}</span><h3>${esc(o.title)}</h3></div>${status(o.status)}</div>
    <dl class="info-grid"><div><dt>Service area</dt><dd>${esc(o.region)}</dd></div><div><dt>Address</dt><dd>${esc(o.address)}</dd></div><div><dt>Offer expires</dt><dd class="expiry">${fmt(o.expires_ms)}</dd></div><div><dt>Category</dt><dd>${esc(o.job_type)}</dd></div></dl>
    <div class="inline-controls">${button('Accept assignment','accept','primary',`data-offer="${esc(o.id)}"`)}${button('Decline','decline','danger',`data-offer="${esc(o.id)}"`)}</div></article>`).join(''):'<div class="empty">No active offers for this crew. Select a different identity or start a dispatch sequence from the dispatcher view.</div>'}
  <div class="callout">Crew views intentionally omit unrelated requests, crew roster details, ranking explanations and the dispatcher audit log.</div></div></div>`;
}
function renderModal(){
 const m=state.modal;
 const title={create:'New service request',confirm:'Confirm service location',override:'Manual assignment',reset:'Reset synthetic demo'}[m];
 let content='';
 if(m==='create')content=`<form id="modal-form" class="form-grid"><label><span class="field-label">Request title *</span><input name="title" required maxlength="120" placeholder="Water leak at Midtown office"></label><label><span class="field-label">Job type *</span><input name="job_type" required maxlength="80" placeholder="Water mitigation"></label>
  <label><span class="field-label">Urgency *</span><select name="urgency"><option value="emergency">Emergency</option><option value="urgent">Urgent</option><option value="routine">Routine</option></select></label><label><span class="field-label">Service region *</span><select name="region"><option>Manhattan</option><option>Brooklyn</option><option>Queens</option><option>Newark</option></select></label>
  <label class="full"><span class="field-label">Address</span><input name="address" maxlength="200" placeholder="Manually supplied address"></label>
  <div class="full"><span class="field-label">Required operational skills *</span><div class="checkbox-row">${['Water mitigation','Fire restoration','Commercial cleaning','Mold remediation'].map((s,i)=>`<label class="checkpill"><input type="checkbox" name="skills" value="${esc(s)}" ${i===0?'checked':''}>${esc(s)}</label>`).join('')}</div></div>
  <label><span class="field-label">Latitude (optional)</span><input name="lat" type="number" step="any" min="-90" max="90" placeholder="40.75"></label><label><span class="field-label">Longitude (optional)</span><input name="lon" type="number" step="any" min="-180" max="180" placeholder="-73.99"></label>
  <label class="full checkpill"><input name="confirmed" type="checkbox">I manually confirmed this address and service region</label>
  <p class="note full">Unconfirmed, missing, and out-of-area addresses enter the review queue. No geocoding takes place.</p>${footer('Create request')}</form>`;
 else if(m==='confirm')content=`<form id="modal-form" class="form-grid"><label class="full"><span class="field-label">Verified service address</span><input name="address" value="${esc(state.detail.job.address||'')}" required></label><label class="full"><span class="field-label">Authorized service region</span><select name="region">${['Manhattan','Brooklyn','Queens'].map(x=>`<option ${x===state.detail.job.region?'selected':''}>${x}</option>`).join('')}</select></label><label class="full checkpill"><input name="confirmed" type="checkbox" required> I have manually verified the address and region</label>${footer('Confirm and unlock ranking')}</form>`;
 else if(m==='override')content=`<form id="modal-form" class="form-grid"><p class="note full">Manual assignment requires eligible operational skills, authorized region, available capacity, and a recorded reason. It never bypasses physical capacity limits.</p><label class="full"><span class="field-label">Eligible crew</span><select name="crewId">${state.detail.ranking.ranking.filter(x=>x.eligible).map(x=>`<option value="${esc(x.crewId)}">${esc(x.crewId)} · ${esc(x.name)} · ${x.remaining} available</option>`).join('')}</select></label><label class="full"><span class="field-label">Attributable reason *</span><textarea rows="3" name="reason" minlength="8" required placeholder="Dispatcher confirmed immediate coverage by phone in this synthetic scenario"></textarea></label>${footer('Assign crew')}</form>`;
 else content=`<p>Clear and restore all fictional demo data to the initial 15-job, eight-crew fixture? This cannot be undone in the demo database.</p><div class="form-actions">${button('Keep data','modal-close')}${button('Reset demo','reset-confirm','danger')}</div>`;
 return `<div class="drawer" role="presentation"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-top"><span class="eyebrow">NORTHBRIDGE / OPERATIONS</span><button class="close" data-action="modal-close" aria-label="Close dialog">×</button></div><h2>${title}</h2>${content}</div></div>`;
}
function footer(text){return `<div class="form-actions full">${button('Cancel','modal-close')}<button class="button primary" type="submit">${esc(text)}</button></div>`;}
async function act(name,el){
 if(state.busy)return;
 state.busy=true;
 try {
  const jid=state.selected;
  const post=(url,body={})=>api(url,{method:'POST',body});
  if(name==='logout'){
    await api('/api/session/logout',{method:'POST'});
    state.session={mode:'preview',authenticated:false};window.nbCsrf=null;state.dashboard=null;state.inbox=null;state.modal=null;render();return;
  }
  if(name==='refresh')await refresh();
  else if(name==='pilot-open'){window.nbOpenPilot?.();return;}
  else if(name==='diagnostics-open'){window.nbOpenDiagnostics?.();return;}
  else if(name==='create-open')state.modal='create';
  else if(name==='confirm-open')state.modal='confirm';
  else if(name==='override-open')state.modal='override';
  else if(name==='reset-open')state.modal='reset';
  else if(name==='modal-close')state.modal=null;
  else if(name==='start')await post(`/api/jobs/${jid}/start`);
  else if(name==='pause')await post(`/api/jobs/${jid}/pause`);
  else if(name==='resume')await post(`/api/jobs/${jid}/resume`);
  else if(name==='cancel'){if(!confirm('Cancel the selected job and any pending offer?'))return;await post(`/api/jobs/${jid}/cancel`);}
  else if(name==='step'){const transitions={assigned:'en_route',en_route:'arrived',arrived:'in_progress',in_progress:'completed'};await post(`/api/jobs/${jid}/step`,{status:transitions[state.detail.job.status]});}
  else if(name==='retry')await post(`/api/offers/${el.dataset.offer}/retry`);
  else if(name==='advance')await post('/api/demo/advance',{minutes:Number(document.getElementById('minutes').value)});
  else if(name==='tick')await post('/api/demo/tick');
  else if(name==='reset-confirm'){await post('/api/demo/reset');state.selected='J001';state.modal=null;}
  else if(name==='accept'||name==='decline')await api(`/api/crew/offers/${el.dataset.offer}/${name}`,{method:'POST',crew:true});
  else if(name==='export'){
   const r=await fetch('/api/audit.csv',{headers:{'X-Demo-Role':'dispatcher'}});
   if(!r.ok)throw Error('Audit export failed');
   const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download='northbridge-demo-audit.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
   notice('Audit CSV exported');return;
  }
  if(name!=='refresh'){await refresh();}
  if(!['create-open','confirm-open','override-open','reset-open','modal-close'].includes(name))notice('Demo state updated and persisted');
 }catch(e){notice(e.message||String(e),true);}
 finally{state.busy=false;}
}
document.addEventListener('click',e=>{
 const tab=e.target.closest('[data-view]');if(tab){state.view=tab.dataset.view;refresh().catch(err=>notice(err.message,true));return;}
 const job=e.target.closest('[data-job]');if(job){state.selected=job.dataset.job;refresh().catch(err=>notice(err.message,true));return;}
 const button=e.target.closest('[data-action]');if(button)act(button.dataset.action,button);
});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('tr[data-job]')){e.preventDefault();state.selected=e.target.dataset.job;refresh().catch(err=>notice(err.message,true));}if(e.key==='Escape'&&state.modal){state.modal=null;render();}});
document.addEventListener('change',e=>{
 if(e.target.id==='login-role'){const wrap=document.getElementById('login-crew-wrap');if(wrap)wrap.hidden=e.target.value!=='crew';}
 if(e.target.id==='filter'){state.filter=e.target.value;render();}
 if(e.target.id==='crew-select'){state.crew=e.target.value;refresh().catch(err=>notice(err.message,true));}
});
document.addEventListener('submit',async e=>{
 if(e.target.id==='login-form'){
   e.preventDefault();if(state.busy)return;state.busy=true;
   try{
     const data=new FormData(e.target);
     const response=await fetch('/api/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:data.get('role'),crewId:data.get('crewId'),key:data.get('key')})});
     const result=await response.json();if(!response.ok)throw Error(result.error||'Login failed');
     state.session=result;state.view=result.role==='crew'?'crew':'dispatch';state.crew=result.crewId||'A';
     window.nbCsrf=result.csrfToken;await refresh();notice('Preview session started');
   }catch(error){notice(error.message||String(error),true);}finally{state.busy=false;}
   return;
 }
 if(e.target.id!=='modal-form')return;
 e.preventDefault();if(state.busy)return;state.busy=true;
 try{
 const data=new FormData(e.target),post=(url,body)=>api(url,{method:'POST',body});
 let result;
 if(state.modal==='create')result=await post('/api/jobs',{title:data.get('title'),job_type:data.get('job_type'),urgency:data.get('urgency'),address:data.get('address'),region:data.get('region'),skills:data.getAll('skills'),lat:data.get('lat'),lon:data.get('lon'),confirmed:data.has('confirmed')});
 if(state.modal==='confirm')result=await post(`/api/jobs/${state.selected}/confirm`,{address:data.get('address'),region:data.get('region'),confirmed:data.has('confirmed')});
 if(state.modal==='override')result=await post(`/api/jobs/${state.selected}/override`,{crewId:data.get('crewId'),reason:data.get('reason')});
 if(result)state.selected=result.job.id;
 state.modal=null;await refresh();notice('Request saved with a new audit event');
 }catch(err){notice(err.message||String(err),true);}finally{state.busy=false;}
});
(async()=>{
 state.session=await fetch('/api/session').then(r=>r.json());
 window.nbCsrf=state.session.csrfToken;
 if(state.session.mode==='preview'&&!state.session.authenticated){render();return;}
 if(state.session.mode==='preview'&&state.session.role==='crew'){state.view='crew';state.crew=state.session.crewId;}
 await refresh();
})().catch(err=>{root.innerHTML=`<div class="layout"><div class="callout warning"><strong>Unable to load demo.</strong> ${esc(err.message)}<p>Start the local server and refresh. No connected service is assumed.</p></div></div>`;notice(err.message,true);});

// Keep the crew offer inbox and dispatcher console current without interrupting edits.
// The server remains authoritative for deadlines; this timer only refreshes presentation.
setInterval(()=>{
 if(document.hidden||state.busy||state.modal||document.querySelector('dialog[open]')||
    (state.session?.mode==='preview'&&!state.session.authenticated))return;
 refresh({background:true}).catch(()=>{}); // A visible sync indicator reports disconnection without toast spam.
},15000);
