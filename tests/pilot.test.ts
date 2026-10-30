import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.ts';
import {Dispatch} from '../src/domain.ts';

const descriptor=(id:string,region='Manhattan')=>({id,region,skills:['Water mitigation'],confirmed:true,address_present:true});
function fixture(){const db=openDb();const app=new Dispatch(db);app.seed();return app;}
test('shadow evaluator uses dispatch ranking, reports gaps and leaves no changes',()=>{
 const app=fixture();const before=app.exportAudit().length;
 const beforeOffers=app.detail('J009').offers.length;
 const result=app.evaluatePilot({mode:'synthetic',requests:[descriptor('one'),descriptor('two','Newark'),
    {...descriptor('three'),confirmed:false,address_present:false}]});
 assert.deepEqual(result.summary,{total:3,withEligibleCrew:1,needsLocationReview:2,noEligibleCrew:0});
 assert.deepEqual(result.results[0].eligibleCrews,app.rank('J001').ranking.filter(x=>x.eligible).map(x=>x.crewId));
 assert.equal(result.results[1].firstCandidate,null);
 assert(result.results[2].reviewReasons.includes('Missing address'));
 assert.equal(app.exportAudit().length,before);
 assert.equal(app.detail('J009').offers.length,beforeOffers);
 assert.equal(app.db.prepare('SELECT COUNT(*) n FROM capacity_reservations WHERE active=1').get()?.n,0);
 app.db.close();
});
test('batch evaluation does not consume capacity for later rows',()=>{
 const app=fixture();const batch=app.evaluatePilot({mode:'synthetic',requests:Array.from({length:50},(_,i)=>descriptor(`R${i}`))});
 assert.equal(batch.summary.total,50);
 assert(batch.results.every(x=>x.firstCandidate==='A'));
 assert.equal(app.getCrew('A').remaining,2);
 app.db.close();
});
test('shadow batch rejects missing mode, invalid skills, identifiers and coordinates',()=>{
 const app=fixture();const invalid=[
  {}, {mode:'synthetic',requests:[]}, {mode:'synthetic',requests:[descriptor('x'),descriptor('x')]},
  {mode:'synthetic',requests:[{...descriptor('x'),skills:['Unrecognized']}]},
  {mode:'synthetic',requests:[{...descriptor('x'),confirmed:'true'}]},
  {mode:'synthetic',requests:[{...descriptor('x'),lat:NaN,lon:1}]},
  {mode:'synthetic',requests:[{...descriptor('x'),id:'name with spaces'}]},
  {mode:'synthetic',requests:[{...descriptor('x'),address:'real address'}]},
  {mode:'synthetic',requests:[{...descriptor('x'),name:'real person'}]}
 ];
 for(const input of invalid)assert.throws(()=>app.evaluatePilot(input));
 app.db.close();
});

test('dispatcher-only HTTP endpoint returns a shadow report without creating jobs',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join,resolve}=await import('node:path');
 const {spawn}=await import('node:child_process');
 const {createServer}=await import('node:net');
 const dir=mkdtempSync(join(tmpdir(),'nb-pilot-http-'));
 const port=await new Promise<number>((ok,fail)=>{const s=createServer();s.on('error',fail);s.listen(0,'127.0.0.1',()=>{const addr=s.address();s.close(()=>ok(typeof addr==='object'&&addr?addr.port:0));});});
 const url=`http://127.0.0.1:${port}`;
 const processHandle=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
  cwd:resolve(import.meta.dirname,'..'),env:{...process.env,AUTH_MODE:'demo',DB_PATH:join(dir,'data.sqlite'),PORT:String(port)},stdio:'ignore'
 });
 try{
  let started=false;
  for(let i=0;i<100;i++){try{if((await fetch(`${url}/api/session`)).ok){started=true;break;}}catch{}await new Promise(done=>setTimeout(done,30));}
  assert(started,'Test server did not start');
  const before=await (await fetch(`${url}/api/dashboard`,{headers:{'X-Demo-Role':'dispatcher'}})).json();
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'synthetic',requests:[descriptor('demo')]})};
  assert.equal((await fetch(`${url}/api/pilot/evaluate`,options)).status,403);
  const result=await fetch(`${url}/api/pilot/evaluate`,{...options,headers:{...options.headers,'X-Demo-Role':'dispatcher'}});
  assert.equal(result.status,200);
  assert.equal((await result.json()).summary.total,1);
  const after=await (await fetch(`${url}/api/dashboard`,{headers:{'X-Demo-Role':'dispatcher'}})).json();
  assert.deepEqual(after.jobs,before.jobs);
  assert.deepEqual(after.metrics,before.metrics);
 }finally{processHandle.kill('SIGTERM');if(processHandle.exitCode===null)await new Promise<void>(done=>processHandle.once('exit',()=>done()));rmSync(dir,{recursive:true,force:true});}
});
