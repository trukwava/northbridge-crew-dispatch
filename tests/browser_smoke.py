"""Optional browser smoke test for restricted local-network browser environments.
UI source and API are the actual app; bridge transports HTTP through Python to the test browser.
Requires Playwright Python and a locally running server. Not part of npm test.
"""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from playwright.sync_api import sync_playwright

HERE=Path(__file__).resolve().parents[1]
P=HERE/'public'
HTML=(P/'index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','').replace('<script defer src="/app.js"></script>','')

def backend(url,method='GET',headers=None,data=None):
    if not isinstance(url,str): return {'status':200,'body':'{}','contentType':'application/json'}
    try:
        req=Request('http://127.0.0.1:4173'+url,headers=headers or {},
                    data=data.encode() if data else None,method=method)
        with urlopen(req,timeout=5) as r:
            return {'status':r.status,'body':r.read().decode(),'contentType':r.headers.get('Content-Type','application/json')}
    except HTTPError as e:
        return {'status':e.code,'body':e.read().decode(),'contentType':e.headers.get('Content-Type','application/json')}

with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.expose_function('backend',backend)
    page.set_content(HTML)
    page.add_style_tag(content=(P/'styles.css').read_text())
    try:
        page.evaluate("window.fetch=async function(url,opts={}) { const r=await window.backend(url,opts.method||'GET',opts.headers||{},opts.body||'');return new Response(r.body,{status:r.status,headers:{'Content-Type':r.contentType}});};")
    except Exception: pass  # The managed browser sometimes performs a blocked probe after registration.
    page.add_script_tag(content=(P/'app.js').read_text())
    page.get_by_text('Conflict-Safe Dispatch').wait_for(timeout=5000)
    assert page.locator('tr[data-job]').count()==15
    page.screenshot(path=str(HERE/'desktop-preview.png'),full_page=True)
    page.get_by_role('button',name='Crew portal').click()
    page.get_by_text('Crew offer inbox').wait_for(timeout=5000)
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path=str(HERE/'mobile-preview.png'),full_page=True)
    page.get_by_role('button',name='Dispatch desk').click()
    page.get_by_role('button',name='+ New service request').click()
    page.get_by_role('dialog').wait_for(timeout=5000)
    assert page.get_by_role('dialog').count()==1
    page.locator('input[name="title"]').fill('Synthetic browser interaction sample')
    page.locator('input[name="job_type"]').fill('Water mitigation')
    page.locator('input[name="address"]').fill('100 W 23rd St, Manhattan')
    page.locator('input[name="confirmed"]').check()
    page.locator('button[type="submit"]').click()
    page.get_by_text('Synthetic browser interaction sample').first.wait_for(timeout=5000)
    assert len(errors)==0,errors
    print('Browser bridge smoke PASS: initial render, desktop/mobile views, crew portal, create request')
    browser.close()
backend('/api/demo/reset','POST',{'X-Demo-Role':'dispatcher'},'{}')
