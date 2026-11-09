const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
(async()=>{const R='/tmp/ga11y';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8101',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0',GEAMS_SEED_DEFAULT_STATIONS:'1'}});await sleep(2500);
 const br=await chromium.launch();
 const pages=['geams-civilian-app','geams-dispatch-app','geams-fire-service','geams-ambulance-service','geams-station-dashboard__1_','geams-hq-dashboard__1_'];
 for(const f of pages){
  const wide=/station|hq/.test(f);const c=await br.newContext({viewport:{width:wide?1280:390,height:800}});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const P=await c.newPage();const errs=[];P.on('pageerror',e=>errs.push(e.message));
  await P.goto('http://localhost:8101/'+f+'.html');await sleep(2000);
  const fab=await P.evaluate(()=>!!document.getElementById('geams-a11y-fab'));
  ok(f+': settings button '+(f==='geams-civilian-app'?'absent (Profile row instead)':'present'),f==='geams-civilian-app'?!fab:fab);
  if(f!=='geams-civilian-app')ok(f+': settings button is on top and tappable',await P.evaluate(()=>{const b=document.getElementById('geams-a11y-fab').getBoundingClientRect();const e=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return e&&e.id==='geams-a11y-fab'}));
  ok(f+': script loaded',await P.evaluate(()=>!!window.GeamsA11y&&!!window.GeamsI18n));
  await P.evaluate(()=>GeamsA11y.open());await sleep(200);
  const ov=await P.evaluate(()=>document.getElementById('a11y-overlay')&&document.getElementById('a11y-overlay').innerText);
  ok(f+': panel opens with text size/contrast/movement/language',/Text size/.test(ov||'')&&/Contrast/.test(ov)&&/Movement/.test(ov)&&/Language/.test(ov),ov);
  await P.click('#a11y-overlay button[data-k="size2"]');await P.click('#a11y-overlay button[data-k="hc1"]');await P.click('#a11y-overlay button[data-k="rm1"]');
  const cl=await P.evaluate(()=>document.documentElement.className);
  ok(f+': large text, contrast and reduced movement classes set',/a11y-size2/.test(cl)&&/a11y-hc/.test(cl)&&/a11y-rm/.test(cl),cl);
  await P.click('#a11y-close');await sleep(300);
  const z=await P.evaluate(()=>({zoom:getComputedStyle(document.documentElement).zoom,sw:document.documentElement.scrollWidth,iw:innerWidth}));
  ok(f+': text enlarged (zoom 1.3)',String(z.zoom)==='1.3',z);
  ok(f+': no sideways scrolling after enlarging',z.sw/parseFloat(z.zoom)<=z.iw+2,z);
  await P.reload();await sleep(1500);
  ok(f+': choice remembered after reload',await P.evaluate(()=>/a11y-size2/.test(document.documentElement.className)&&/a11y-hc/.test(document.documentElement.className)));
  await P.evaluate(()=>GeamsA11y.open());await P.click('#a11y-reset');await P.click('#a11y-close');
  ok(f+': reset returns to normal',await P.evaluate(()=>!/a11y-/.test(document.documentElement.className.replace(/a11y-kb/,''))||document.documentElement.className.trim()===''),await P.evaluate(()=>document.documentElement.className));
  ok(f+': no script errors',errs.length===0,errs);
  await c.close();}
 // phone setting for reduced motion is honoured
 {const c=await br.newContext({reducedMotion:'reduce'});const P=await c.newPage();await P.goto('http://localhost:8101/geams-dispatch-app.html');await sleep(1500);ok('phone "reduce motion" setting is followed by default',await P.evaluate(()=>/a11y-rm/.test(document.documentElement.className)));await c.close();}
 // screen reader names, civilian after login
 {const c=await br.newContext({viewport:{width:390,height:800},geolocation:{latitude:7.15,longitude:0.47},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const P=await c.newPage();
  await P.goto('http://localhost:8101/geams-civilian-app.html');await sleep(2500);
  await P.evaluate(()=>{CivilianData.user.id='CIV-10001';CivilianData.user.name='Ama';CivilianData.user.phone='0200000001';CivilianData.user.pin='1234';CivilianData.saveAccount();document.getElementById('pin-gate').classList.add('hidden');CivilianApp.enterApp()});await sleep(1500);
  for(const pg of ['home','profile']){await P.evaluate(p=>{try{CivilianApp.navigate(p)}catch(e){}},pg);await sleep(700);}
  const bad=await P.evaluate(()=>[...document.querySelectorAll('button,[role=button],a[href]')].filter(e=>e.offsetParent&&!(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent.trim())).map(e=>e.outerHTML.slice(0,80)));
  ok('every visible button has a name a screen reader can read',bad.length===0,bad);
  const nokb=await P.evaluate(()=>[...document.querySelectorAll('[onclick]')].filter(e=>!/^(BUTTON|A|INPUT|SELECT)$/.test(e.tagName)&&e.offsetParent&&!(e.getAttribute('role')==='button'&&e.hasAttribute('tabindex'))).map(e=>e.outerHTML.slice(0,80)));
  ok('clickable boxes can be reached and used from a keyboard',nokb.length===0,nokb.slice(0,3));
  await P.evaluate(()=>{const d=document.createElement('div');d.setAttribute('onclick','window.__k=1');d.id='kbt';d.textContent='x';document.body.appendChild(d)});await sleep(200);
  await P.focus('#kbt');await P.keyboard.press('Enter');ok('Enter key activates a clickable box',await P.evaluate(()=>window.__k===1));
  await P.evaluate(()=>{const t=document.createElement('div');t.className='toast success';t.textContent='Report sent to control room';document.body.appendChild(t)});await sleep(400);
  ok('pop-up messages are copied to the screen-reader announcement area',await P.evaluate(()=>/Report sent/.test(document.getElementById('geams-sr-live').textContent)));
  await P.evaluate(()=>{const i=document.createElement('input');i.placeholder='Your phone number';i.id='pi';document.body.appendChild(i)});await sleep(200);
  ok('unlabelled fields get their hint as a name',await P.evaluate(()=>document.getElementById('pi').getAttribute('aria-label')==='Your phone number'));
  await P.evaluate(()=>CivilianApp.navigate('profile'));await sleep(500);
  ok('Profile has the text size row',/Text size, contrast & movement/.test(await P.evaluate(()=>document.body.innerText)));
  await c.close();}
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
