/** Safe online SQLite snapshot of the synthetic preview database. Never overwrites existing backups. */
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, linkSync, rmSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertRecoverableDispatchState } from './diagnostics.ts';

export async function createSnapshot(sourcePath:string, destinationPath:string) {
  const source=resolve(sourcePath), destination=resolve(destinationPath);
  if(source===destination) throw Error('Backup destination must differ from source database');
  if(!existsSync(source)) throw Error('Source database does not exist; start the demo first');
  if(existsSync(destination)) throw Error('Backup destination already exists; refusing to overwrite');
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const partial=`${destination}.partial-${randomUUID()}`;
  const db=new DatabaseSync(source,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA quick_check').get() as {quick_check:string}|undefined;
    if(integrity?.quick_check!=='ok') throw Error('Source database integrity check failed');
    assertRecoverableDispatchState(db,'Source database');
    await backup(db,partial);
    const snapshot=new DatabaseSync(partial,{readOnly:true});
    try {
      const check=snapshot.prepare('PRAGMA integrity_check').get() as {integrity_check:string}|undefined;
      if(check?.integrity_check!=='ok') throw Error('Backup integrity check failed');
      if(snapshot.prepare('PRAGMA foreign_key_check').get()) throw Error('Backup foreign-key check failed');
      assertRecoverableDispatchState(snapshot,'Backup snapshot');
    } finally { snapshot.close(); }
    chmodSync(partial,0o600);
    // Atomic no-clobber link: unlike rename(), an existing backup cannot be overwritten
    // even if another process creates the destination between the preflight and this step.
    linkSync(partial,destination);
    return destination;
  } finally { db.close(); rmSync(partial,{force:true}); }
}

// npm run backup -- backups/snapshot.sqlite
if(process.argv[1] && /(?:^|\/)backup\.(?:ts|js)$/.test(process.argv[1])) {
  const source=process.env.DB_PATH||'./data/crew-dispatch.sqlite';
  const destination=process.argv[2]||`./backups/crew-dispatch-${new Date().toISOString().replaceAll(':','-')}.sqlite`;
  createSnapshot(source,destination).then(x=>console.log(`Verified SQLite snapshot: ${x}`)).catch(e=>{console.error('Backup failed:',e.message);process.exitCode=1;});
}
