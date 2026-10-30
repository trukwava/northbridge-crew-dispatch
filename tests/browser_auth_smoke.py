"""Optional UI/browser bridge test. The browser container blocks localhost navigation, so requests are relayed to the real localhost server through Python. Tests actual UI JS and server APIs, not deployment/TLS."""
from pathlib import Path
from tempfile import TemporaryDirectory
from subprocess import Popen,DEVNULL
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import os,time,json,socket
from playwright.sync_api import sync_playwright

BASE=Path(__file__).resolve().parents[1]
HTML=(BASE/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','').replace('<script defer src="/app.js"></script>','').replace('<script defer src="/crew-admin.js"></script>','')

def unused_port():
  with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

with TemporaryDirectory() as temp:
  port=unused_port()
  env={**os.environ,'PORT':str(port),'DB_PATH':str(Path(temp)/'app.sqlite'),'AUTH_MODE':'preview','PREVIEW_DISPATCHER_KEY':'dispatcher-long-unique-preview-secret-43','PREVIEW_CREW_KEYS_JSON':json.dumps({'A':'crew-A-individual-long-preview-secret-43','B':'crew-B-individual-long-preview-secret-43'})}
  child=Popen(['node','--experimental-strip-types','src/server.ts'],cwd=BASE,env=env,stdout=DEVNULL,stderr=DEVNULL)
  cookie=''
  def backend(path,method='GET',headers=None,data=''):
    global cookie
    h=dict(headers or {})
    if cookie:h['Cookie']=cookie
    request=Request(f'http://127.0.0.1:{port}'+str(path),headers=h,data=data.encode() if data else (b'' if method=='POST' else None),method=method)
    try:
      with urlopen(request,timeout=5) as resp:
        if resp.headers.get('Set-Cookie'):cookie=resp.headers.get('Set-Cookie').split(';')[0]
        return {'status':resp.status,'body':resp.read().decode()}
    except HTTPError as e:return {'status':e.code,'body':e.read().decode()}
  try:
    for _ in range(120):
      try:
        if backend('/api/session')['status']==200:break
      except OSError:time.sleep(.04)
    else:raise RuntimeError('Server did not start')
    with sync_playwright() as p:
      browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
      page=browser.new_page(viewport={'width':1280,'height':900})
      errors=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      page.expose_function('backend',backend)
      page.set_content(HTML)
      page.add_style_tag(content=(BASE/'public/styles.css').read_text())
      try:
        page.evaluate('''window.fetch=async (path,opts={})=>{const r=await window.backend(path,opts.method||'GET',opts.headers||{},opts.body||'');return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json'}})}''')
      except Exception as exc:print('Browser bridge injection restriction:',str(exc)[:180])
      page.add_script_tag(content=(BASE/'public/app.js').read_text())
      page.get_by_text('Sign in to preview').wait_for(timeout=5000)
      page.locator('input[name=key]').fill(env['PREVIEW_DISPATCHER_KEY'])
      page.locator('#login-form button[type=submit]').click()
      page.get_by_text('Dispatch overview').wait_for(timeout=5000)
      assert page.locator('.tab:not([hidden])').count()==1
      page.get_by_role('button',name='Start offer sequence').first.click()
      page.get_by_text('Pending offer to Crew A').wait_for(timeout=5000)
      page.get_by_role('button',name='Sign out').click()
      page.get_by_text('Sign in to preview').wait_for(timeout=5000)
      page.locator('#login-role').select_option('crew')
      page.locator('select[name=crewId]').select_option('A')
      page.locator('input[name=key]').fill(json.loads(env['PREVIEW_CREW_KEYS_JSON'])['A'])
      page.locator('#login-form button[type=submit]').click()
      page.get_by_text('Crew offer inbox').wait_for(timeout=5000)
      assert page.locator('.tab:not([hidden])').count()==1
      assert page.get_by_role('button',name='Accept assignment').count()==1
      page.get_by_role('button',name='Accept assignment').click()
      page.get_by_text('No active offers for this crew').wait_for(timeout=5000)
      assert not errors,errors
      print('Browser-bridged preview PASS: dispatcher sign-in -> start offer -> sign-out -> Crew A sign-in -> accept')
      browser.close()
  finally:
    child.terminate()
    try:child.wait(timeout=3)
    except Exception:child.kill()
