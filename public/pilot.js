/* Private, read-only shadow lab. No imported data is saved to localStorage or the database. */
(() => {
  const example={mode:'synthetic',requests:[
    {id:'P-001',region:'Manhattan',skills:['Water mitigation'],confirmed:true,address_present:true,lat:40.75,lon:-73.99},
    {id:'P-002',region:'Queens',skills:['Commercial cleaning'],confirmed:true,address_present:true},
    {id:'P-003',region:'Brooklyn',skills:['Mold remediation'],confirmed:true,address_present:true},
    {id:'P-004',region:'Newark',skills:['Water mitigation'],confirmed:false,address_present:true},
    {id:'P-005',region:'Manhattan',skills:['Fire restoration'],confirmed:false,address_present:false}
  ]};
  const make=(tag,props={},text='')=>{const el=document.createElement(tag);for(const [key,value] of Object.entries(props))el.setAttribute(key,value);el.textContent=text;return el;};
  function save(content,filename){const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));const a=make('a',{href:url,download:filename});a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  window.nbOpenPilot=()=>{
    const dialog=make('dialog',{class:'modal pilot-lab','aria-label':'Shadow-mode pilot evaluator'});
    const top=make('div',{class:'modal-top'});top.append(make('span',{class:'eyebrow'},'NORTHBRIDGE / SHADOW-MODE PILOT'));
    const close=make('button',{class:'close',type:'button','aria-label':'Close pilot evaluator'},'×');close.onclick=()=>dialog.close();top.append(close);dialog.append(top);
    dialog.append(make('h2',{},'Test a batch without dispatching'));
    dialog.append(make('p',{class:'note'},'Use synthetic or de-identified request descriptors only. Do not submit real addresses, names, customer records or contact details. Nothing is stored, assigned, or notified.'));
    const label=make('label',{},'Request descriptors (JSON, up to 50)');label.className='field-label';
    const area=make('textarea',{rows:'12','aria-label':'Synthetic request JSON'});area.value=JSON.stringify(example,null,2);label.append(area);dialog.append(label);
    const actions=make('div',{class:'inline-controls'});const sample=make('button',{class:'button',type:'button'},'Restore sample');sample.onclick=()=>{area.value=JSON.stringify(example,null,2);};
    const evaluate=make('button',{class:'button primary',type:'button'},'Evaluate eligibility');
    const download=make('button',{class:'button',type:'button'},'Export report JSON');download.disabled=true;
    actions.append(sample,evaluate,download);dialog.append(actions);
    const error=make('p',{class:'note',role:'alert'});const report=make('div',{'aria-live':'polite'});dialog.append(error,report);
    let last=null;
    evaluate.onclick=async()=>{
      evaluate.disabled=true;download.disabled=true;report.replaceChildren();error.textContent='';last=null;
      try {
        if(area.value.length>30000)throw Error('Input exceeds 30 KB. Keep the batch to 50 anonymous requests.');
        const payload=JSON.parse(area.value);
        const headers={'Content-Type':'application/json'};
        if(window.nbCsrf)headers['X-CSRF-Token']=window.nbCsrf;
        else headers['X-Demo-Role']='dispatcher';
        const response=await fetch('/api/pilot/evaluate',{method:'POST',headers,body:JSON.stringify(payload)});
        const data=await response.json();if(!response.ok)throw Error(data.error||'Evaluation failed');
        last=data;download.disabled=false;
        const grid=make('div',{class:'pilot-summary'});
        for(const [key,val] of [['Requests',data.summary.total],['Has candidate',data.summary.withEligibleCrew],['Review needed',data.summary.needsLocationReview],['No eligible crew',data.summary.noEligibleCrew]]){
          const card=make('div',{class:'metric'});card.append(make('div',{class:'eyebrow'},key),make('div',{class:'num'},String(val)));grid.append(card);
        }
        report.append(grid,make('p',{class:'note'},data.disclaimer));
        const list=make('div',{class:'pilot-results'});
        for(const row of data.results){const item=make('div',{class:'ranking-row'});
          item.append(make('span',{class:'rank-symbol'},row.eligibleCount>0?'✓':'!'));
          const content=make('div',{class:'rank-copy'});content.append(make('strong',{},row.id+' · '+row.region));
          const reason=row.reviewReasons.length?row.reviewReasons.join('; '):row.eligibleCount?`${row.eligibleCount} eligible · first candidate ${row.firstCandidate}`:'No eligible crew under current rules';
          content.append(make('p',{},reason));item.append(content);list.append(item);
        }
        report.append(list);
      }catch(e){error.textContent=e.message||String(e);}finally{evaluate.disabled=false;}
    };
    download.onclick=()=>{if(last)save(JSON.stringify(last,null,2),'northbridge-synthetic-shadow-report.json');};
    document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
  };
})();
