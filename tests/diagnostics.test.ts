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
test('inspector flags overdue pending offer without mutating it',()=>{
 const app=fixture();app.start('J001');const offer=app.detail('J001').offers.find((o:any)=>o.status==='pending');
 assert(offer);const report=inspectDispatch(app.db,offer.expires_ms);
 assert(report.findings.some(f=>f.code==='overdue_offer'&&f.sampleIds.includes('J001')));
 const unchanged=app.detail('J001').offers.find((o:any)=>o.id===offer.id);assert(unchanged);assert.equal(unchanged.status,'pending');
 app.db.close();
});
