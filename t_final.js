const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7',H2='GH-GA-ACC-001-B9C1',B='http://localhost:8092';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
const kv=k=>'/api/kv/'+encodeURIComponent(k);
(async()=>{
 const ROOT='/tmp/gfin';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8092',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const st=n=>({id:n,name:n,region:'Volta',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000});
 await J('PUT',kv('registry:stations'),hq,{value:{[H]:st(H),[H2]:st(H2)}});
 const mkUnit=async(kind,name,phone,lcr)=>{await J('POST','/api/unit/signup',null,{kind,password:'pass1234',cred:{name,phone,lcrId:lcr,rank:'X'}});const p=(await J('GET','/api/lcr/pending',hq)).j.pending.find(x=>x.name===name);await J('POST','/api/lcr/approve',hq,{kind,badge:p.badge,approve:true});return (await J('POST','/api/unit/login',null,{kind,name,password:'pass1234'})).j};
 const o1=await mkUnit('officer','Own Officer','0241000001',H),o2=await mkUnit('officer','Far Officer','0241000002',H2),f1=await mkUnit('fire','Own Fire','0241000003',H),f2=await mkUnit('fire','Far Fire','0241000004',H2),a2=await mkUnit('ambulance','Far Amb','0241000005',H2);
 ok('five staff signed in',[o1,o2,f1,f2,a2].every(x=>x.token));
 const A=(await J('POST','/api/civilian/session',null,{secret:'secretA-'+'a'.repeat(30)})).j.token;
 await J('PUT',kv('lcr:'+H+':incidents'),A,{value:{'INC-F1':{id:'INC-F1',status:'new',type:'medical',lat:7.158,lng:0.48,civilianName:'A',time:Date.now()}}});
 await J('PUT',kv('chat:INC-F1'),hq,{value:[{from:'hq',text:'secret chat'}]});
 for(const [n,t,allow] of [['own officer',o1.token,true],['own fire',f1.token,true],['other-station officer',o2.token,false],['other-station fire',f2.token,false],['other-station ambulance',a2.token,false]]){
  const r=await J('GET',kv('chat:INC-F1'),t);ok(n+(allow?' can':' cannot')+' read chat of the incident',allow?(r.s===200&&JSON.stringify(r.j).includes('secret chat')):r.s===403,JSON.stringify(r).slice(0,100));
  const b=await J('GET','/api/blobs/INC-F1',t);ok(n+(allow?' can':' cannot')+' list its evidence',allow?b.s===200:b.s===403,String(b.s));
 }
 {const r=await J('PUT',kv('chat:INC-F1'),o2.token,{value:[{from:'x',text:'intrude'}]});ok('other-station officer cannot write chat',r.s===403,String(r.s));}
 {const r=await J('PUT',kv('chat:INC-NEW'),o1.token,{value:[{from:'o',text:'queued'}]});ok('own officer can write for an incident not yet synced',r.s===200,String(r.s));}
 // ---- browsers
 const br=await chromium.launch();
 const mk=async(f)=>{const c=await br.newContext({geolocation:{latitude:7.152,longitude:0.474},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};
 // lockdown banner on the three crew apps
 await J('POST','/api/hq/lockdown',hq,{on:true,reason:'drill'});
 for(const [f,tok,key] of [['geams-dispatch-app.html',o1.token,'lcr:'+H+':officers'],['geams-fire-service.html',f1.token,'fire:'+H+':incidents'],['geams-ambulance-service.html',(await mkUnit('ambulance','Own Amb','0241000006',H)).token,'ambulance:'+H+':incidents']]){
  const P=await mk(f);await P.evaluate(t=>GeamsSync.setToken(t),tok);
  await P.evaluate(async k=>{try{await GeamsSync.setShared(k,{x:{id:'x'}})}catch(e){}},key);await sleep(1500);
  const txt=await P.evaluate(()=>{const b=document.getElementById('lockdown-refused');return b&&b.style.display!=='none'?b.textContent:''});
  ok(f+' tells the crew the update was NOT sent during lockdown',/NOT sent/.test(txt),txt);
 }
 await J('POST','/api/hq/lockdown',hq,{on:false});
 // dispatch sketch upload
 const D=await mk('geams-dispatch-app.html');
 await D.evaluate(()=>DispatchApp.showSignupForm());await D.fill('#su-name','Sketch Officer');await D.fill('#su-phone','0240000077');await D.selectOption('#su-lcr',H);await D.fill('#su-pass','secret12');await D.fill('#su-pass2','secret12');await D.evaluate(()=>DispatchApp.doSignup());await sleep(4000);
 const pn=(await J('GET','/api/lcr/pending',hq)).j.pending.find(x=>x.name==='Sketch Officer');await J('POST','/api/lcr/approve',hq,{kind:'officer',badge:pn.badge,approve:true});
 await D.evaluate(()=>{document.getElementById('login-name').value='Sketch Officer';document.getElementById('login-pass').value='secret12';DispatchApp.doLogin()});await sleep(6500);
 const sk=await D.evaluate(()=>{DispatchData.currentJob={id:'INC-F1',_syncIncId:'INC-F1',_syncSource:'civilian-app'};const c=document.createElement('canvas');c.width=40;c.height=40;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(5,5,20,20);window._sketchDrawCanvas=c;return true});
 await D.evaluate(()=>DispatchApp.saveSketch());await sleep(4500);
 const man=await J('GET',kv('archive:INC-F1:media'),hq);const bl=await J('GET','/api/blobs/INC-F1',hq);
 ok('sketch PNG stored as evidence on the server',JSON.stringify(man.j).includes('sketch')&&JSON.stringify(bl.j).includes('scene-sketch'),JSON.stringify(man.j).slice(0,200)+JSON.stringify(bl.j).slice(0,200));
 // HQ face audit screen
 await J('POST','/api/face/search',hq,{incId:'INC-F1',descriptor:Array(128).fill(0.1),subject:'Suspect'});
 const Q=await mk('geams-hq-dashboard__1_.html');await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Test-Owner-Pass-1');await Q.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);
 await Q.evaluate(()=>HqOps.faceAudit());await sleep(1800);
 const m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('HQ face log screen lists the search',/Face search/.test(m)&&/INC-F1/.test(m)&&/Suspect/.test(m),m.slice(0,200));
 ok('both HQ dashboard buttons present',(await Q.evaluate(()=>(document.documentElement.innerHTML.match(/HqOps\.faceAudit\(\)/g)||[]).length))>=2);
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
