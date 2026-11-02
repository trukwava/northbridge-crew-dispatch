/** Fail-closed restore to a NEW SQLite file. Never overwrite a live database. */
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,constants,existsSync,linkSync,unlinkSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SCHEMA_VERSION,validateSchema} from './db.ts';
import {assertRecoverableDispatchState} from './diagnostics.ts';

function inspect(path:string) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const userVersion=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(userVersion!==SCHEMA_VERSION)throw Error(`Restore requires schema version ${SCHEMA_VERSION}; snapshot is version ${userVersion}`);
    validateSchema(db);
    const integrity=db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}|undefined;
    if(integrity?.integrity_check!=='ok')throw Error('Snapshot integrity check failed');
    assertRecoverableDispatchState(db,'Restore snapshot');
    // A snapshot is useful only when it includes the expected fixture/data shape.
    const counts={jobs:Number((db.prepare('SELECT COUNT(*) n FROM jobs').get() as {n:number}).n),
      audits:Number((db.prepare('SELECT COUNT(*) n FROM audit_events').get() as {n:number}).n)};
    return counts;
  }finally{db.close();}
}
export function restoreToNewDatabase(sourcePath:string,targetPath:string){
  const source=resolve(sourcePath),target=resolve(targetPath);
  if(source===target)throw Error('Source and destination must differ');
  if(!existsSync(source))throw Error('Backup snapshot does not exist');
  if(existsSync(target)||existsSync(target+'-wal')||existsSync(target+'-shm'))
    throw Error('Destination is occupied. Restore only to a new path; never overwrite live data');
  const counts=inspect(source);
  mkdirSync(dirname(target),{recursive:true,mode:0o700});
  const stage=target+'.partial-'+randomUUID();
  try{
    copyFileSync(source,stage,constants.COPYFILE_EXCL);
    chmodSync(stage,0o600);
    const copied=inspect(stage);
    if(copied.jobs!==counts.jobs||copied.audits!==counts.audits)
      throw Error('Restore validation differs from source snapshot');
    // Same-directory hard link is an atomic no-clobber publish; rename would overwrite.
    linkSync(stage,target);
    return {target,source,schemaVersion:SCHEMA_VERSION,jobCount:copied.jobs,auditCount:copied.audits};
  }finally{try{unlinkSync(stage)}catch(error:any){if(error.code!=='ENOENT')throw error;}}
}

// npm run restore -- backups/snapshot.sqlite ./recovered/dispatch.sqlite
if(process.argv[1]&&/(?:^|\/)restore\.(?:ts|js)$/.test(process.argv[1])) {
  if(process.argv.length!==4){console.error('Usage: npm run restore -- BACKUP.sqlite NEW_DB.sqlite');process.exitCode=2;}
  else try {console.log('Restored verified snapshot:',JSON.stringify(restoreToNewDatabase(process.argv[2],process.argv[3])));}
  catch(error:any){console.error('Restore refused:',error.message);process.exitCode=1;}
}
