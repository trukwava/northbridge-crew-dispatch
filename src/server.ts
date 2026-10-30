import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { Dispatch, DispatchError } from './domain.ts';
import { PreviewAuth } from './auth.ts';
import { inspectDispatch } from './diagnostics.ts';

const PUBLIC = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const DB_PATH = resolve(process.env.DB_PATH || './data/crew-dispatch.sqlite');
const db = openDb(DB_PATH);
const app = new Dispatch(db);
const auth = new PreviewAuth();
if (!db.prepare("SELECT key FROM settings WHERE key='demo_now'").get()) app.seed();
// A corrupt persisted assignment must never trigger writes during startup recovery.
const startupStop = inspectDispatch(db,app.now()).stopPilot;
const initialPoll = startupStop ? {expired:0} : app.tick();
console.log(`Northbridge synthetic demo: database ${DB_PATH}; ${initialPoll.expired} overdue offers recovered${startupStop ? '; critical integrity finding, recovery worker paused' : ''}`);

function send(res: ServerResponse, status: number, value: unknown, contentType='application/json; charset=utf-8') {
  const content = contentType.startsWith('application/json') ? JSON.stringify(value) : String(value);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY' });
  res.end(content);
}
async function body(req:IncomingMessage):Promise<any> {
  let raw='';
  for await(const chunk of req) {
    raw += String(chunk);
    if(raw.length > 32_768) throw new DispatchError('Request body exceeds 32 KB',413);
  }
  try { return raw?JSON.parse(raw):{}; }
  catch { throw new DispatchError('Invalid JSON request body',400); }
}
const end = (res:ServerResponse, value:unknown) => send(res,200,value);
const dispatcher = (req:IncomingMessage) => {
  if(auth.enabled) {auth.require(req,'dispatcher');return;}
  if(req.headers['x-demo-role'] !== 'dispatcher') throw new DispatchError('Dispatcher demo header required',403);
};
const crewId = (req:IncomingMessage) => {
  if(auth.enabled) return auth.require(req,'crew').crewId!;
  return app.authenticateCrew(String(req.headers['x-demo-crew-token'] ?? ''));
};

/** Fail closed on persisted critical invariant violations. Recovery is offline and deliberate. */
const requireIntegrity = () => {
  if(inspectDispatch(db,app.now()).stopPilot)
    throw new DispatchError('Dispatch paused: critical persisted invariant violation; inspect /api/diagnostics and restore a verified snapshot',503);
};

const server = createServer(async(req,res) => {
  try {
    const uri = new URL(req.url || '/', 'http://localhost');
    const path = uri.pathname;
    const method = req.method ?? 'GET';
    if (!path.startsWith('/api/')) {
      if(method!=='GET') throw new DispatchError('Method not allowed',405);
      const assets: Record<string,[string,string]> = {
        '/':['index.html','text/html; charset=utf-8'],
        '/index.html':['index.html','text/html; charset=utf-8'],
        '/app.js':['app.js','text/javascript; charset=utf-8'],
        '/crew-admin.js':['crew-admin.js','text/javascript; charset=utf-8'],
        '/pilot.js':['pilot.js','text/javascript; charset=utf-8'],
        '/diagnostics.js':['diagnostics.js','text/javascript; charset=utf-8'],
        '/styles.css':['styles.css','text/css; charset=utf-8'],
        '/favicon.svg':['favicon.svg','image/svg+xml']
      };
      const asset = assets[path];
      if(!asset) throw new DispatchError('Not found',404);
      return send(res,200,readFileSync(resolve(PUBLIC,asset[0]),'utf8'),asset[1]);
    }
    if(path==='/api/session' && method==='GET') return end(res,auth.publicState(req));
    if(path==='/api/session/login' && method==='POST') return end(res,auth.login(req,res,await body(req)));
    if(path==='/api/session/logout' && method==='POST') return end(res,auth.logout(req,res));
    if(path==='/api/crew/inbox' && method==='GET') return end(res,
      auth.enabled?app.crewInboxForCrew(crewId(req)):app.crewInbox(String(req.headers['x-demo-crew-token']??'')));
    let match = /^\/api\/crew\/offers\/([^/]+)\/(accept|decline)$/.exec(path);
    if(match && method==='POST') {
      const actor=crewId(req), offerId=match[1];
      requireIntegrity();
      return end(res,match[2]==='accept'?app.accept(offerId,actor):app.decline(offerId,actor));
    }
    dispatcher(req);
    if(method==='POST') requireIntegrity();
    if(path==='/api/dashboard'&&method==='GET') return end(res,app.dashboard());
    if(path==='/api/crews'&&method==='GET') return end(res,app.crews());
    if(path==='/api/diagnostics'&&method==='GET') return end(res,inspectDispatch(db,app.now()));
    if(path==='/api/pilot/evaluate'&&method==='POST') return end(res,app.evaluatePilot(await body(req)));
    if(path==='/api/jobs'&&method==='POST') return end(res,app.createJob(await body(req)));
    if(path==='/api/demo/reset'&&method==='POST') return end(res,app.seed());
    if(path==='/api/demo/advance'&&method==='POST') return end(res,app.advanceMinutes(Number((await body(req)).minutes)));
    if(path==='/api/demo/tick'&&method==='POST') return end(res,app.tick());
    if(path==='/api/audit.csv'&&method==='GET') {
      const rows=app.exportAudit();
      const cols=['id','job_id','actor','action','detail','at_ms'];
      const escapeCsv=(v:any) => {
        let s=String(v??'');
        if(/^[=+@\-\t\r]/.test(s)) s="'"+s; // Prevent spreadsheet formula execution on export.
        return '"'+s.replaceAll('"','""')+'"';
      };
      const csv=cols.join(',')+'\n'+rows.map(row=>cols.map(c=>escapeCsv(row[c])).join(',')).join('\n');
      res.setHeader('Content-Disposition','attachment; filename="northbridge-demo-audit.csv"');
      return send(res,200,csv,'text/csv; charset=utf-8');
    }
    match=/^\/api\/crews\/([^/]+)$/.exec(path);
    if(match&&method==='POST') return end(res,app.editCrew(match[1],await body(req)));
    match=/^\/api\/crews\/([^/]+)\/availability$/.exec(path);
    if(match&&method==='POST') return end(res,app.setCrewAvailability(match[1],String((await body(req)).status)));
    match=/^\/api\/offers\/([^/]+)\/retry$/.exec(path);
    if(match&&method==='POST') return end(res,app.retryNotification(match[1]));
    match=/^\/api\/jobs\/([^/]+)$/.exec(path);
    if(match&&method==='GET') return end(res,app.detail(match[1]));
    match=/^\/api\/jobs\/([^/]+)\/(start|pause|resume|cancel|override|step|confirm)$/.exec(path);
    if(match&&method==='POST') {
      const [,jobId,action] = match;
      if(action==='start') return end(res,app.start(jobId));
      if(action==='pause') return end(res,app.pause(jobId));
      if(action==='resume') return end(res,app.resume(jobId));
      if(action==='cancel') return end(res,app.cancel(jobId));
      const args=await body(req);
      if(action==='step') return end(res,app.completeStep(jobId,String(args.status)));
      if(action==='override') return end(res,app.override(jobId,String(args.crewId),String(args.reason??'')));
      if(action==='confirm') return end(res,app.confirmLocation(jobId,args));
    }
    throw new DispatchError('Not found',404);
  } catch(e) {
    const err=e instanceof DispatchError?e:null;
    if(!err) console.error('Internal failure', e);
    send(res,err?.status??500,{error:err?.message??'Unexpected server failure'});
  }
});
// Recheck before every scheduled write. API write guards alone do not protect a worker.
const worker=setInterval(()=> {
  try {
    if(inspectDispatch(db,app.now()).stopPilot) return;
    app.tick();
  } catch(e){console.error('Scheduler error',e);}
},1000);
worker.unref();
server.listen(PORT,'127.0.0.1',()=>console.log(`Crew Dispatch demo listening at http://127.0.0.1:${PORT}`));
for(const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,()=>{
  clearInterval(worker);server.close(()=>{db.close();process.exit(0);});
});
