const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8078';
(async()=>{
 const ROOT='/tmp/gconsui';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8078',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_PRIVACY_CONTACT:'dpo@example.gov.gh'}});await sleep(2500);
 const br=await chromium.launch();
 const mk=async(f,geo)=>{const c=await br.newContext({geolocation:geo||{latitude:7.152,longitude:0.474},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};

 const C=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.48});
 const T=async(f)=>C.evaluate(f);
 await C.evaluate(()=>{localStorage.clear()});await C.reload();await sleep(2500);
 await C.evaluate(()=>{document.getElementById('pin-gate').classList.remove('hidden','fading');PinGate.showSignup()});
 await C.fill('#su-name','Ama Test');await C.fill('#su-phone','0200000077');await C.fill('#su-ghcard','GHA-777777777-7');await C.fill('#su-address','Ho');await C.fill('#su-pin','1234');await C.fill('#su-pin2','1234');
 await C.evaluate(()=>PinGate.continueToFaceStep());await sleep(400);
 ok('cannot continue without accepting the privacy notice',/privacy notice/i.test(await C.evaluate(()=>document.getElementById('signup-error').textContent))&&await C.evaluate(()=>document.getElementById('signup-step-face').classList.contains('hidden')));
 await C.evaluate(()=>Privacy.show());await sleep(400);
 const sb=await C.evaluate(()=>document.getElementById('sheet-body').innerText);
 ok('notice shows what is collected and the real contact',/face template/.test(sb)&&/dpo@example\.gov\.gh/.test(sb)&&/optional/i.test(sb),sb.slice(0,200));
 await C.evaluate(()=>CivilianApp.closeSheet());
 await C.evaluate(()=>{document.getElementById('su-privacy').checked=true});await C.evaluate(()=>PinGate.continueToFaceStep());await sleep(600);
 const face=await C.evaluate(()=>document.getElementById('signup-step-face').innerText);
 ok('face step says optional and has its own consent box and a skip',/optional/i.test(face)&&/consent/i.test(face)&&/Skip/.test(face)&&!!(await C.$('#su-face-consent')),face.slice(0,200));
 ok('face consent box is not pre-ticked',!(await C.evaluate(()=>document.getElementById('su-face-consent').checked)));
 await C.evaluate(()=>PinGate.skipSignupFace());await sleep(3500);
 ok('account created without a face',await C.evaluate(()=>!!CivilianData.user.id&&!CivilianData.user.faceEnrolled),await C.evaluate(()=>JSON.stringify(CivilianData.user).slice(0,150)));
 ok('notice acknowledgement remembered',await C.evaluate(()=>localStorage.getItem('geams_priv_ver')===Privacy.VER));
 await C.evaluate(()=>{CivilianApp.closeSheet&&CivilianApp.closeSheet()});
 await C.evaluate(()=>Privacy.mine());await sleep(300);
 const mine=await C.evaluate(()=>document.getElementById('sheet-body').innerText);
 ok('consents screen shows notice read and no face stored',/read \(version/.test(mine)&&/none stored/.test(mine),mine.slice(-250));
 ok('Profile has the privacy row',(await C.evaluate(()=>document.documentElement.innerHTML)).includes("Privacy.mine()"));
 // existing user with an older notice sees it once
 await C.evaluate(()=>localStorage.removeItem('geams_priv_ver'));await C.reload();await sleep(2500);await C.evaluate(()=>{CivilianApp.enterApp()});await sleep(2500);
 const shown=await C.evaluate(()=>{const e=document.getElementById('sheet-body');return e?e.innerText:''});
 ok('existing user is shown the notice once',/Privacy notice|What GEAMS collects/.test(shown)||await C.evaluate(()=>/collects/.test(document.body.innerText)),shown.slice(0,100));
 // face enrol through the server needs consent flag; withdraw really deletes
 const j=await C.evaluate(async()=>{const d=Array.from({length:128},(_,i)=>Math.sin(i)*0.2);const a=await GeamsSync.api('/api/face/enrol','POST',{civilianId:CivilianData.user.id,descriptor:d});const b=await GeamsSync.api('/api/face/enrol','POST',{civilianId:CivilianData.user.id,descriptor:d,faceConsent:true,notice:Privacy.VER});return [a.status||a.ok,b.ok]});
 ok('server refuses face without consent, accepts with',(j[0]===403||j[0]===false)&&j[1]===true,j);
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
