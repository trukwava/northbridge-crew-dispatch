/* A standalone CHILD PROCESS for testing SQLite's real interprocess write lock. */
import {openDb} from '../src/db.ts';
import {Dispatch} from '../src/domain.ts';

const [operation,path,offerId,crewId]=process.argv.slice(2);
let db;
try {
  if(!path||!['accept','tick'].includes(operation))throw Error('Invalid worker arguments');
  db=openDb(path);
  const app=new Dispatch(db);
  const value=operation==='accept'?app.accept(offerId,crewId):app.tick();
  process.stdout.write(JSON.stringify({ok:true,value})+'\n');
}catch(error:any){process.stdout.write(JSON.stringify({ok:false,error:String(error?.message||error)})+'\n');process.exitCode=1;}
finally{db?.close();}
