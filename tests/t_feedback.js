const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8077';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 const ROOT='/tmp/gfb';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8077',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const A=(await J('POST','/api/civilian/session',null,{secret:'fbciv'+'x'.repeat(20)})).j.token;
 ok('no token refused',(await J('POST','/api/feedback',null,{text:'hello there'})).s===401);
 ok('too short refused',(await J('POST','/api/feedback',A,{text:'hi'})).s===400);
 let r=await J('POST','/api/feedback',A,{kind:'problem',text:'The map is slow on my phone',app:'civilian'});ok('civilian sends',r.s===200&&/^FB-/.test(r.j.id),r);
 r=await J('POST','/api/feedback',A,{kind:'idea',text:'Add Twi please',contactOk:true,contact:'0200000099'});ok('civilian with contact',r.s===200);
 ok('civilian cannot read the list',(await J('GET','/api/feedback',A)).s===403);
 ok('HQ cannot send',(await J('POST','/api/feedback',hq,{text:'hello there'})).s===403);
 const L=await J('GET','/api/feedback',hq);ok('HQ reads both',L.s===200&&L.j.total===2&&L.j.open===2,L.j);
 const a=L.j.items.find(x=>/map is slow/.test(x.text)),b=L.j.items.find(x=>/Twi/.test(x.text));
 ok('anonymous stays anonymous',a.from==='anonymous'&&!JSON.stringify(a).includes('fbciv'),a);
 ok('contact only when ticked',b.from==='0200000099');
 ok('feedback key private',(await J('GET','/api/kv/'+encodeURIComponent('registry:feedback'),hq)).s===403);
 for(let i=0;i<10;i++)r=await J('POST','/api/feedback',A,{text:'spam spam '+i});ok('rate limited',r.s===429,r.s);
 ok('mark done',(await J('POST','/api/feedback/status',hq,{id:a.id,status:'done'})).s===200&&(await J('GET','/api/feedback',hq)).j.items.find(x=>x.id===a.id).status==='done');
 // UI
 const br=await chromium.launch();
 const mk=async(f,geo)=>{const c=await br.newContext({geolocation:geo||{latitude:7.152,longitude:0.474},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};

 const C=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.48});
 await C.evaluate(()=>{Feedback.open('civilian',true)});await sleep(400);
 await C.fill('#fb-text','UI feedback from the phone screen');await C.click('#fb-send');await sleep(1500);
 ok('civilian UI shows sent with a reference',/FB-/.test(await C.evaluate(()=>document.getElementById('fb-overlay').innerText)));
 ok('civilian Profile has the button',(await C.evaluate(()=>document.documentElement.innerHTML)).includes("Feedback.open('civilian',true)"));
 const Q=await mk('geams-hq-dashboard__1_.html');await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Test-Owner-Pass-1');await Q.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);
 await Q.evaluate(()=>{HqOps.feedback()});await sleep(1800);
 const m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('HQ screen lists the UI feedback',/UI feedback from the phone screen/.test(m)&&/anonymous/.test(m),m.slice(0,200));
 for(const f of ['geams-dispatch-app.html','geams-fire-service.html','geams-ambulance-service.html']){ok(f+' has a feedback button',(fs.readFileSync(f,'utf8').match(/Feedback\.open\(/g)||[]).length>=1);}
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
