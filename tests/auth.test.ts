import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PreviewAuth } from '../src/auth.ts';

const dispatcherKey='dispatcher-long-unique-preview-secret-43';
const crewKeys={A:'crew-A-individual-long-preview-secret-43',B:'crew-B-individual-long-preview-secret-43'};
function credentials(extra:Record<string,string>={}) {
  return {AUTH_MODE:'preview',PREVIEW_DISPATCHER_KEY:dispatcherKey,PREVIEW_CREW_KEYS_JSON:JSON.stringify(crewKeys),...extra};
}
async function unusedPort():Promise<number>{
  const s=createServer();return await new Promise((yes,no)=>{s.on('error',no);s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>yes(typeof a==='object'&&a?a.port:0));});});
}
test('preview rejects weak and duplicate secrets before listening',()=>{
  assert.throws(()=>new PreviewAuth(credentials({PREVIEW_DISPATCHER_KEY:'short'})),/>=32-character/);
  assert.throws(()=>new PreviewAuth(credentials({PREVIEW_CREW_KEYS_JSON:JSON.stringify({A:dispatcherKey})})),/unique/);
  assert.equal(new PreviewAuth({AUTH_MODE:'demo'}).enabled,false);
});
test('preview sessions enforce dispatcher/crew isolation, CSRF, logout and recovery',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'nb-auth-'));const port=await unusedPort();const url='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
  cwd:resolve(import.meta.dirname,'..'),env:{...process.env,...credentials(),PORT:String(port),DB_PATH:join(temp,'db.sqlite')},stdio:'ignore'
 });
 const req=(path:string,opts:RequestInit={})=>fetch(url+path,opts);
 try {
   let ready=false;
   for(let i=0;i<80;i++){try{if((await req('/api/session')).ok){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,50));}
   assert(ready,'Preview should start');
   assert.equal((await (await req('/api/session')).json()).authenticated,false);
   assert.equal((await req('/api/dashboard',{headers:{'X-Demo-Role':'dispatcher'}})).status,401);
   assert.equal((await req('/api/crew/inbox',{headers:{'X-Demo-Crew-Token':'northbridge-demo-a'}})).status,401);
   const wrong=await req('/api/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'crew',crewId:'A',key:'northbridge-demo-a'})});
   assert.equal(wrong.status,401);
   async function login(role:'dispatcher'|'crew',crewId:string|null,key:string){
     const r=await req('/api/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,crewId,key})});
     assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')||'';assert.match(cookie,/HttpOnly.*Secure.*SameSite=Strict/);
     const session=await r.json();return {cookie:cookie.split(';')[0],csrf:session.csrfToken,session};
   }
   const d=await login('dispatcher',null,dispatcherKey);
   const a=await login('crew','A',crewKeys.A);
   const b=await login('crew','B',crewKeys.B);
   assert.equal(a.session.role,'crew');assert.equal(a.session.crewId,'A');
   assert.equal((await req('/api/dashboard',{headers:{Cookie:a.cookie,'X-Demo-Role':'dispatcher'}})).status,403);
   assert.equal((await req('/api/crew/inbox',{headers:{Cookie:d.cookie,'X-Demo-Crew-Token':'northbridge-demo-a'}})).status,403);
   assert.equal((await req('/api/dashboard',{headers:{Cookie:d.cookie}})).status,200);
   assert.equal((await req('/api/crew/inbox',{headers:{Cookie:a.cookie}})).status,200);
   assert.equal((await req('/api/crew/inbox',{headers:{Cookie:b.cookie}})).status,200);
   assert.equal((await req('/api/jobs/J001/start',{method:'POST',headers:{Cookie:d.cookie}})).status,403,'CSRF required');
   assert.equal((await req('/api/jobs/J001/start',{method:'POST',headers:{Cookie:a.cookie,'X-CSRF-Token':a.csrf}})).status,403,'Crew cannot dispatch');
   const started=await req('/api/jobs/J001/start',{method:'POST',headers:{Cookie:d.cookie,'X-CSRF-Token':d.csrf}});
   assert.equal(started.status,200);
   const offer=(await (await req('/api/crew/inbox',{headers:{Cookie:a.cookie}})).json()).offers[0];
   assert(offer,'Crew A should receive the first offer');
   const other=await req(`/api/crew/offers/${offer.id}/accept`,{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'X-Demo-Crew-Token':'northbridge-demo-a'}});
   assert.equal(other.status,403,'Cross-crew action rejected even with forged token');
   const accepted=await req(`/api/crew/offers/${offer.id}/accept`,{method:'POST',headers:{Cookie:a.cookie,'X-CSRF-Token':a.csrf}});
   assert.equal(accepted.status,200);
   const logout=await req('/api/session/logout',{method:'POST',headers:{Cookie:d.cookie,'X-CSRF-Token':d.csrf}});
   assert.equal(logout.status,200);
   assert.equal((await req('/api/dashboard',{headers:{Cookie:d.cookie}})).status,401);
   assert.equal((await req('/api/dashboard',{headers:{Cookie:a.cookie}})).status,403);
 }finally{
   child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(done=>child.once('exit',()=>done()));
   rmSync(temp,{recursive:true,force:true});
 }
});
