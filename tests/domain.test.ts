import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Dispatch } from '../src/domain.ts';

function fixture() { const db=openDb(); const app=new Dispatch(db); app.seed(); return app; }
function offer(app:Dispatch,job:string): any { const pending=app.detail(job).offers.find((x:any)=>x.status==='pending'); assert(pending,`Expected pending offer for ${job}`); return pending; }
function reject(fn:()=>unknown,fragment:string) {assert.throws(fn,(e:any)=>e.message.toLowerCase().includes(fragment.toLowerCase()));}

test('fixture meets exact seed counts and risk cases',()=>{
 const a=fixture();const d=a.dashboard();
 assert.equal(d.jobs.length,15);assert.equal(d.crews.length,8);
 assert.equal(d.crews.filter(x=>x.remaining===0).length,2);
 assert.equal(d.crews.filter(x=>x.availability==='unavailable').length,1);
 assert(d.exceptions.some(e=>e.jobId==='J006'));
 assert(d.exceptions.some(e=>e.jobId==='J007'));
 assert(d.exceptions.some(e=>e.jobId==='J014'));
 assert(d.exceptions.some(e=>e.jobId==='J009' && e.kind.includes('failed')));
});

test('eligible ordering and documented exclusions',()=>{
 const a=fixture();const r=a.rank('J001').ranking;
 assert.deepEqual(r.filter(x=>x.eligible).map(x=>x.crewId),['A','B']);
 assert(r.find(x=>x.crewId==='G')?.reasons.includes('Crew unavailable'));
 assert(r.find(x=>x.crewId==='D')?.reasons.includes('At capacity'));
 assert(a.rank('J006').reviewReasons.includes('Missing address'));
 reject(()=>a.start('J006'),'Only new');
});

test('A declines after one minute, B receives next offer, A late reply rejected',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');
 assert.equal(alpha.crew_id,'A');a.advanceMinutes(1);a.decline(alpha.id,'A');
 const beacon=offer(a,'J001');assert.equal(beacon.crew_id,'B');
 reject(()=>a.accept(alpha.id,'A'),'no longer pending');
 a.accept(beacon.id,'B');
 assert.equal(a.detail('J001').assignment?.crew_id,'B');
 assert.equal(a.detail('J001').offers.filter((x:any)=>x.status==='accepted').length,1);
});

test('expiry and acceptance at exactly same timestamp: expiry wins',()=>{
 const a=fixture();a.start('J001');a.decline(offer(a,'J001').id,'A');
 const beacon=offer(a,'J001');a.advanceMinutes(5);
 reject(()=>a.accept(beacon.id,'B'),'no longer pending');
 assert.equal(a.detail('J001').assignment,null);
 assert.equal(a.getJob('J001').status,'unassigned');
 assert.equal(a.detail('J001').offers.filter((x:any)=>x.status==='accepted').length,0);
 assert.equal(a.tick().expired,0);
});

test('acceptance before expiration is preserved against later worker runs',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');a.advanceMinutes(4);
 a.accept(alpha.id,'A');a.advanceMinutes(10);
 assert.equal(a.detail('J001').assignment?.crew_id,'A');
 assert.equal(a.detail('J001').offers.filter((x:any)=>x.status==='accepted').length,1);
 assert.equal(a.dashboard().metrics.conflicts,0);
});

test('two jobs compete for B final slot; at most one reserves',()=>{
 const a=fixture();a.start('J001');a.start('J011');
 a.decline(offer(a,'J001').id,'A');a.decline(offer(a,'J011').id,'A');
 const first=offer(a,'J001'),second=offer(a,'J011');
 assert.equal(first.crew_id,'B');assert.equal(second.crew_id,'B');
 a.accept(first.id,'B');
 reject(()=>a.accept(second.id,'B'),'no longer eligible');
 assert.equal(a.getCrew('B').remaining,0);
 assert.equal(a.detail('J011').assignment,null);
 assert.equal(a.dashboard().metrics.conflicts,0);
});

test('crew can retry a successful accept without duplicating capacity or audit',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');a.accept(alpha.id,'A');
 const before=a.exportAudit().length;
 assert.deepEqual(a.accept(alpha.id,'A'),{success:true,jobId:'J001',crewId:'A',replayed:true});
 assert.equal(a.exportAudit().length,before);
 reject(()=>a.decline(alpha.id,'A'),'no longer pending');
 assert.equal(a.detail('J001').offers.filter((x:any)=>x.status==='accepted').length,1);
 assert.equal(a.getCrew('A').reserved,1);
 a.cancel('J001');
 reject(()=>a.accept(alpha.id,'A'),'no current matching assignment');
});
test('crew can retry a prior decline without escalating twice',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');a.decline(alpha.id,'A');
 const audits=a.exportAudit().length;
 assert.deepEqual(a.decline(alpha.id,'A'),{success:true,replayed:true});
 assert.equal(a.exportAudit().length,audits);
 assert.equal(a.detail('J001').offers.length,2);
 assert.equal(offer(a,'J001').crew_id,'B');
});

test('durable polling recovers expired offer after process/db restart exactly once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-dispatch-'));const path=join(dir,'state.sqlite');
 try {
  const first=new Dispatch(openDb(path));first.seed();first.start('J001');
  const alpha=offer(first,'J001');
  first.db.prepare("UPDATE settings SET value=? WHERE key='demo_now'").run(String(alpha.expires_ms));
  first.db.close();
  const second=new Dispatch(openDb(path));
  assert.equal(second.tick().expired,2); // J009's seeded pending offer also expires.
  assert.equal(offer(second,'J001').crew_id,'B');
  assert.equal(second.tick().expired,0);
  assert.equal(second.detail('J001').timeline.filter((x:any)=>x.kind==='offer.expired').length,1);
  second.db.close();
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test('cancelled offers cannot be resurrected',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');a.cancel('J001');
 reject(()=>a.accept(alpha.id,'A'),'no longer pending');
 assert.equal(a.detail('J001').assignment,null);
 assert.equal(a.getJob('J001').status,'cancelled');
 assert.equal(a.tick().expired,0);
});

test('crew access is scoped to token owner and unrelated offers are hidden',()=>{
 const a=fixture();a.start('J001');const alpha=offer(a,'J001');
 const inboxA=a.crewInbox('northbridge-demo-a');
 const inboxB=a.crewInbox('northbridge-demo-b');
 assert(inboxA.offers.some((x:any)=>x.job_id==='J001'));
 assert(!inboxB.offers.some((x:any)=>x.job_id==='J001'));
 reject(()=>a.accept(alpha.id,a.authenticateCrew('northbridge-demo-b')),'another crew');
 reject(()=>a.crewInbox('wrong-token'),'Invalid');
});

test('pause prevents escalation while keeping deadline meaningful',()=>{
 const a=fixture();a.start('J001');a.pause('J001');a.advanceMinutes(6);
 assert.equal(a.detail('J001').offers.filter((x:any)=>x.status==='pending').length,0);
 assert.equal(a.detail('J001').offers.length,1);
 a.resume('J001');assert.equal(offer(a,'J001').crew_id,'B');
});

test('manual override requires reason, eligibility and physical capacity',()=>{
 const a=fixture();reject(()=>a.override('J001','D','Manual dispatch confirmed'),'blocked');
 reject(()=>a.override('J001','A','short'),'substantive');
 a.override('J001','A','Synthetic dispatcher confirmed immediate availability');
 assert.equal(a.getCrew('A').remaining,1);
 assert.equal(a.detail('J001').assignment?.crew_id,'A');
 assert(a.exportAudit().some((x:any)=>x.action==='assignment.override'&&x.job_id==='J001'));
});

test('full fulfillment releases crew reservation and records all milestones',()=>{
 const a=fixture();a.start('J001');a.accept(offer(a,'J001').id,'A');
 for(const step of ['en_route','arrived','in_progress','completed'])a.completeStep('J001',step);
 assert.equal(a.getCrew('A').remaining,2);
 assert.equal(a.getJob('J001').status,'completed');
 assert.equal(a.detail('J001').timeline.filter((x:any)=>x.kind.startsWith('job.')).length,4);
 reject(()=>a.completeStep('J001','cancelled'),'invalid transition');
});

test('new missing address is held for review and can be manually confirmed',()=>{
 const a=fixture();const created=a.createJob({title:'Sample water response',job_type:'Mitigation',urgency:'urgent',address:'',region:'Manhattan',skills:['Water mitigation'],confirmed:false});
 assert.equal(created.job.status,'review');
 reject(()=>a.start(created.job.id),'Only new');
 a.confirmLocation(created.job.id,{address:'100 W 23rd St, Manhattan',region:'Manhattan',confirmed:true});
 assert.equal(a.getJob(created.job.id).status,'new');a.start(created.job.id);
 assert.equal(a.getJob(created.job.id).status,'offering');
});

test('exhausted sequence can be restarted with fresh ranking and audit record',()=>{
 const a=fixture();a.start('J014');
 assert.equal(a.getJob('J014').status,'offering');
 const old=offer(a,'J014');a.advanceMinutes(5);a.advanceMinutes(5);
 assert.equal(a.getJob('J014').status,'unassigned');
 a.start('J014');
 // Previous ordinal remains unique; new attempts use the next ordinal.
 assert.equal(offer(a,'J014').ordinal,3);
 assert.equal(a.detail('J014').offers.length,3);
});

test('failed simulated channel is a visible, retryable notification attempt',()=>{
 const a=fixture();const offerC=offer(a,'J009');
 assert.equal(offerC.crew_id,'C');
 assert.equal(a.detail('J009').notifications[0].status,'failed');
 a.retryNotification(offerC.id);
 assert.equal(a.detail('J009').notifications.length,2);
 assert(a.detail('J009').notifications.every((x:any)=>x.status==='failed'));
});


test('crew configuration changes eligibility, can restore the failed channel, and is audited',()=>{
 const a=fixture();const before=a.getCrew('C');
 assert.equal(before.channel,'unavailable');
 const after=a.editCrew('C',{channel:'in_app',availability:'available',skills:['Water mitigation'],areas:['Queens'],max_capacity:2,baseline_load:0});
 assert.equal(after.channel,'in_app');
 assert(a.exportAudit().some((x:any)=>x.action==='crew.update'));
 a.retryNotification(offer(a,'J009').id);
 assert.equal(a.detail('J009').notifications[0].status,'simulated');
});

test('crew edits preserve active assignment skills and capacity',()=>{
 const a=fixture();a.start('J001');a.accept(offer(a,'J001').id,'A');
 reject(()=>a.editCrew('A',{skills:['Commercial cleaning']}),'current assignment');
 reject(()=>a.editCrew('A',{areas:['Brooklyn']}),'current assignment');
 reject(()=>a.editCrew('A',{max_capacity:1,baseline_load:1}),'capacity cannot');
 assert(a.getCrew('A').skills.includes('Water mitigation'));
 assert.equal(a.getCrew('A').remaining,1);
 assert.equal(a.detail('J001').assignment?.crew_id,'A');
});

test('changing availability during a live offer prevents an unauthorized acceptance',()=>{
 const a=fixture();a.start('J001');const pending=offer(a,'J001');
 a.editCrew('A',{availability:'unavailable'});
 reject(()=>a.accept(pending.id,'A'),'no longer eligible');
 assert.equal(a.detail('J001').assignment,null);
 a.advanceMinutes(5);
 assert.equal(offer(a,'J001').crew_id,'B');
});
