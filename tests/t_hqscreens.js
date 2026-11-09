const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const B='http://localhost:8064';
(async()=>{
 const ROOT='/tmp/ghqs';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const key='lcr:GH-VR-HOH-001-P3Q7:incidents',now=Date.now(),day=86400000;
 const inc={OLD1:{id:'OLD1',status:'resolved',civilianName:'Ama',createdAt:new Date(now-200*day).toISOString(),srv:{received:now-200*day},resolvedAt:now-200*day}};
 fs.writeFileSync(ROOT+'/d.json',JSON.stringify({[key]:{value:inc,v:1,ts:now}}));
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8064',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_BACKUP_DIR:ROOT+'/bk'}});await sleep(2500);
 const br=await chromium.launch();
 const mk=async(f)=>{const c=await br.newContext({geolocation:{latitude:7.152,longitude:0.474},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};
 const Q=await mk('geams-hq-dashboard__1_.html');await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Test-Owner-Pass-1');await Q.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);

 // make some history: a flagged prankster and a staff action
 const hq0=(await (await fetch(B+'/api/hq/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'hqadmin',password:'Test-Owner-Pass-1'})})).json()).token;
 const H='GH-VR-HOH-001-P3Q7',K='/api/kv/'+encodeURIComponent('lcr:'+H+':incidents');
 const put=(v)=>fetch(B+K,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+hq0},body:JSON.stringify({value:v})});
 await put({Z1:{id:'Z1',type:'fire',priority:'high',status:'resolved',resolvedAt:Date.now(),location:'x',lat:7.15,lng:0.47,civilianId:'CIV-7001',civilianName:'Test Prank',civilianPhone:'0200007001',createdAt:new Date().toISOString(),source:'walk-in',flagged:{reason:'Suspected prank',by:'x'}}});
 await sleep(800);
 await Q.evaluate(()=>{HqOps.abuse()});await sleep(1800);
 let m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('abuse screen lists the flagged person and the warning about blocks',/CIV-7001/.test(m)&&/1 false of 1/.test(m)&&/cost a life/.test(m),m.slice(0,300));
 Q.on('dialog',d=>d.accept('repeated pranks'));
 await Q.evaluate(()=>{HqOps.abuseSet('CIV-7001','flag')});await sleep(2500);
 m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('flagging from the screen works and shows on the list',/FLAG/.test(m)&&/repeated pranks/.test(m),m.slice(0,300));
 await Q.evaluate(()=>{HqOps.staffLog()});await sleep(1800);
 m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('staff log screen shows the incident and the abuse action',/incident\.created/.test(m)&&/abuse\.flag/.test(m)&&!/Test Prank|0200007001/.test(m),m.slice(0,300));
 ok('HQ buttons present (staff log, abuse, errors, feedback)',['staffLog','abuse','appErrors','feedback'].every(n=>(fs.readFileSync('geams-hq-dashboard__1_.html','utf8').match(new RegExp('HqOps\\.'+n+'\\(\\)','g'))||[]).length>=2));
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
