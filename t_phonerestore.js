const { chromium } = require('playwright');const fs=require('fs'),http=require('http'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8066',K='/api/kv/'+encodeURIComponent('lcr:'+H+':incidents');
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
const sms=[];const gw=http.createServer((q,r)=>{let d='';q.on('data',c=>d+=c);q.on('end',()=>{try{sms.push(JSON.parse(d))}catch(e){}r.end('ok')})}).listen(8065);
const lastCode=()=>{const m=sms.length&&/(\d{6})/.exec(sms[sms.length-1].message);return m?m[1]:null};
(async()=>{
 const R='/tmp/gphone';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const env={...process.env,PORT:'8066',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_SMS_URL:'http://localhost:8065/sms'};
 const srv=spawn('node',['geams-server.js'],{env});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe',region:'V',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const oldDev='oldphone'+'x'.repeat(20),A=(await J('POST','/api/civilian/session',null,{secret:oldDev})).j.token;
 await J('PUT','/api/civilian/profile',A,{id:'CIV-31001',profile:{id:'CIV-31001',name:'Kofi Lost',phone:'0245222222',ghCard:'GHA-444444444-4',address:'Ho',registeredDate:'2026-11-01'}});
 await J('PUT',K,A,{value:{R1:{id:'R1',type:'medical',priority:'high',status:'new',location:'x',lat:7.15,lng:0.47,civilianId:'CIV-31001',civilianName:'Kofi Lost',civilianPhone:'0245222222',createdAt:new Date().toISOString(),source:'civilian-app'}}});
 const newDev='newphone'+'y'.repeat(20);
 let r=await J('POST','/api/civilian/otp/request',null,{phone:'0245222222'});ok('code is texted to the registered number',r.s===200&&sms.length===1&&/\+?233245222222|0245222222/.test(JSON.stringify(sms[0])),[r.s,sms]);
 const unverified=(await J('POST','/api/civilian/session',null,{secret:newDev})).j.token;
 r=await J('POST','/api/civilian/recovery/restore',unverified,{viaPhone:true});ok('without verifying the phone, restore is refused',r.s>=400,r);
 r=await J('POST','/api/civilian/otp/verify',null,{phone:'0245222222',code:'000000',secret:newDev});ok('wrong SMS code refused',r.s===401,r);
 r=await J('POST','/api/civilian/otp/verify',null,{phone:'0245222222',code:lastCode(),secret:newDev});ok('right code gives a verified session',r.s===200&&r.j.verified,r);const vt=r.j.token;
 r=await J('POST','/api/civilian/recovery/restore',vt,{viaPhone:true});ok('phone restore works with no account number',r.s===200&&r.j.profile.id==='CIV-31001'&&r.j.alertsMoved===1&&/^[A-Z0-9]{5}-/.test(r.j.newCode),r);
 ok('old phone lost access to the alert',!(await J('GET',K,A)).j.value||!(await J('GET',K,A)).j.value.R1);
 ok('new phone sees it',!!((await J('GET',K,vt)).j.value||{}).R1);
 // another phone verified for a number nobody registered
 await J('POST','/api/civilian/otp/request',null,{phone:'0201112222'});const v2=(await J('POST','/api/civilian/otp/verify',null,{phone:'0201112222',code:lastCode(),secret:'zzz'+'q'.repeat(20)})).j.token;
 r=await J('POST','/api/civilian/recovery/restore',v2,{viaPhone:true});ok('number with no account: clear message, nothing restored',r.s===404&&/No GEAMS account/.test(r.j.error),r);
 // two accounts, one number: must give the account number
 await J('PUT','/api/civilian/profile',A,{id:'CIV-31002',profile:{id:'CIV-31002',name:'Twin',phone:'0245333333',ghCard:'GHA-555555555-5',address:'Ho',registeredDate:'2026-11-01'}});
 const A2=(await J('POST','/api/civilian/session',null,{secret:'second'+'x'.repeat(20)})).j.token;await J('PUT','/api/civilian/profile',A2,{id:'CIV-31003',profile:{id:'CIV-31003',name:'Twin2',phone:'0245333333',ghCard:'GHA-666666666-6',address:'Ho',registeredDate:'2026-11-01'}});
 await J('POST','/api/civilian/otp/request',null,{phone:'0245333333'});const v3=(await J('POST','/api/civilian/otp/verify',null,{phone:'0245333333',code:lastCode(),secret:'third'+'x'.repeat(20)})).j.token;
 r=await J('POST','/api/civilian/recovery/restore',v3,{viaPhone:true});ok('shared number: asks for the account number',r.s===409,r);
 r=await J('POST','/api/civilian/recovery/restore',v3,{viaPhone:true,civilianId:'CIV-31002'});ok('with the account number it works',r.s===200,r);
 // verified phone of someone else cannot restore a different person's account
 r=await J('POST','/api/civilian/recovery/restore',v2,{viaPhone:true,civilianId:'CIV-31001'});ok('a verified stranger cannot restore another person\'s account',r.s===401,r);
 // UI
 const br=await chromium.launch();
 const mk=async()=>{const c=await br.newContext({acceptDownloads:true,geolocation:{latitude:7.1516,longitude:0.4737},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',e.message)});p.on('dialog',d=>d.accept());return p};

 const C=await mk();await C.goto(B+'/geams-civilian-app.html');await sleep(2500);
 await C.evaluate(()=>{localStorage.clear()});await C.reload();await sleep(4500);
 await C.evaluate(()=>{document.getElementById('pin-gate').classList.remove('hidden','fading');PinGate.showRestore()});
 await C.evaluate(()=>PinGate.phoneRestoreToggle());
 ok('phone option is offered on the restore screen',await C.evaluate(()=>!document.getElementById('rs-phone-box').classList.contains('hidden')));
 await C.fill('#rs-phone','0245333333');sms.length=0;await C.evaluate(()=>{PinGate.phoneRestoreSend()});await sleep(1500);
 ok('UI asks the server to text a code',sms.length===1);
 ok('code box appears',await C.evaluate(()=>!document.getElementById('rs-code-row').classList.contains('hidden')));
 await C.fill('#rs-pin','4321');await C.fill('#rs-pin2','4321');await C.fill('#rs-id','CIV-31002');await C.fill('#rs-sms',lastCode());
 await C.evaluate(()=>{PinGate.phoneRestoreFinish()});await sleep(4000);
 ok('UI restored the account on this phone',await C.evaluate(()=>CivilianData.user.id==='CIV-31002'&&CivilianData.user.name==='Twin'),await C.evaluate(()=>JSON.stringify(CivilianData.user).slice(0,120)));
 ok('and shows the new recovery code',/Recovery|recovery/.test(await C.evaluate(()=>document.body.innerText)));
 // SMS not configured
 srv.kill();await sleep(800);const e2={...env,PORT:'8066'};delete e2.GEAMS_SMS_URL;const s2=spawn('node',['geams-server.js'],{env:e2});await sleep(2500);
 const C2=await mk();await C2.goto(B+'/geams-civilian-app.html');await sleep(2500);await C2.evaluate(()=>{localStorage.clear()});await C2.reload();await sleep(4500);
 await C2.evaluate(()=>{document.getElementById('pin-gate').classList.remove('hidden','fading');PinGate.showRestore();PinGate.phoneRestoreToggle()});await C2.fill('#rs-phone','0245333333');await C2.evaluate(()=>{PinGate.phoneRestoreSend()});await sleep(1500);
 ok('when SMS is not set up the screen says so plainly',/SMS is not switched on/.test(await C2.evaluate(()=>document.getElementById('restore-error').textContent)),await C2.evaluate(()=>document.getElementById('restore-error').textContent));
 await br.close();s2.kill();gw.close();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
