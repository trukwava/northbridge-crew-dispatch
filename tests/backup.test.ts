import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/db.ts';
import { createSnapshot } from '../src/backup.ts';
import { Dispatch } from '../src/domain.ts';

test('legacy database adopts schema v1 and preserves offers across reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-schema-'));const file=join(dir,'dispatch.sqlite');
 try {
  let db=openDb(file);assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,SCHEMA_VERSION);
  const app=new Dispatch(db);app.seed();app.start('J001');const pending=app.detail('J001').offers.find((x:any)=>x.status==='pending');assert(pending);
  db.exec('PRAGMA user_version=0');db.close();
  db=openDb(file);assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,1);
  assert.equal(new Dispatch(db).detail('J001').offers.find((x:any)=>x.id===pending.id)?.status,'pending');db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('future schema is refused instead of downgraded',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-future-'));const file=join(dir,'dispatch.sqlite');
 try {let db=openDb(file);db.exec('PRAGMA user_version=999');db.close();
   assert.throws(()=>openDb(file),/Unsupported future SQLite schema/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('missing legacy guard is re-created without deleting data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-broken-'));const file=join(dir,'dispatch.sqlite');
 try {let db=openDb(file);db.exec('PRAGMA user_version=0');db.exec('DROP TRIGGER capacity_insert_guard');db.close();
   // Existing CREATE IF NOT EXISTS restores missing guard, as the legacy schema is repaired non-destructively.
   db=openDb(file);assert(db.prepare("SELECT 1 FROM sqlite_master WHERE name='capacity_insert_guard'").get());db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('online backup captures committed offers and audit; refuses overwrite',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nb-backup-'));const file=join(dir,'live.sqlite');const dest=join(dir,'nested','snapshot.sqlite');
 let db;
 try {db=openDb(file);let app=new Dispatch(db);app.seed();app.start('J001');const offer=app.detail('J001').offers[0];
   const auditBefore=app.exportAudit().length;
   assert.equal(await createSnapshot(file,dest),dest);
   assert(existsSync(dest));assert.equal(statSync(dest).mode & 0o777,0o600);
   assert.equal(app.detail('J001').offers[0].id,offer.id);
   assert.equal(app.exportAudit().length,auditBefore);
   await assert.rejects(()=>createSnapshot(file,dest),/already exists/);
   await assert.rejects(()=>createSnapshot(file,file),/must differ/);
   db.close();db=undefined;
   const restored=openDb(dest);
   try {const recovered=new Dispatch(restored);assert.equal(recovered.detail('J001').offers[0].id,offer.id);
     assert.equal(recovered.exportAudit().length,auditBefore);
   }finally{restored.close();}
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
