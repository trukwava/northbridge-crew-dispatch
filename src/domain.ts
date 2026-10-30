import { randomUUID } from 'node:crypto';
import { digest, transaction, type Sqlite } from './db.ts';

export type RecordRow = Record<string, any>;
export class DispatchError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 18)}`;
const jparse = (raw: string) => JSON.parse(raw);
const rounded = (n: number) => Math.round(n * 10) / 10;
const one = (db: Sqlite, sql: string, ...args: any[]): RecordRow | undefined => db.prepare(sql).get(...args) as RecordRow | undefined;
const many = (db: Sqlite, sql: string, ...args: any[]): RecordRow[] => db.prepare(sql).all(...args) as RecordRow[];
const execute = (db: Sqlite, sql: string, ...args: any[]) => db.prepare(sql).run(...args);
const json = (x: unknown) => JSON.stringify(x);
function assert(ok: unknown, msg: string, status = 409): asserts ok { if (!ok) throw new DispatchError(msg, status); }

function distanceKm(a: {lat: number; lon: number}, b: {lat: number; lon: number}) {
  const r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat*r) * Math.cos(b.lat*r) * Math.sin((b.lon-a.lon)*r/2)**2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

export class Dispatch {
  db: Sqlite;
  constructor(db: Sqlite) { this.db = db; }
  now(): number { return Number(one(this.db, "SELECT value FROM settings WHERE key='demo_now'")?.value ?? Date.now()); }
  clock() { return { nowMs: this.now(), iso: new Date(this.now()).toISOString(), timezone: 'America/New_York', mode: 'simulated' }; }
  event(jobId: string, kind: string, detail: string, crewId: string | null = null, operationKey: string | null = null) {
    execute(this.db, 'INSERT OR IGNORE INTO state_events VALUES (?,?,?,?,?,?,?)', uid('evt'), jobId, crewId, kind, detail, this.now(), operationKey);
  }
  audit(actor: string, action: string, detail: string, jobId: string | null = null) {
    execute(this.db, 'INSERT INTO audit_events VALUES (?,?,?,?,?,?)', uid('aud'), jobId, actor, action, detail, this.now());
  }
  getJob(jobId: string): RecordRow {
    const job = one(this.db, 'SELECT * FROM jobs WHERE id=?', jobId);
    assert(job, 'Job not found', 404);
    return { ...job, skills: many(this.db, 'SELECT skill FROM job_skills WHERE job_id=?', jobId).map(x => x.skill) };
  }
  getCrew(crewId: string): RecordRow {
    const crew = one(this.db, `SELECT c.id,c.name,c.max_capacity,c.baseline_load,c.base_lat,c.base_lon,c.channel,
      a.status AS availability FROM crews c JOIN crew_availability a ON a.crew_id=c.id WHERE c.id=?`, crewId);
    assert(crew, 'Crew not found', 404);
    const active = Number(one(this.db,'SELECT COUNT(*) AS n FROM capacity_reservations WHERE crew_id=? AND active=1',crewId)?.n ?? 0);
    return { ...crew, skills: many(this.db,'SELECT skill FROM crew_skills WHERE crew_id=?',crewId).map(x=>x.skill),
      areas: many(this.db,'SELECT area FROM crew_areas WHERE crew_id=?',crewId).map(x=>x.area),
      reserved: active, remaining: Math.max(0, crew.max_capacity - crew.baseline_load - active) };
  }
  crews() { return many(this.db, 'SELECT id FROM crews ORDER BY id').map(c=>this.getCrew(c.id)); }
  jobs() {
    return many(this.db, `SELECT j.*, (SELECT COUNT(*) FROM offers o WHERE o.job_id=j.id) AS offer_count,
      (SELECT crew_id FROM assignments a WHERE a.job_id=j.id AND current=1) AS assigned_crew
      FROM jobs j ORDER BY CASE j.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, j.id`);
  }
  detail(jobId: string) {
    const job = this.getJob(jobId);
    return { job, ranking: this.rank(jobId),
      offers: many(this.db,'SELECT * FROM offers WHERE job_id=? ORDER BY ordinal',jobId),
      sequence: one(this.db,'SELECT status,next_index,created_ms FROM offer_sequences WHERE job_id=?',jobId) ?? null,
      assignment: one(this.db,'SELECT * FROM assignments WHERE job_id=? AND current=1',jobId) ?? null,
      timeline: many(this.db,'SELECT kind,detail,at_ms,crew_id FROM state_events WHERE job_id=? ORDER BY at_ms DESC,rowid DESC',jobId),
      notifications: many(this.db,`SELECT n.id,n.offer_id,n.status,n.channel,n.detail,n.created_ms
        FROM notification_attempts n JOIN offers o ON o.id=n.offer_id WHERE o.job_id=? ORDER BY n.created_ms DESC`,jobId),
      locationEvidence: many(this.db,'SELECT kind,detail,confirmed_by,created_ms FROM location_evidence WHERE job_id=?',jobId),
      audits: many(this.db,'SELECT actor,action,detail,at_ms FROM audit_events WHERE job_id=? ORDER BY at_ms DESC',jobId) };
  }
  rank(jobId: string) {
    const job = this.getJob(jobId);
    const areas = many(this.db,'SELECT name FROM service_areas').map(a=>a.name);
    const reviewReasons: string[] = [];
    if (!job.address?.trim()) reviewReasons.push('Missing address');
    if (job.location_status !== 'confirmed') reviewReasons.push('Location needs manual confirmation');
    if (!areas.includes(job.region)) reviewReasons.push('Region outside authorized service areas');
    const eligibleRequest = reviewReasons.length===0;
    const ranking = this.crews().map(c => {
      const reasons: string[] = [];
      if (!c.areas.includes(job.region)) reasons.push('Region not authorized');
      const missing = job.skills.filter((s:string)=>!c.skills.includes(s));
      if (missing.length) reasons.push(`Missing skills: ${missing.join(', ')}`);
      if (c.availability !== 'available') reasons.push('Crew unavailable');
      if (c.remaining === 0) reasons.push('At capacity');
      if (!eligibleRequest) reasons.push('Job requires dispatcher location review');
      const proximityKm = typeof job.lat==='number' && typeof c.base_lat==='number'
        ? rounded(distanceKm({lat:job.lat,lon:job.lon},{lat:c.base_lat,lon:c.base_lon})) : null;
      return { crewId:c.id, name:c.name, eligible:reasons.length===0, reasons, proximityKm,
        remaining:c.remaining, channel:c.channel };
    });
    ranking.sort((a,b) => Number(b.eligible)-Number(a.eligible) ||
      (a.proximityKm ?? Infinity)-(b.proximityKm ?? Infinity) || a.crewId.localeCompare(b.crewId));
    return { reviewReasons, ranking, metric:'Straight-line proximity in km, not road travel time. Crew ID breaks ties.' };
  }
  start(jobId: string, actor='dispatcher') {
    return transaction(this.db, () => {
      const job = this.getJob(jobId);
      assert(['new','unassigned'].includes(job.status), 'Only new or unassigned jobs can start an offer sequence');
      const oldSequence=one(this.db,'SELECT status FROM offer_sequences WHERE job_id=?',jobId);
      assert(!oldSequence || oldSequence.status==='exhausted', 'Offer sequence already exists and is not exhausted');
      const r = this.rank(jobId);
      assert(r.reviewReasons.length===0,`Cannot offer job: ${r.reviewReasons.join('; ')}`);
      const ids = r.ranking.filter((x:any)=>x.eligible).map((x:any)=>x.crewId);
      if(oldSequence) execute(this.db,"UPDATE offer_sequences SET status='active',candidates_json=?,next_index=0,created_ms=? WHERE job_id=?",json(ids),this.now(),jobId);
      else execute(this.db,'INSERT INTO offer_sequences VALUES (?,?,?,?,?)',jobId,'active',json(ids),0,this.now());
      execute(this.db,"UPDATE jobs SET status='offering',updated_ms=? WHERE id=?",this.now(),jobId);
      this.event(jobId,'sequence.started',`Offer sequence initialized with ${ids.length} eligible crews`);
      this.audit(actor,'sequence.start',`${ids.length} eligible crews`,jobId);
      this.issueNext(jobId);
      return this.detail(jobId);
    });
  }
  private notify(offer: RecordRow, attemptKey: string) {
    if (one(this.db,'SELECT id FROM notification_attempts WHERE operation_key=?',attemptKey)) return;
    const crew = this.getCrew(offer.crew_id);
    const failed = crew.channel==='unavailable';
    execute(this.db,'INSERT INTO notification_attempts VALUES (?,?,?,?,?,?,?)',
      uid('notif'),offer.id,attemptKey,crew.channel,failed?'failed':'simulated',
      failed?'Channel unavailable: no delivery attempt occurred':'Simulated in-app notification; receipt or view not established',this.now());
    if (failed) this.event(offer.job_id,'notification.failed',`Notification channel unavailable for ${crew.name}`,crew.id);
  }
  private issueNext(jobId: string) {
    const sequence = one(this.db,'SELECT * FROM offer_sequences WHERE job_id=?',jobId);
    if (!sequence || sequence.status!=='active') return;
    if (one(this.db,"SELECT id FROM offers WHERE job_id=? AND status='pending'",jobId)) return;
    const ids: string[] = jparse(sequence.candidates_json);
    let i = sequence.next_index;
    while (i < ids.length) {
      const crewId = ids[i++];
      execute(this.db,'UPDATE offer_sequences SET next_index=? WHERE job_id=?',i,jobId);
      const crewRank = this.rank(jobId).ranking.find((x:any)=>x.crewId===crewId);
      if (!crewRank?.eligible) {
        this.event(jobId,'offer.skipped',`Crew ${crewId} became ineligible: ${crewRank?.reasons.join('; ') ?? 'unknown'}`,crewId);
        continue;
      }
      const ordinal=Number(one(this.db,'SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM offers WHERE job_id=?',jobId)?.n??1);
      const offer = {id:uid('off'),job_id:jobId,crew_id:crewId,ordinal,status:'pending',created_ms:this.now(),expires_ms:this.now()+5*60_000};
      execute(this.db,'INSERT INTO offers VALUES (?,?,?,?,?,?,?,?)',offer.id,jobId,crewId,ordinal,'pending',offer.created_ms,offer.expires_ms,null);
      this.event(jobId,'offer.sent',`Timed five-minute offer #${ordinal} to ${crewId}; simulated channel only`,crewId);
      this.notify(offer,`notify:${offer.id}:initial`);
      return;
    }
    execute(this.db,"UPDATE offer_sequences SET status='exhausted' WHERE job_id=?",jobId);
    execute(this.db,"UPDATE jobs SET status='unassigned',updated_ms=? WHERE id=?",this.now(),jobId);
    this.event(jobId,'sequence.exhausted','No eligible crews remain: dispatcher action required',null,`exhaust:${jobId}:${sequence.created_ms}`);
  }
  decline(offerId: string, crewId: string) {
    return transaction(this.db, () => {
      const offer = one(this.db,'SELECT * FROM offers WHERE id=?',offerId);
      assert(offer, 'Offer not found',404);
      assert(offer.crew_id===crewId, 'Offer belongs to another crew',403);
      assert(offer.status==='pending','Offer is no longer pending');
      assert(this.now()<offer.expires_ms,'Offer has expired');
      execute(this.db,"UPDATE offers SET status='declined', responded_ms=? WHERE id=?",this.now(),offerId);
      this.event(offer.job_id,'offer.declined',`Crew ${crewId} declined`,crewId);
      this.audit(`crew:${crewId}`,'offer.decline',offerId,offer.job_id);
      this.issueNext(offer.job_id);
      return {success:true};
    });
  }
  accept(offerId: string, crewId: string) {
    return transaction(this.db, () => {
      const offer = one(this.db,'SELECT * FROM offers WHERE id=?',offerId);
      assert(offer,'Offer not found',404);
      assert(offer.crew_id===crewId,'Offer belongs to another crew',403);
      assert(offer.status==='pending','Offer is no longer pending');
      // Deadline is exclusive. At the exact millisecond of expiry, expiration wins.
      assert(this.now()<offer.expires_ms,'Offer has expired; acceptance rejected');
      const seq = one(this.db,'SELECT status FROM offer_sequences WHERE job_id=?',offer.job_id);
      assert(seq?.status==='active' || seq?.status==='paused','Sequence is not open');
      const job = this.getJob(offer.job_id);
      assert(job.status==='offering','Job is no longer offering');
      const eligibility = this.rank(offer.job_id).ranking.find((x:any)=>x.crewId===crewId);
      assert(eligibility?.eligible,`Crew no longer eligible: ${eligibility?.reasons.join('; ')}`);
      // BEGIN IMMEDIATE + capacity check + reservation + assignment is one SQLite transaction.
      const crew = this.getCrew(crewId);
      assert(crew.remaining > 0,'Crew has no remaining capacity');
      execute(this.db,'INSERT INTO capacity_reservations VALUES (?,?,?,?,?)',uid('res'),offer.job_id,crewId,1,this.now());
      execute(this.db,'INSERT INTO assignments VALUES (?,?,?,?,?,?,?)',uid('asgn'),offer.job_id,crewId,'assigned',this.now(),1,null);
      execute(this.db,"UPDATE offers SET status='accepted', responded_ms=? WHERE id=?",this.now(),offerId);
      execute(this.db,"UPDATE offer_sequences SET status='accepted' WHERE job_id=?",offer.job_id);
      execute(this.db,"UPDATE jobs SET status='assigned',updated_ms=? WHERE id=?",this.now(),offer.job_id);
      this.event(offer.job_id,'offer.accepted',`Crew ${crewId} accepted and reserved one capacity slot`,crewId);
      this.audit(`crew:${crewId}`,'offer.accept',offerId,offer.job_id);
      return { success:true, jobId:offer.job_id, crewId };
    });
  }
  tick() {
    return transaction(this.db, () => {
      const overdue = many(this.db,"SELECT * FROM offers WHERE status='pending' AND expires_ms<=? ORDER BY expires_ms,id",this.now());
      for (const offer of overdue) {
        execute(this.db,"UPDATE offers SET status='expired',responded_ms=? WHERE id=? AND status='pending'",this.now(),offer.id);
        this.event(offer.job_id,'offer.expired',`Offer to ${offer.crew_id} expired at its durable deadline`,offer.crew_id,`expire:${offer.id}`);
        this.issueNext(offer.job_id);
      }
      return { expired: overdue.length, nowMs:this.now() };
    });
  }
  advanceMinutes(minutes: number) {
    assert(Number.isInteger(minutes)&&minutes>0&&minutes<=1440,'Minutes must be an integer between 1 and 1440',400);
    transaction(this.db,()=>{
      execute(this.db,"UPDATE settings SET value=? WHERE key='demo_now'",String(this.now()+minutes*60_000));
      this.audit('dispatcher','demo.clock.advance',`${minutes} simulated minutes`);
    });
    return { clock:this.clock(), worker:this.tick() };
  }
  pause(jobId: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      const seq=one(this.db,'SELECT status FROM offer_sequences WHERE job_id=?',jobId);
      assert(seq?.status==='active','Only active sequence can pause');
      execute(this.db,"UPDATE offer_sequences SET status='paused' WHERE job_id=?",jobId);
      this.event(jobId,'sequence.paused','Dispatcher paused escalation (existing deadline still applies)');
      this.audit(actor,'sequence.pause','Escalation paused',jobId);
      return this.detail(jobId);
    });
  }
  resume(jobId: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      const seq=one(this.db,'SELECT status FROM offer_sequences WHERE job_id=?',jobId);
      assert(seq?.status==='paused','Only paused sequence can resume');
      execute(this.db,"UPDATE offer_sequences SET status='active' WHERE job_id=?",jobId);
      const overdue = many(this.db,"SELECT * FROM offers WHERE job_id=? AND status='pending' AND expires_ms<=?",jobId,this.now());
      for(const offer of overdue) {
        execute(this.db,"UPDATE offers SET status='expired',responded_ms=? WHERE id=?",this.now(),offer.id);
        this.event(jobId,'offer.expired','Offer expired during pause',offer.crew_id,`expire:${offer.id}`);
      }
      this.issueNext(jobId);
      this.event(jobId,'sequence.resumed','Dispatcher resumed escalation');
      this.audit(actor,'sequence.resume','Escalation resumed',jobId);
      return this.detail(jobId);
    });
  }
  cancel(jobId: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      const job=this.getJob(jobId);
      assert(!['completed','cancelled'].includes(job.status),'Job already terminal');
      execute(this.db,"UPDATE offers SET status='cancelled',responded_ms=? WHERE job_id=? AND status='pending'",this.now(),jobId);
      execute(this.db,"UPDATE offer_sequences SET status='cancelled' WHERE job_id=?",jobId);
      execute(this.db,"UPDATE assignments SET current=0,status='cancelled' WHERE job_id=? AND current=1",jobId);
      execute(this.db,'UPDATE capacity_reservations SET active=0 WHERE job_id=? AND active=1',jobId);
      execute(this.db,"UPDATE jobs SET status='cancelled',updated_ms=? WHERE id=?",this.now(),jobId);
      this.event(jobId,'job.cancelled','Dispatcher cancelled job and released any reservation');
      this.audit(actor,'job.cancel','Cancelled job/offers',jobId);
      return this.detail(jobId);
    });
  }
  completeStep(jobId: string, next: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      const job=this.getJob(jobId);
      const map: Record<string,string>={assigned:'en_route',en_route:'arrived',arrived:'in_progress',in_progress:'completed'};
      assert(map[job.status]===next,`Invalid transition: ${job.status} → ${next}`,400);
      execute(this.db,'UPDATE jobs SET status=?,updated_ms=? WHERE id=?',next,this.now(),jobId);
      execute(this.db,'UPDATE assignments SET status=? WHERE job_id=? AND current=1',next,jobId);
      if(next==='completed') {
        execute(this.db,'UPDATE capacity_reservations SET active=0 WHERE job_id=? AND active=1',jobId);
        execute(this.db,'UPDATE assignments SET current=0 WHERE job_id=?',jobId);
      }
      this.event(jobId,`job.${next}`,`Status changed to ${next} by ${actor}`);
      this.audit(actor,'job.transition',`${job.status} → ${next}`,jobId);
      return this.detail(jobId);
    });
  }
  override(jobId: string, crewId: string, reason: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      assert(typeof reason==='string'&&reason.trim().length>=8,'A substantive override reason is required',400);
      const job=this.getJob(jobId);
      assert(['new','unassigned','offering'].includes(job.status),'Job cannot be overridden in current state');
      const rank=this.rank(jobId);
      assert(rank.reviewReasons.length===0,'Location must be confirmed before manual assignment');
      const target=rank.ranking.find((x:any)=>x.crewId===crewId);
      assert(target?.eligible,`Override blocked by skills, region, availability or capacity: ${target?.reasons.join('; ') ?? 'unknown crew'}`);
      execute(this.db,"UPDATE offers SET status='cancelled',responded_ms=? WHERE job_id=? AND status='pending'",this.now(),jobId);
      execute(this.db,"UPDATE offer_sequences SET status='cancelled' WHERE job_id=?",jobId);
      execute(this.db,'INSERT INTO capacity_reservations VALUES (?,?,?,?,?)',uid('res'),jobId,crewId,1,this.now());
      execute(this.db,'INSERT INTO assignments VALUES (?,?,?,?,?,?,?)',uid('asgn'),jobId,crewId,'assigned',this.now(),1,reason.trim());
      execute(this.db,"UPDATE jobs SET status='assigned',updated_ms=? WHERE id=?",this.now(),jobId);
      this.event(jobId,'assignment.override',`Dispatcher directly assigned ${crewId}; reason: ${reason.trim()}`,crewId);
      this.audit(actor,'assignment.override',`Crew ${crewId}; reason: ${reason.trim()}`,jobId);
      return this.detail(jobId);
    });
  }
  retryNotification(offerId: string, actor='dispatcher') {
    return transaction(this.db,()=>{
      const offer=one(this.db,'SELECT * FROM offers WHERE id=?',offerId);
      assert(offer,'Offer not found',404);
      assert(offer.status==='pending' && this.now()<offer.expires_ms,'Only live pending offers can be retried');
      const count=Number(one(this.db,'SELECT COUNT(*) n FROM notification_attempts WHERE offer_id=?',offerId)?.n??0);
      assert(count<5,'Notification retry limit reached',429);
      this.notify(offer,`notify:${offer.id}:retry:${count}`);
      this.audit(actor,'notification.retry',`Attempt ${count+1}`,offer.job_id);
      return this.detail(offer.job_id);
    });
  }
  crewInbox(token: string) {
    const crew=one(this.db,'SELECT id FROM crews WHERE token_hash=?',digest(token));
    assert(crew,'Invalid crew demo token',403);
    const offers=many(this.db,`SELECT o.id,o.status,o.expires_ms,o.created_ms,o.job_id,
      j.title,j.job_type,j.urgency,j.address,j.region,j.status AS job_status
      FROM offers o JOIN jobs j ON j.id=o.job_id
      WHERE o.crew_id=? AND o.status='pending' ORDER BY o.expires_ms`,crew.id);
    return {crewId:crew.id, name:this.getCrew(crew.id).name, offers, clock:this.clock()};
  }
  authenticateCrew(token: string) {
    const crew=one(this.db,'SELECT id FROM crews WHERE token_hash=?',digest(token));
    assert(crew,'Invalid crew demo token',403); return crew.id as string;
  }
  dashboard() {
    const jobs=this.jobs();
    return { clock:this.clock(), jobs, crews:this.crews(),
      exceptions:[
        ...many(this.db,"SELECT j.id AS jobId, 'Needs location review' AS kind FROM jobs j WHERE j.status='review'"),
        ...many(this.db,"SELECT j.id AS jobId, 'Exhausted offer sequence' AS kind FROM jobs j WHERE j.status='unassigned'"),
        ...many(this.db,"SELECT DISTINCT o.job_id AS jobId, 'Notification channel failed' AS kind FROM notification_attempts n JOIN offers o ON n.offer_id=o.id WHERE n.status='failed'"),
        ...many(this.db,"SELECT job_id AS jobId, 'Escalation paused' AS kind FROM offer_sequences WHERE status='paused'")
      ],
      metrics: { open:jobs.filter(j=>!['completed','cancelled'].includes(j.status)).length,
        assigned:jobs.filter(j=>['assigned','en_route','arrived','in_progress','completed'].includes(j.status)).length,
        pending: Number(one(this.db,"SELECT COUNT(*) n FROM offers WHERE status='pending'")?.n??0),
        conflicts: Number(one(this.db,"SELECT COUNT(*) n FROM (SELECT job_id FROM assignments WHERE current=1 GROUP BY job_id HAVING COUNT(*)>1)")?.n??0) }
    };
  }
  createJob(data: RecordRow, actor='dispatcher') {
    return transaction(this.db,()=>{
      const title=String(data.title??'').trim().slice(0,120), type=String(data.job_type??'').trim().slice(0,80);
      const region=String(data.region??'').trim(), address=String(data.address??'').trim().slice(0,200);
      const urgency=String(data.urgency??'urgent');
      const skills=Array.isArray(data.skills)?[...new Set(data.skills.map(String))]:[];
      assert(title&&type&&region,'Title, job type and service region required',400);
      assert(['emergency','urgent','routine'].includes(urgency),'Invalid urgency',400);
      assert(skills.length>0 && skills.length<=4,'Select one to four skills',400);
      const validSkills=many(this.db,'SELECT name FROM skills').map(x=>x.name);
      assert(skills.every(x=>validSkills.includes(x)),'Unknown required skill',400);
      const lat=data.lat==null||data.lat===''?null:Number(data.lat),lon=data.lon==null||data.lon===''?null:Number(data.lon);
      assert((lat===null&&lon===null)||(lat!==null&&lon!==null&&Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180),'Invalid coordinates',400);
      const allowed = many(this.db,'SELECT name FROM service_areas').some(a=>a.name===region);
      const confirmed=Boolean(data.confirmed)&&Boolean(address)&&allowed;
      const status=confirmed?'new':'review', key=uid('job');
      execute(this.db,'INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,title,type,urgency,address||null,region,lat,lon,confirmed?'confirmed':'needs_review',status,this.now(),this.now());
      for(const skill of skills) execute(this.db,'INSERT INTO job_skills VALUES (?,?)',key,skill);
      if (confirmed) execute(this.db,'INSERT INTO location_evidence VALUES (?,?,?,?,?,?)',uid('loc'),key,'manual','Location/address confirmed in demo input',actor,this.now());
      this.event(key,'job.created',`Request created; ${confirmed?'location confirmed':'requires review'}`);
      this.audit(actor,'job.create',`Request ${key}`,key);
      return this.detail(key);
    });
  }
  confirmLocation(jobId: string, fields: RecordRow, actor='dispatcher') {
    return transaction(this.db,()=>{
      const job=this.getJob(jobId);
      assert(job.status==='review','Job is not awaiting location review',400);
      const address=String(fields.address??job.address??'').trim().slice(0,200);
      const region=String(fields.region??job.region??'').trim();
      assert(address.length>=5,'A verified address is required',400);
      assert(!!one(this.db,'SELECT name FROM service_areas WHERE name=?',region),'Region outside authorized service areas',400);
      assert(fields.confirmed===true,'Dispatcher must explicitly confirm the location',400);
      execute(this.db,"UPDATE jobs SET address=?,region=?,location_status='confirmed',status='new',updated_ms=? WHERE id=?",address,region,this.now(),jobId);
      execute(this.db,'INSERT INTO location_evidence VALUES (?,?,?,?,?,?)',uid('loc'),jobId,'manual','Dispatcher confirmed updated address and region',actor,this.now());
      this.event(jobId,'location.confirmed',`Address and region reviewed by dispatcher`);
      this.audit(actor,'job.location_confirm',`Region ${region}`,jobId);
      return this.detail(jobId);
    });
  }
  seed() {
    transaction(this.db,()=>{
      // Dedicated synthetic-demo storage only; never run this function on a production database.
      for(const table of ['notification_attempts','location_evidence','audit_events','state_events','capacity_reservations',
        'assignments','offers','offer_sequences','job_skills','jobs','crew_areas','crew_skills','crew_availability','crews','skills','service_areas','settings'])
        this.db.exec(`DELETE FROM ${table}`);
      const initial=Date.parse('2026-10-29T15:00:00.000Z');
      execute(this.db,"INSERT INTO settings VALUES ('demo_now',?)",String(initial));
      for (const skill of ['Water mitigation','Fire restoration','Commercial cleaning','Mold remediation']) execute(this.db,'INSERT INTO skills VALUES (?)',skill);
      for (const area of ['Manhattan','Brooklyn','Queens']) execute(this.db,'INSERT INTO service_areas VALUES (?)',area);
      const fixtures = [
        ['A','Alpha Response',2,0,40.750,-73.990,'in_app','available',['Manhattan','Brooklyn'],['Water mitigation','Commercial cleaning']],
        ['B','Beacon Response',1,0,40.725,-74.005,'in_app','available',['Manhattan'],['Water mitigation','Commercial cleaning']],
        ['C','Cedar Response',2,0,40.710,-73.940,'unavailable','available',['Brooklyn','Queens'],['Water mitigation','Mold remediation']],
        ['D','Delta Response',2,2,40.735,-73.810,'in_app','available',['Queens'],['Water mitigation','Commercial cleaning']],
        ['E','Echo Response',1,1,40.720,-73.825,'in_app','available',['Queens'],['Mold remediation','Commercial cleaning']],
        ['F','Forge Response',2,0,40.752,-73.977,'in_app','available',['Manhattan'],['Fire restoration','Commercial cleaning']],
        ['G','Grove Response',2,0,40.675,-73.960,'in_app','unavailable',['Brooklyn'],['Water mitigation','Mold remediation']],
        ['H','Harbor Response',2,0,40.745,-73.845,'in_app','available',['Queens'],['Commercial cleaning','Mold remediation']]
      ] as const;
      for(const [cid,name,max,load,lat,lon,channel,availability,areas,skills] of fixtures) {
        execute(this.db,'INSERT INTO crews VALUES (?,?,?,?,?,?,?,?)',cid,name,max,load,lat,lon,channel,digest(`northbridge-demo-${cid.toLowerCase()}`));
        execute(this.db,'INSERT INTO crew_availability VALUES (?,?,?)',cid,availability,initial);
        for(const area of areas) execute(this.db,'INSERT INTO crew_areas VALUES (?,?)',cid,area);
        for(const skill of skills) execute(this.db,'INSERT INTO crew_skills VALUES (?,?)',cid,skill);
      }
      const jobs = [
        ['J001','Burst pipe at Midtown office','Water mitigation','emergency','20 W 34th St, Manhattan','Manhattan',40.750,-73.990,'confirmed','new',['Water mitigation']],
        ['J002','Smoke remediation after electrical fire','Fire restoration','emergency','120 E 23rd St, Manhattan','Manhattan',40.740,-73.985,'confirmed','new',['Fire restoration']],
        ['J003','Commercial lobby cleanup','Commercial cleaning','routine','110 W 40th St, Manhattan','Manhattan',40.753,-73.985,'confirmed','new',['Commercial cleaning']],
        ['J004','Brooklyn basement leak','Water mitigation','urgent','2 Flatbush Ave, Brooklyn','Brooklyn',40.687,-73.980,'confirmed','new',['Water mitigation']],
        ['J005','Queens mold response','Mold remediation','urgent','78 Queens Blvd, Queens','Queens',40.730,-73.870,'confirmed','new',['Mold remediation']],
        ['J006','Missing address request','Water mitigation','urgent',null,'Manhattan',null,null,'needs_review','review',['Water mitigation']],
        ['J007','Outside service area request','Water mitigation','emergency','12 Broad St, Newark','Newark',40.735,-74.173,'needs_review','review',['Water mitigation']],
        ['J008','Cancelled cleaning visit','Commercial cleaning','routine','4 Jay St, Brooklyn','Brooklyn',40.705,-73.987,'confirmed','cancelled',['Commercial cleaning']],
        ['J009','Queens emergency, simulated channel outage','Water mitigation','emergency','88-01 Queens Blvd, Queens','Queens',40.735,-73.875,'confirmed','new',['Water mitigation']],
        ['J010','West Side office refresh','Commercial cleaning','routine','10 W 55th St, Manhattan','Manhattan',40.760,-73.977,'confirmed','new',['Commercial cleaning']],
        ['J011','Sprinkler incident','Water mitigation','emergency','99 Madison Ave, Manhattan','Manhattan',40.744,-73.986,'confirmed','new',['Water mitigation']],
        ['J012','Queens retail cleanup','Commercial cleaning','urgent','30-01 Queens Blvd, Queens','Queens',40.745,-73.932,'confirmed','new',['Commercial cleaning']],
        ['J013','Brooklyn warehouse leak','Water mitigation','urgent','80 Atlantic Ave, Brooklyn','Brooklyn',40.690,-73.993,'confirmed','new',['Water mitigation']],
        ['J014','Exhausted historic demo sequence','Water mitigation','urgent','8 W 31st St, Manhattan','Manhattan',40.746,-73.988,'confirmed','unassigned',['Water mitigation']],
        ['J015','Brooklyn mold inspection','Mold remediation','routine','50 Court St, Brooklyn','Brooklyn',40.691,-73.990,'confirmed','new',['Mold remediation']]
      ] as const;
      for(const [jid,title,jobtype,urgency,address,region,lat,lon,location,status,skills] of jobs) {
        execute(this.db,'INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',jid,title,jobtype,urgency,address,region,lat,lon,location,status,initial,initial);
        for(const skill of skills) execute(this.db,'INSERT INTO job_skills VALUES (?,?)',jid,skill);
        if(location==='confirmed') execute(this.db,'INSERT INTO location_evidence VALUES (?,?,?,?,?,?)',uid('loc'),jid,'fixture','Synthetic manually confirmed location', 'demo-seed',initial);
      }
      execute(this.db,'INSERT INTO offer_sequences VALUES (?,?,?,?,?)','J014','exhausted','[]',0,initial);
      this.event('J014','sequence.exhausted','Synthetic prior sequence exhausted: dispatcher review required');
      this.audit('demo-seed','demo.reset','Eight crews, fifteen jobs; two full crews and one unavailable');
    });
    // J009 is an actively failed notification, so the exception panel has a recoverable case.
    this.start('J009','demo-seed');
    return this.dashboard();
  }
  editCrew(crewId: string, data: RecordRow, actor='dispatcher') {
    return transaction(this.db,()=>{
      const existing=this.getCrew(crewId);
      const name=String(data.name??existing.name).trim().slice(0,80);
      const max=Number(data.max_capacity??existing.max_capacity);
      const baseline=Number(data.baseline_load??existing.baseline_load);
      const availability=String(data.availability??existing.availability);
      const channel=String(data.channel??existing.channel);
      const skills=Array.isArray(data.skills)?[...new Set(data.skills.map(String))]:existing.skills;
      const areas=Array.isArray(data.areas)?[...new Set(data.areas.map(String))]:existing.areas;
      const lat=data.base_lat===''?null:data.base_lat==null?existing.base_lat:Number(data.base_lat);
      const lon=data.base_lon===''?null:data.base_lon==null?existing.base_lon:Number(data.base_lon);
      assert(name.length>0,'Crew name required',400);
      assert(Number.isInteger(max)&&max>=1&&max<=20,'Capacity must be an integer from 1 to 20',400);
      assert(Number.isInteger(baseline)&&baseline>=0,'Current baseline workload must be a nonnegative integer',400);
      assert(baseline+existing.reserved<=max,'Capacity cannot be smaller than current workload and reservations',400);
      assert(['available','unavailable'].includes(availability),'Invalid availability',400);
      assert(['in_app','unavailable'].includes(channel),'Invalid notification channel',400);
      assert(skills.length>0&&areas.length>0,'At least one skill and service area required',400);
      assert(skills.every((x:string)=>!!one(this.db,'SELECT name FROM skills WHERE name=?',x)),'Unknown skill',400);
      assert(areas.every((x:string)=>!!one(this.db,'SELECT name FROM service_areas WHERE name=?',x)),'Unknown service area',400);
      assert((lat===null&&lon===null)||(lat!==null&&lon!==null&&Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180),'Invalid base coordinates',400);
      const assigned=many(this.db,`SELECT j.region, s.skill FROM assignments a JOIN jobs j ON j.id=a.job_id
        JOIN job_skills s ON s.job_id=j.id WHERE a.crew_id=? AND a.current=1`,crewId);
      assert(assigned.every((x:any)=>areas.includes(x.region)&&skills.includes(x.skill)),
        'Cannot remove an operational skill or region required by a current assignment',400);
      execute(this.db,'UPDATE crews SET name=?,max_capacity=?,baseline_load=?,base_lat=?,base_lon=?,channel=? WHERE id=?',name,max,baseline,lat,lon,channel,crewId);
      execute(this.db,'UPDATE crew_availability SET status=?,updated_ms=? WHERE crew_id=?',availability,this.now(),crewId);
      execute(this.db,'DELETE FROM crew_skills WHERE crew_id=?',crewId);
      execute(this.db,'DELETE FROM crew_areas WHERE crew_id=?',crewId);
      for(const skill of skills)execute(this.db,'INSERT INTO crew_skills VALUES (?,?)',crewId,skill);
      for(const area of areas)execute(this.db,'INSERT INTO crew_areas VALUES (?,?)',crewId,area);
      this.audit(actor,'crew.update',`Crew ${crewId}: availability=${availability}; channel=${channel}; capacity=${max}; baseline=${baseline}; skills=${skills.join('|')}; areas=${areas.join('|')}`);
      return this.getCrew(crewId);
    });
  }
  setCrewAvailability(crewId: string, status: string) {
    return transaction(this.db,()=>{
      assert(['available','unavailable'].includes(status),'Invalid crew availability',400);
      assert(!!one(this.db,'SELECT id FROM crews WHERE id=?',crewId),'Crew not found',404);
      execute(this.db,'UPDATE crew_availability SET status=?,updated_ms=? WHERE crew_id=?',status,this.now(),crewId);
      this.audit('dispatcher','crew.availability',`${crewId} → ${status}`);
      return this.getCrew(crewId);
    });
  }
  exportAudit() { return many(this.db,'SELECT * FROM audit_events ORDER BY at_ms,id'); }
}
