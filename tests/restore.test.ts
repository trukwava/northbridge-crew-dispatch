import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,rmSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../src/db.ts';
import {Dispatch} from '../src/domain.ts';
import {createSnapshot} from '../src/backup.ts';
import {restoreToNewDatabase} from '../src/restore.ts';

test('verified backup round-trip restores offer history without overwriting the source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-restore-'));const live=join(dir,'live.sqlite');const backup=join(dir,'snapshot.sqlite');const dest=join(dir,'restored','new.sqlite');
 try{
  const db=openDb(live),app=new Dispatch(db);app.seed();app.start('J001');
  const first=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(first);
  const audits=app.exportAudit().length;await createSnapshot(live,backup);db.close();
  const result=restoreToNewDatabase(backup,dest);assert.equal(result.schemaVersion,1);assert.equal(result.jobCount,15);
  assert.equal(statSync(dest).mode&0o777,0o600);
  const recovered=openDb(dest),after=new Dispatch(recovered);
  assert.equal(after.detail('J001').offers.find((o:any)=>o.id===first.id)?.status,'pending');
  assert.equal(after.exportAudit().length,audits);recovered.close();
  assert.throws(()=>restoreToNewDatabase(backup,dest),/Destination is occupied/);
  assert.equal(readFileSync(dest).equals(readFileSync(backup)),true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('restore rejects corrupt input and never leaves a destination',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-corrupt-'));const source=join(dir,'bad.sqlite'),dest=join(dir,'nested','new.sqlite');
 try{writeFileSync(source,'not a sqlite file');assert.throws(()=>restoreToNewDatabase(source,dest));
  assert.equal(existsSync(dest),false);assert.equal(existsSync(join(dir,'nested')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('restore fails closed on future-schema snapshot and never overwrites occupied target',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-future-'));const source=join(dir,'future.sqlite'),dest=join(dir,'new.sqlite');
 try{const db=openDb(source);db.exec('PRAGMA user_version=200');db.close();
  assert.throws(()=>restoreToNewDatabase(source,dest),/schema version/);
  assert.equal(existsSync(dest),false);
  writeFileSync(dest,'untouched');
  assert.throws(()=>restoreToNewDatabase(source,dest),/occupied/);
  assert.equal(readFileSync(dest,'utf8'),'untouched');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('restore refuses a destination if orphan WAL marker exists',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-restore-marker-'));const src=join(dir,'snapshot.sqlite'),dest=join(dir,'new.sqlite');
 try{const db=openDb(src);db.close();writeFileSync(dest+'-wal','stale');
  assert.throws(()=>restoreToNewDatabase(src,dest),/occupied/);assert.equal(existsSync(dest),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restore rejects a logically inconsistent snapshot without creating a target',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-inconsistent-'));
 const source=join(dir,'snapshot.sqlite'),dest=join(dir,'restored','new.sqlite');
 try{
  const db=openDb(source),app=new Dispatch(db);app.seed();app.start('J001');
  const pending=app.detail('J001').offers.find((o:any)=>o.status==='pending');assert(pending);
  app.accept(pending.id,'A');
  db.prepare("UPDATE assignments SET current=0 WHERE job_id='J001'").run();db.close();
  assert.throws(()=>restoreToNewDatabase(source,dest),/critical dispatch invariants/);
  assert.equal(existsSync(dest),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
