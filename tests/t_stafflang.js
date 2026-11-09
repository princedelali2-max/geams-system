const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
(async()=>{const R='/tmp/gslang';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8106',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2500);
 const br=await chromium.launch();
 for(const f of ['geams-dispatch-app','geams-fire-service','geams-ambulance-service','geams-station-dashboard__1_','geams-hq-dashboard__1_']){
  const c=await br.newContext({viewport:{width:1280,height:800}});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|fonts/,r=>r.abort());const P=await c.newPage();await P.goto('http://localhost:8106/'+f+'.html');await sleep(1800);
  await P.click('#geams-a11y-fab');await P.click('#a11y-lang');await sleep(800);
  const ov=await P.evaluate(()=>document.getElementById('i18n-overlay').innerText.replace(/\n/g,' '));
  ok(f+': picker opens from the Aa button and explains staff limits',/Incident details, statuses and names always stay in English/.test(ov),ov.slice(0,200));
  ok(f+': Twi and Hausa offered as unchecked drafts, Ewe/Ga/Dagbani not available',/Twi \(Akan\)\s+\d+ phrases · unchecked draft/.test(ov)&&/Hausa\s+\d+ phrases · unchecked draft/.test(ov)&&/Ewe\s+not available yet/.test(ov)&&/Dagbani\s+not available yet/.test(ov),ov);
  await P.evaluate(()=>document.querySelector('#i18n-overlay button[data-l="ha"]').click());await sleep(1000);
  const lang=await P.evaluate(()=>({l:localStorage.getItem('geams_lang'),t:document.body.innerText}));
  ok(f+': Hausa is applied only where a word exists, rest stays English',lang.l==='ha'&&/Sign in|SIGN IN|Dispatch|Station|GEAMS/i.test(lang.t),lang.t.slice(0,120));
  await P.evaluate(()=>{const d=document.createElement('div');d.id='tt';d.textContent='Fire';document.body.appendChild(d);const e=document.createElement('div');e.id='tt2';e.textContent='Settings';document.body.appendChild(e)});await sleep(500);
  ok(f+': live data words such as "Fire" are never translated in staff apps',await P.evaluate(()=>document.getElementById('tt').textContent==='Fire'));
  ok(f+': a button word from the staff list is translated',await P.evaluate(()=>document.getElementById('tt2').textContent==='Saituna'));
  await P.evaluate(()=>GeamsI18n.set('en'));await sleep(500);
  ok(f+': back to English restores',await P.evaluate(()=>document.getElementById('tt2').textContent==='Settings'));
  await c.close();}
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
