import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.ts';
import {Dispatch} from '../src/domain.ts';
import {inspectDispatch} from '../src/diagnostics.ts';

function fixture(){const db=openDb();const app=new Dispatch(db);app.seed();return app;}
test('initial synthetic fixture has no critical mismatches but exposes warning cases',()=>{
 const app=fixture();const report=inspectDispatch(app.db,app.now());
 assert.equal(report.ok,true);assert.equal(report.stopPilot,false);
 assert(report.findings.some(f=>f.code==='failed_notification'));
 assert(report.findings.some(f=>f.code==='location_review_required'));
 app.db.close();
});
test('normal completed assignment leaves no phantom reservation',()=>{
 const app=fixture();app.start('J001');const offer=app.detail('J001').offers.find((o:any)=>o.status==='pending');
 assert(offer);app.accept(offer.id,'A');assert.equal(inspectDispatch(app.db,app.now()).ok,true);
 for(const state of ['en_route','arrived','in_progress','completed'])app.completeStep('J001',state);
 assert.equal(inspectDispatch(app.db,app.now()).ok,true);app.db.close();
});
test('read-only integrity inspector identifies unpaired reservations and assignments',()=>{
 const app=fixture();app.start('J001');const offer=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(offer);app.accept(offer.id,'A');
 app.db.prepare("UPDATE capacity_reservations SET active=0 WHERE job_id='J001'").run();
 const before=app.exportAudit().length,report=inspectDispatch(app.db,app.now());
 assert.equal(report.stopPilot,true);
 assert(report.findings.some(f=>f.code==='assignment_without_reservation'&&f.sampleIds.includes('J001')));
 assert.equal(app.exportAudit().length,before);
 app.db.close();
});
test('domain expiry worker refuses to mutate a critically inconsistent database',()=>{
 const app=fixture();
 app.start('J001');const accepted=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(accepted);
 app.accept(accepted.id,'A');
 app.start('J011');const overdue=app.detail('J011').offers.find((o:any)=>o.status==='pending');assert(overdue);
 app.db.prepare("UPDATE settings SET value=? WHERE key='demo_now'").run(String(overdue.expires_ms));
 app.db.prepare("UPDATE capacity_reservations SET active=0 WHERE job_id='J001'").run();
 assert.equal(inspectDispatch(app.db,app.now()).stopPilot,true);
 assert.throws(()=>app.tick(),/Dispatch paused/);
 assert.equal(app.detail('J011').offers.find((o:any)=>o.id===overdue.id)?.status,'pending');
 app.db.close();
});

test('active-status job missing its crew assignment triggers an integrity stop',()=>{
 const app=fixture();
 app.start('J001');const pending=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(pending);
 app.accept(pending.id,'A');
 app.db.prepare("UPDATE assignments SET current=0 WHERE job_id='J001'").run();
 const report=inspectDispatch(app.db,app.now());
 assert.equal(report.stopPilot,true);
 assert(report.findings.some(f=>f.code==='job_without_current_assignment'&&f.sampleIds.includes('J001')));
 assert.throws(()=>app.tick(),/Dispatch paused/);
 app.db.close();
});

test('orphaned active offer sequence without a pending offer blocks worker',()=>{
 const app=fixture();
 app.start('J001');const pending=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(pending);
 // Simulate an out-of-band failure after an offer is withdrawn without advancing the sequence.
 app.db.prepare("UPDATE offers SET status='cancelled' WHERE id=?").run(pending.id);
 const report=inspectDispatch(app.db,app.now());
 assert.equal(report.stopPilot,true);
 assert(report.findings.some(f=>f.code==='active_sequence_without_pending_offer'&&f.sampleIds.includes('J001')));
 assert.throws(()=>app.tick(),/Dispatch paused/);
 assert.equal(app.detail('J001').sequence?.status,'active');
 app.db.close();
});

test('inspector flags overdue pending offer without mutating it',()=>{
 const app=fixture();app.start('J001');const offer=app.detail('J001').offers.find((o:any)=>o.status==='pending');
 assert(offer);const report=inspectDispatch(app.db,offer.expires_ms);
 assert(report.findings.some(f=>f.code==='overdue_offer'&&f.sampleIds.includes('J001')));
 const unchanged=app.detail('J001').offers.find((o:any)=>o.id===offer.id);assert(unchanged);assert.equal(unchanged.status,'pending');
 app.db.close();
});

test('critical stored invariant blocks HTTP writes but allows read-only audit and diagnosis',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const {join,resolve}=await import('node:path');const {spawn}=await import('node:child_process');
 const {createServer}=await import('node:net');
 const dir=mkdtempSync(join(tmpdir(),'nb-integrity-stop-')),path=join(dir,'dispatch.sqlite');
 let db=openDb(path),app=new Dispatch(db);app.seed();app.start('J001');
 const offer=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(offer);
 app.accept(offer.id,'A');
 // Leave a separate offer overdue: even the autonomous worker must not mutate it
 // while a critical assignment/reservation mismatch persists.
 app.start('J011');
 const pending=app.detail('J011').offers.find((o:any)=>o.status==='pending');assert(pending);
 db.prepare("UPDATE settings SET value=? WHERE key='demo_now'").run(String(pending.expires_ms));
 db.prepare("UPDATE capacity_reservations SET active=0 WHERE job_id='J001'").run();db.close();
 const port=await new Promise<number>((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>ok(typeof a==='object'&&a?a.port:0));});});
 const child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
  cwd:resolve(import.meta.dirname,'..'),env:{...process.env,AUTH_MODE:'demo',PORT:String(port),DB_PATH:path},stdio:'ignore'
 });
 const url=`http://127.0.0.1:${port}`,headers={'X-Demo-Role':'dispatcher'};
 try{
  let started=false;for(let i=0;i<100;i++){try{if((await fetch(url+'/api/session')).ok){started=true;break;}}catch{}await new Promise(ok=>setTimeout(ok,30));}
  assert(started,'Server should start read-only access even with corrupted assignment state');
  const diag=await fetch(url+'/api/diagnostics',{headers});assert.equal(diag.status,200);
  assert.equal((await diag.json()).stopPilot,true);
  assert.equal((await fetch(url+'/api/audit.csv',{headers})).status,200);
  const blocked=await fetch(url+'/api/jobs/J001/step',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({status:'en_route'})});
  assert.equal(blocked.status,503);assert.match((await blocked.json()).error,/Dispatch paused/);
  const crew=await fetch(url+'/api/crew/offers/'+encodeURIComponent(offer.id)+'/decline',{method:'POST',headers:{'X-Demo-Crew-Token':'northbridge-demo-a'}});
  assert.equal(crew.status,503);
  const openAgain=await fetch(url+'/api/dashboard',{headers});assert.equal(openAgain.status,200);
  // Startup recovery and at least one scheduler polling cycle must both stay inert.
  await new Promise(ok=>setTimeout(ok,1350));
  const still=await fetch(url+'/api/jobs/J011',{headers});assert.equal(still.status,200);
  const state=await still.json();
  assert(state.offers.some((row:any)=>row.id===pending.id&&row.status==='pending'),
    'Overdue offer must remain pending while the integrity stop is active');
  assert.equal(state.timeline.filter((row:any)=>row.kind==='offer.expired').length,0);
 }finally{child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(ok=>child.once('exit',()=>ok()));rmSync(dir,{recursive:true,force:true});}
});
