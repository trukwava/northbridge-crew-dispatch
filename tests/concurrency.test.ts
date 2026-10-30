import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {openDb} from '../src/db.ts';
import {Dispatch} from '../src/domain.ts';
import {inspectDispatch} from '../src/diagnostics.ts';

const root=resolve(import.meta.dirname,'..');
function worker(path:string,operation:'accept'|'tick',offerId='',crew=''){
 return new Promise<{ok:boolean;error?:string;value?:any}>((yes,no)=>{
  const child=spawn(process.execPath,['--experimental-strip-types','tests/concurrency-worker.ts',operation,path,offerId,crew],{cwd:root,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.setEncoding('utf8');child.stdout.on('data',x=>out+=x);
  child.stderr.setEncoding('utf8');child.stderr.on('data',x=>err+=x);
  child.once('error',no);child.once('exit',()=>{try{yes(JSON.parse(out.trim().split('\n').at(-1)!));}catch(e){no(Error(`Child failed: ${out} / ${err}`));}});
 });
}
function pending(app:Dispatch,job:string){const o=app.detail(job).offers.find((row:any)=>row.status==='pending');assert(o);return o;}

test('separate processes racing for B final slot reserve it at most once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-two-workers-'));const path=join(dir,'dispatch.sqlite');
 try{
  let db=openDb(path),app=new Dispatch(db);app.seed();app.start('J001');app.start('J011');
  app.decline(pending(app,'J001').id,'A');app.decline(pending(app,'J011').id,'A');
  const first=pending(app,'J001'),second=pending(app,'J011');
  assert.equal(first.crew_id,'B');assert.equal(second.crew_id,'B');db.close();
  const results=await Promise.all([worker(path,'accept',first.id,'B'),worker(path,'accept',second.id,'B')]);
  assert.equal(results.filter(x=>x.ok).length,1,JSON.stringify(results));
  db=openDb(path);app=new Dispatch(db);
  assert.equal(app.getCrew('B').remaining,0);
  assert.equal([app.detail('J001'),app.detail('J011')].filter(x=>x.assignment?.crew_id==='B').length,1);
  assert.equal(inspectDispatch(db,app.now()).stopPilot,false);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('duplicate cross-process acceptance cannot create duplicate assignments',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-same-worker-'));const path=join(dir,'dispatch.sqlite');
 try{
  let db=openDb(path),app=new Dispatch(db);app.seed();app.start('J001');const offer=pending(app,'J001');db.close();
  const results=await Promise.all([worker(path,'accept',offer.id,'A'),worker(path,'accept',offer.id,'A')]);
  assert.equal(results.filter(x=>x.ok).length,1,JSON.stringify(results));
  db=openDb(path);app=new Dispatch(db);
  assert.equal(app.detail('J001').offers.filter((x:any)=>x.status==='accepted').length,1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM assignments WHERE job_id=? AND current=1').get('J001')?.n,1);
  assert.equal(inspectDispatch(db,app.now()).stopPilot,false);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('two separate expiry workers processing persisted deadline do not duplicate escalation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-two-expiry-'));const path=join(dir,'dispatch.sqlite');
 try{
  let db=openDb(path),app=new Dispatch(db);app.seed();app.start('J001');const original=pending(app,'J001');
  db.prepare("UPDATE settings SET value=? WHERE key='demo_now'").run(String(original.expires_ms));db.close();
  const results=await Promise.all([worker(path,'tick'),worker(path,'tick')]);
  assert(results.every(x=>x.ok),JSON.stringify(results));
  db=openDb(path);app=new Dispatch(db);
  assert.equal(app.detail('J001').timeline.filter((e:any)=>e.kind==='offer.expired').length,1);
  assert.equal(pending(app,'J001').crew_id,'B');
  assert.equal(app.detail('J001').offers.filter((e:any)=>e.status==='pending').length,1);
  assert.equal(app.tick().expired,0);
  assert.equal(inspectDispatch(db,app.now()).stopPilot,false);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
