/** Read-only invariant inspection. Detects failures outside normal application write paths. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Sqlite} from './db.ts';

export type Finding={code:string;severity:'critical'|'warning';count:number;sampleIds:string[];guidance:string};
export function inspectDispatch(db:Sqlite,nowMs:number) {
  const checks:[string,Finding['severity'],string,string][]=[
    ['assignment_without_reservation','critical',`SELECT a.job_id AS id FROM assignments a LEFT JOIN capacity_reservations r ON r.job_id=a.job_id AND r.crew_id=a.crew_id AND r.active=1 WHERE a.current=1 AND r.id IS NULL`,
      'Stop any live dispatch. Reconcile assignment and capacity reservation from audited history.'],
    ['reservation_without_assignment','critical',`SELECT r.job_id AS id FROM capacity_reservations r LEFT JOIN assignments a ON a.job_id=r.job_id AND a.crew_id=r.crew_id AND a.current=1 WHERE r.active=1 AND a.id IS NULL`,
      'Stop dispatch. Determine which job owns the active capacity slot before release.'],
    ['crew_over_capacity','critical',`SELECT c.id AS id FROM crews c WHERE c.baseline_load+(SELECT COUNT(*) FROM capacity_reservations r WHERE r.crew_id=c.id AND r.active=1)>c.max_capacity`,
      'Stop dispatch. Correct capacity and inspect all competing assignments.'],
    ['assignment_job_state_mismatch','critical',`SELECT a.job_id AS id FROM assignments a JOIN jobs j ON j.id=a.job_id WHERE a.current=1 AND j.status NOT IN ('assigned','en_route','arrived','in_progress')`,
      'Stop dispatch. Reconcile the active assignment with its job state.'],
    ['job_without_current_assignment','critical',`SELECT j.id FROM jobs j WHERE j.status IN ('assigned','en_route','arrived','in_progress') AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.job_id=j.id AND a.current=1)`,
      'Stop dispatch. The job indicates an active assignment but no current crew is assigned. Reconcile the assignment history.'],
    ['active_sequence_without_pending_offer','critical',`SELECT s.job_id AS id FROM offer_sequences s WHERE s.status='active' AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.job_id=s.job_id AND o.status='pending')`,
      'Stop dispatch. The active offer sequence has no pending offer and cannot be safely escalated.'],
    ['pending_offer_job_state_mismatch','critical',`SELECT o.job_id AS id FROM offers o JOIN jobs j ON j.id=o.job_id LEFT JOIN offer_sequences s ON s.job_id=o.job_id WHERE o.status='pending' AND (j.status<>'offering' OR s.status NOT IN ('active','paused') OR s.status IS NULL)`,
      'Stop dispatch. A pending offer is not attached to a valid open sequence.'],
    ['overdue_offer','warning',`SELECT job_id AS id FROM offers WHERE status='pending' AND expires_ms<=${Math.floor(nowMs)}`,
      'Run the durable expiry worker; it should advance each expired offer at most once.'],
    ['failed_notification','warning',`SELECT DISTINCT o.job_id AS id FROM notification_attempts n JOIN offers o ON o.id=n.offer_id WHERE n.status='failed' AND o.status='pending'`,
      'Inspect the simulated channel and retry only a live pending offer.'],
    ['location_review_required','warning',`SELECT id FROM jobs WHERE status='review'`,
      'A dispatcher must manually confirm the request location before any offer.']
  ];
  const findings:Finding[]=[];
  for(const [code,severity,query,guidance] of checks) {
    const rows=db.prepare(query).all() as {id:string}[];
    if(rows.length)findings.push({code,severity,count:rows.length,sampleIds:rows.slice(0,10).map(x=>x.id),guidance});
  }
  const critical=findings.filter(f=>f.severity==='critical').reduce((sum,f)=>sum+f.count,0);
  const warnings=findings.filter(f=>f.severity==='warning').reduce((sum,f)=>sum+f.count,0);
  return {ok:critical===0,stopPilot:critical>0,checkedAt:new Date(Date.now()).toISOString(),
    mode:'read-only',summary:{critical,warnings},findings,
    guidance:critical?'Pilot stop: resolve critical invariants before any operational decisions.':'No critical invariant breaches detected. Warnings still require human review.'};
}

/** Local health command. Never creates a new database just to inspect it. */
if(process.argv[1] && /(?:^|\/)diagnostics\.(?:ts|js)$/.test(process.argv[1])) {
  const path=resolve(process.env.DB_PATH||'./data/crew-dispatch.sqlite');
  if(!existsSync(path)) { console.error('No SQLite database at',path);process.exitCode=2; }
  else {
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      const row=db.prepare("SELECT value FROM settings WHERE key='demo_now'").get() as {value:string}|undefined;
      const check=inspectDispatch(db,Number(row?.value??Date.now()));
      console.log(JSON.stringify(check,null,2));
      if(check.stopPilot) process.exitCode=1;
    } catch(error) {console.error('Integrity inspection failed:',error);process.exitCode=2;}
    finally{db.close();}
  }
}
