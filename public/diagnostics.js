/* Dispatcher-only read-only integrity inspection and operator guidance. */
(() => {
  const make=(tag,properties={},label='')=>{const el=document.createElement(tag);for(const [key,value] of Object.entries(properties))el.setAttribute(key,value);el.textContent=label;return el;};
  window.nbOpenDiagnostics=()=>{
    const dialog=make('dialog',{class:'modal diagnostics-dialog','aria-label':'Dispatch integrity inspector'});
    const head=make('div',{class:'modal-top'});head.append(make('span',{class:'eyebrow'},'NORTHBRIDGE / INTEGRITY INSPECTION'));
    const dismiss=make('button',{type:'button',class:'close','aria-label':'Close diagnostics'},'×');dismiss.onclick=()=>dialog.close();head.append(dismiss);dialog.append(head);
    dialog.append(make('h2',{},'Database consistency check'),make('p',{class:'note'},'Reads existing data without changing crew capacity, offers, assignments, or the clock. Findings do not replace a security or production audit.'));
    const run=make('button',{type:'button',class:'button primary'},'Refresh diagnostics');dialog.append(run);
    const content=make('div',{'aria-live':'polite',class:'diagnostics-results'});dialog.append(content);
    async function refresh(){run.disabled=true;content.replaceChildren(make('p',{class:'note'},'Checking persisted invariants…'));
      try{const headers=window.nbCsrf?{'X-CSRF-Token':window.nbCsrf}:{'X-Demo-Role':'dispatcher'};
        const response=await fetch('/api/diagnostics',{headers});const data=await response.json();if(!response.ok)throw Error(data.error||'Diagnostics unavailable');
        content.replaceChildren();const outcome=make('p',{class:'diagnostics-verdict'},data.stopPilot?'STOP CONDITION — critical mismatch found':'No critical mismatch detected');outcome.dataset.state=data.stopPilot?'critical':'ok';content.append(outcome);
        content.append(make('p',{class:'note'},`${data.summary.critical} critical finding(s), ${data.summary.warnings} warning(s). ${data.guidance}`));
        for(const finding of data.findings){const card=make('div',{class:'diagnostics-finding'});card.append(make('strong',{},`${finding.severity.toUpperCase()}: ${finding.code.replaceAll('_',' ')} (${finding.count})`));
          card.append(make('p',{},'Example IDs: '+finding.sampleIds.join(', ')),make('p',{},finding.guidance));content.append(card);}
        if(!data.findings.length)content.append(make('p',{class:'note'},'No warnings or critical findings in this snapshot.'));
      }catch(e){content.replaceChildren(make('p',{role:'alert',class:'note'},e.message||String(e)));}finally{run.disabled=false;}
    }
    run.onclick=refresh;document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();refresh();
  };
})();
