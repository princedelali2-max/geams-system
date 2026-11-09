const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8107';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gguide';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8107',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_AUTO_APPROVE_UNITS:'1'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 for(const [k,n,ph] of [['officer','Guide Officer','0243300001'],['fire','Guide Fire','0243300002'],['ambulance','Guide Amb','0243300003']])await J('POST','/api/unit/signup',null,{kind:k,password:'abcdef1',cred:{name:n,phone:ph,lcrId:H}});
 const br=await chromium.launch();
 const mk=async(w=1280,h=800)=>{const c=await br.newContext({viewport:{width:w,height:h},geolocation:{latitude:7.15,longitude:0.47},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const P=await c.newPage();P.writes=[];P.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method())&&!/clientlog|csp-report|login|signup|session/.test(r.url()))P.writes.push(r.method()+' '+r.url())});P.errs=[];P.on('pageerror',e=>P.errs.push(e.message));return P};
 const cardText=P=>P.evaluate(()=>document.getElementById('guide-card')&&document.getElementById('guide-card').innerText);
 const apps={
  civilian:{f:'geams-civilian-app',w:390,login:async P=>{await P.evaluate(()=>{CivilianData.user.id='CIV-10001';CivilianData.user.name='Ama';CivilianData.user.phone='0200000001';CivilianData.user.pin='1234';CivilianData.saveAccount();document.getElementById('pin-gate').classList.add('hidden');CivilianApp.enterApp();setTimeout(()=>{const g=document.getElementById('pin-gate');g.classList.add('hidden');g.remove()},300)});await sleep(5000)}},
  dispatch:{f:'geams-dispatch-app',login:async P=>{await P.fill('#login-name','Guide Officer');await P.fill('#login-pass','abcdef1');await P.click('.login-btn');await sleep(4500)}},
  fire:{f:'geams-fire-service',w:390,login:async P=>{await P.fill('#login-name','Guide Fire');await P.fill('#login-pass','abcdef1');await P.click('#login-btn');await sleep(4500)}},
  ambulance:{f:'geams-ambulance-service',w:390,login:async P=>{await P.fill('#login-name','Guide Amb');await P.fill('#login-pass','abcdef1');await P.click('#login-btn');await sleep(4500)}},
  station:{f:'geams-station-dashboard__1_',login:async P=>{await P.fill('#login-station-id',H);await P.fill('#login-passphrase','hohoe2024');await P.fill('#login-cmd-name','Kwame Mensah');await P.evaluate(()=>StationAuth.attemptLogin());await sleep(6000)}},
  hq:{f:'geams-hq-dashboard__1_',login:async P=>{await P.fill('#hq-user','hqadmin');await P.fill('#hq-pass','Test-Owner-Pass-1');await P.click('#hq-login-btn');await sleep(5000)}}};
 for(const [name,a] of Object.entries(apps)){
  const P=await mk(a.w||1280);await P.goto(B+'/'+a.f+'.html');await sleep(2500);
  ok(name+': tour is available',await P.evaluate(()=>GeamsGuide.has()&&GeamsGuide.steps()>=6));
  if(name!=='civilian'){await P.evaluate(()=>GeamsGuide.start());await sleep(600);let t=await cardText(P);ok(name+': before sign-in it says to sign in first, no pointing at hidden screens',/Sign in first/.test(t||''),t);await P.evaluate(()=>document.querySelector('#guide-card [data-g="x"]').click());}
  await a.login(P);
  await P.evaluate(()=>{const f=document.getElementById('geams-a11y-fab');if(f)f.click();else GeamsA11y.open()});await sleep(300);
  ok(name+': tour button is in Display settings',await P.evaluate(()=>!!document.getElementById('a11y-tour')));
  P.writes.length=0;await P.click('#a11y-tour');await sleep(900);
  const n=await P.evaluate(()=>GeamsGuide.steps());let seen=0,missing=[];
  for(let k=0;k<n;k++){await sleep(700);const t=await cardText(P);if(!t){missing.push('card gone at '+k);break}
   const ringOk=await P.evaluate(()=>{const r=document.getElementById('guide-ring');return r&&parseFloat(r.style.width)>0});
   const tgt=!/not on screen/.test(t);if(tgt&&ringOk)seen++;else if(!/Please do not test/.test(t))missing.push(k+':'+t.split('\n').slice(0,2).join('|'));
   if(k<n-1){const hasN=await P.evaluate(()=>!!document.querySelector('#guide-card [data-g="n"]'));if(!hasN){missing.push('no Next at '+k+': '+t.replace(/\n/g,' ').slice(0,120));break}await P.evaluate(()=>document.querySelector('#guide-card [data-g="n"]').click());}}
  ok(name+': every step points at a real, visible control ('+seen+' of '+n+')',missing.length===0,missing);
  const last=await cardText(P);ok(name+': last step has Done',/Done/.test(last||''));
  await P.evaluate(()=>document.querySelector('#guide-card [data-g="d"]').click());await sleep(300);
  ok(name+': Done closes the tour and remembers it',await P.evaluate(()=>!document.getElementById('guide-card')&&!document.getElementById('guide-ring')&&GeamsGuide.done()));
  await P.evaluate(()=>GeamsGuide.start());await sleep(800);await P.evaluate(()=>document.querySelector('#guide-card [data-g="n"]').click());await sleep(800);await P.evaluate(()=>document.querySelector('#guide-card [data-g="b"]').click());await sleep(800);
  ok(name+': Back returns to step 1',/Step 1 of/.test(await cardText(P)||''));
  await P.keyboard.press('Escape');await sleep(200);ok(name+': Escape closes it',await P.evaluate(()=>!document.getElementById('guide-card')));
  const bad=P.writes.filter(w=>/incidents|chat|evidence|alerts|handovers|roster|archive|feedback/.test(decodeURIComponent(w)));ok(name+': the tour wrote no alerts, incidents, chats or any other data (only the app\'s own signed-in heartbeat)',bad.length===0,bad);
  await P.close();}
 {const P=await mk(1280);await P.goto(B+'/geams-station-dashboard__1_.html');await sleep(2500);await apps.station.login(P);const v=await P.evaluate(()=>({c:document.getElementById('topbar-critical').textContent,b:getComputedStyle(document.getElementById('alert-badge')).display,l:document.getElementById('geams-a11y-fab').getBoundingClientRect().left}));ok('station top bar shows the real critical count (0), not a fixed number',v.c==='0'&&v.b==='none',v);ok('on wide screens the settings button sits bottom-right, off the sidebar',v.l>1000,v);await P.close();}
 // large text: ring still lines up with the button
 {const P=await mk(1280);await P.goto(B+'/geams-station-dashboard__1_.html');await sleep(2500);await apps.station.login(P);await P.evaluate(()=>{GeamsA11y.set({size:2})});await sleep(500);await P.evaluate(()=>GeamsGuide.start());await sleep(1200);
  const m=await P.evaluate(()=>{const r=document.getElementById('guide-ring').getBoundingClientRect(),e=document.querySelector('.nav-item[data-page="dashboard"]').getBoundingClientRect();return{ringL:r.left,ringT:r.top,eL:e.left,eT:e.top,dw:r.width-e.width}});
  ok('with large text the highlight still sits on the right button',Math.abs(m.ringL-(m.eL-4))<6&&Math.abs(m.ringT-(m.eT-4))<6,m);await P.close();}
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
