const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const B='http://localhost:8071';const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gdiag';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 fs.copyFileSync('geams-civilian-app.html',R+'/copy.html');
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8071',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const br=await chromium.launch();const c=await br.newContext();await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const P=await c.newPage();
 await P.goto(B+'/geams-civilian-app.html');await sleep(2500);
 const b1=await P.evaluate(()=>window.GEAMS_BUILD);ok('page carries a build id',/^[0-9a-f]{8}$/.test(b1),b1);
 const v=await J('GET','/api/version?f=geams-civilian-app.html');ok('server reports the same build',v.j.build===b1,v.j);
 ok('version lookup refuses other files',(await J('GET','/api/version?f=geams-server.js')).s===404&&(await J('GET','/api/version?f=..%2fgeams-server.js')).s===404);
 ok('no update banner when up to date',!(await P.$('#geams-update')));
 await P.evaluate(()=>{setTimeout(()=>{throw new Error('Test crash ABC')},10)});await sleep(1200);
 await P.evaluate(()=>{Promise.reject(new Error('Test rejection XYZ'))});await sleep(1200);
 const L=await J('GET','/api/clientlog',hq);
 ok('HQ sees both errors with app and version',L.s===200&&L.j.groups.some(g=>/Test crash ABC/.test(g.msg)&&g.app==='geams-civilian-app.html'&&g.builds[0]===b1)&&L.j.groups.some(g=>/Test rejection XYZ/.test(g.msg)),L.j);
 await P.evaluate(()=>{for(let i=0;i<20;i++)setTimeout(()=>{throw new Error('Flood '+i)},5*i)});await sleep(1500);
 const L2=await J('GET','/api/clientlog',hq);ok('one page cannot flood the log (max 5 per page load)',L2.j.total<=8,L2.j.total);
 ok('anonymous cannot read the log',(await J('GET','/api/clientlog')).s===403);
 ok('log key is private',(await J('GET','/api/kv/'+encodeURIComponent('registry:clientErrors'),hq)).s===403);
 ok('empty report refused',(await J('POST','/api/clientlog',null,{msg:''})).s===400);
 // update banner: change the file on disk and let the page check again
 fs.appendFileSync('geams-civilian-app.html','\n<!-- build bump for test -->\n');
 await P.evaluate(()=>GeamsDiag.checkVersion());await sleep(1500);
 ok('banner appears when the app file changes on the server',!!(await P.$('#geams-update')),'');
 ok('banner has Update now',/Update now/.test(await P.evaluate(()=>document.getElementById('geams-update').innerText)));
 fs.copyFileSync(R+'/copy.html','geams-civilian-app.html');
 // every app gets it
 for(const f of ['geams-civilian-app.html','geams-dispatch-app.html','geams-fire-service.html','geams-ambulance-service.html','geams-station-dashboard__1_.html','geams-hq-dashboard__1_.html']){const t=await (await fetch(B+'/'+f)).text();ok(f+' served with diagnostics',/window\.GEAMS_BUILD="[0-9a-f]{8}"/.test(t)&&/geams-diag\.js/.test(t));}
 const Q=await (await br.newContext()).newPage();await Q.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());await Q.goto(B+'/geams-hq-dashboard__1_.html');await sleep(2500);await Q.fill('#hq-user','hqadmin');await Q.fill('#hq-pass','Test-Owner-Pass-1');await Q.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);
 await Q.evaluate(()=>{HqOps.appErrors()});await sleep(1800);const m=await Q.evaluate(()=>(document.querySelector('.modal-body')||document.getElementById('modal-body')||document.body).innerText);
 ok('HQ screen lists the errors',/Test crash ABC/.test(m),m.slice(0,200));
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);})().catch(e=>{fs.copyFileSync('/tmp/gdiag/copy.html','geams-civilian-app.html');console.log('ERR',e.stack);process.exit(2)});
