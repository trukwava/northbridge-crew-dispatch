/** Opt-in single-organization preview authentication. Not an identity provider. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DispatchError } from './domain.ts';

export type Principal = { role:'dispatcher'; crewId:null } | { role:'crew'; crewId:string };
type Session = {principal:Principal; csrf:string; expiresAt:number};
const sha = (value:string) => createHash('sha256').update(value).digest();
const equal = (a:string,b:string) => timingSafeEqual(sha(a),sha(b));
const COOKIE = 'northbridge_preview_session';
const EIGHT_HOURS = 8*60*60_000;

export class PreviewAuth {
  readonly enabled:boolean;
  private dispatcherKey='';
  private crewKeys:Record<string,string>={};
  private sessions=new Map<string,Session>();
  private failures=new Map<string,{count:number; until:number}>();
  constructor(env:NodeJS.ProcessEnv=process.env) {
    this.enabled=env.AUTH_MODE==='preview';
    if(env.AUTH_MODE && !['demo','preview'].includes(env.AUTH_MODE)) throw Error('AUTH_MODE must be demo or preview');
    if(!this.enabled) return;
    this.dispatcherKey=env.PREVIEW_DISPATCHER_KEY||'';
    try {this.crewKeys=JSON.parse(env.PREVIEW_CREW_KEYS_JSON||'{}');} catch {throw Error('PREVIEW_CREW_KEYS_JSON must be valid JSON');}
    const keys=[this.dispatcherKey,...Object.values(this.crewKeys)];
    if (typeof this.crewKeys!=='object'||!this.crewKeys||Array.isArray(this.crewKeys)||
      !Object.keys(this.crewKeys).length||keys.some(x=>typeof x!=='string'||x.length<32)||new Set(keys).size!==keys.length ||
      Object.keys(this.crewKeys).some(k=>!/^[A-H]$/.test(k))) {
      throw Error('Preview mode requires a unique >=32-character dispatcher key and >=32-character per-crew keys for A-H; never commit secrets');
    }
  }
  private cookieValue(req:IncomingMessage) {
    const match=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
    return match?.slice(COOKIE.length+1)||'';
  }
  get(req:IncomingMessage):Session|undefined {
    const raw=this.cookieValue(req);
    if(!/^[a-f0-9]{64}$/.test(raw))return;
    const session=this.sessions.get(raw);
    if(session && session.expiresAt>Date.now())return session;
    this.sessions.delete(raw);
    return;
  }
  publicState(req:IncomingMessage){
    if(!this.enabled)return {mode:'demo',authenticated:true,role:'dispatcher',crewId:null,csrfToken:null};
    const session=this.get(req);
    return session?{mode:'preview',authenticated:true,...session.principal,csrfToken:session.csrf}:
      {mode:'preview',authenticated:false,role:null,crewId:null,csrfToken:null};
  }
  login(req:IncomingMessage,res:ServerResponse,payload:any) {
    if(!this.enabled)throw new DispatchError('Login is only available in preview mode',404);
    const ip=req.socket.remoteAddress||'unknown';
    const prior=this.failures.get(ip);
    if(prior && prior.until>Date.now() && prior.count>=8)throw new DispatchError('Too many attempts: retry later',429);
    const role=payload?.role, crewId=payload?.crewId;
    const key=typeof payload?.key==='string'?payload.key:'';
    const expected=role==='dispatcher'?this.dispatcherKey:role==='crew'&&typeof crewId==='string'?this.crewKeys[crewId]:undefined;
    if(!expected || !key || !equal(key,expected)) {
      const updated=prior&&prior.until>Date.now()?{count:prior.count+1,until:prior.until}:{count:1,until:Date.now()+10*60_000};
      this.failures.set(ip,updated);
      throw new DispatchError('Invalid preview credentials',401);
    }
    this.failures.delete(ip);
    for(const [token,session] of this.sessions)if(session.expiresAt<=Date.now())this.sessions.delete(token);
    if(this.sessions.size>=500)throw new DispatchError('Preview session limit reached',429);
    const principal:Principal=role==='dispatcher'?{role:'dispatcher',crewId:null}:{role:'crew',crewId};
    const token=randomBytes(32).toString('hex');
    this.sessions.set(token,{principal,csrf:randomBytes(24).toString('hex'),expiresAt:Date.now()+EIGHT_HOURS});
    // Preview is intended for GitHub's HTTPS forwarded ports. Cookies require TLS.
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    return this.publicStateFromToken(token);
  }
  private publicStateFromToken(token:string){const s=this.sessions.get(token)!;return {mode:'preview',authenticated:true,...s.principal,csrfToken:s.csrf};}
  require(req:IncomingMessage,role:Principal['role']) {
    if(!this.enabled)throw new Error('PreviewAuth.require is preview-only');
    const s=this.get(req);
    if(!s)throw new DispatchError('Preview login required',401);
    if(s.principal.role!==role)throw new DispatchError('Role does not allow this action',403);
    if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers['x-csrf-token']!==s.csrf)
      throw new DispatchError('CSRF token missing or invalid',403);
    return s.principal;
  }
  logout(req:IncomingMessage,res:ServerResponse){
    if(!this.enabled)throw new DispatchError('Logout is only available in preview mode',404);
    this.requireExistingSessionAndCsrf(req);
    this.sessions.delete(this.cookieValue(req));
    res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    return {success:true};
  }
  private requireExistingSessionAndCsrf(req:IncomingMessage){
    const s=this.get(req);
    if(!s)throw new DispatchError('Preview login required',401);
    if(req.headers['x-csrf-token']!==s.csrf)throw new DispatchError('CSRF token missing or invalid',403);
  }
}
