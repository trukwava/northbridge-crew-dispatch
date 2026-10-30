import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function unusedPort():Promise<number> {
  const probe=createServer();
  return new Promise((resolvePort,reject)=>{
    probe.on('error',reject);
    probe.listen(0,'127.0.0.1',()=>{
      const address=probe.address();
      const port=typeof address==='object'&&address?address.port:0;
      probe.close(()=>resolvePort(port));
    });
  });
}

test('HTTP integration: guarded crew configuration and static preview assets',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'nb-http-'));
  const port=await unusedPort();
  const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
    cwd:resolve(import.meta.dirname,'..'),
    env:{...process.env,PORT:String(port),DB_PATH:join(temp,'state.sqlite')},
    stdio:'ignore'
  });
  try {
    let ready=false;
    for(let i=0;i<80;i++) {
      if(child.exitCode!==null)break;
      try { const r=await fetch(origin+'/');if(r.ok){ready=true;break;} }catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert(ready,'Demo server should start');
    for(const asset of ['/','/app.js','/crew-admin.js','/styles.css']){
      const response=await fetch(origin+asset);
      assert.equal(response.status,200,'Asset '+asset+' should be served');
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    }
    const unauthorized=await fetch(origin+'/api/crews');
    assert.equal(unauthorized.status,403);
    const protectedHeaders={'X-Demo-Role':'dispatcher'};
    const crews=await fetch(origin+'/api/crews',{headers:protectedHeaders});
    assert.equal(crews.status,200);
    assert.equal((await crews.json()).length,8);
    const updateHeaders={'X-Demo-Role':'dispatcher','Content-Type':'application/json'};
    const update=await fetch(origin+'/api/crews/A',{method:'POST',headers:updateHeaders,
      body:JSON.stringify({name:'Updated demo crew',availability:'available',max_capacity:2,baseline_load:0})});
    assert.equal(update.status,200);
    assert.equal((await update.json()).name,'Updated demo crew');
    const invalid=await fetch(origin+'/api/crews/A',{method:'POST',headers:updateHeaders,
      body:JSON.stringify({max_capacity:1,baseline_load:2})});
    assert.equal(invalid.status,400);
    const after=await fetch(origin+'/api/crews',{headers:protectedHeaders});
    assert.equal((await after.json())[0].name,'Updated demo crew');
    const forged=await fetch(origin+'/api/crew/offers/does-not-exist/accept',{
      method:'POST',headers:{'X-Demo-Crew-Token':'wrong-token'}});
    assert.equal(forged.status,403);
  }finally {
    child.kill('SIGTERM');
    if(child.exitCode===null)await new Promise<void>(done=>child.once('exit',()=>done()));
    rmSync(temp,{recursive:true,force:true});
  }
});
