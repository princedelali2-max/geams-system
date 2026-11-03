const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7';
(async()=>{
 const ROOT='/tmp/gsw2';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8097',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);await sleep(2000);
 const B='http://localhost:8097';const tk=(await (await fetch(B+'/api/hq/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'hqadmin',password:'Test-Owner-Pass-1'})})).json()).token;
 await fetch(B+'/api/kv/'+encodeURIComponent('registry:stations'),{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tk},body:JSON.stringify({value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}})});
 const br=await chromium.launch();
 const mk=async(f,geo)=>{const c=await br.newContext({geolocation:geo,permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer)'/.test(e.message))console.log('PAGEERR',f,e.message)});p.on('dialog',d=>d.accept());await p.goto('http://localhost:8097/'+f);await sleep(900);return p};
 const D=await mk('geams-dispatch-app.html',{latitude:7.152,longitude:0.474});
 await D.evaluate(()=>DispatchApp.showSignupForm());await D.fill('#su-name','Eq Officer');await D.fill('#su-phone','0240000009');await D.selectOption('#su-lcr',H);await D.fill('#su-pass','secret12');await D.fill('#su-pass2','secret12');await D.evaluate(()=>DispatchApp.doSignup());await sleep(4500);
 const L=await mk('geams-station-dashboard__1_.html',{latitude:7.1516,longitude:0.4737});
 await L.fill('#login-station-id',H);await L.fill('#login-passphrase','hohoe2024');await L.fill('#login-cmd-name','Kwame Mensah');await L.evaluate(()=>StationAuth.attemptLogin());await sleep(6000);
 await L.evaluate(()=>StationApp.navigate('officers'));await sleep(2500);await L.evaluate(()=>{const b=[...document.querySelectorAll('#crew-approvals button')].find(b=>/Approve/.test(b.textContent));if(b)b.click()});await sleep(2500);
 const C=await mk('geams-civilian-app.html',{latitude:7.158,longitude:0.480});
 const incId=await C.evaluate(()=>{CivilianData.user.id='CIV1';CivilianData.user.name='Test Civ';CivilianData.user.phone='0200000000';CivilianData.user.address='Hohoe';CivilianData.user.gpsLat=7.158;CivilianData.user.gpsLng=0.480;CivilianData.startEmergency('Crime');const em=CivilianData.activeEmergency();startEmergencySync(em,'');return em.id;});
 await sleep(4000);
 ok('station received the civilian alert',await L.evaluate(id=>!!StationData.incidents.find(i=>i.id===id),incId));
 // photo request
 await L.evaluate(id=>StationApp.requestScenePhoto(id),incId);await L.evaluate(()=>{document.getElementById('ph-msg').value='Photo of the car please'});await L.evaluate(()=>StationApp.confirmScenePhoto());await sleep(4500);
 const sheet=await C.evaluate(()=>document.body.innerText);
 ok('civilian app shows the photo request',/control room asks for a photo/i.test(sheet)&&/Photo of the car please/.test(sheet),sheet.slice(0,200));
 const [fc]=await Promise.all([C.waitForEvent('filechooser'),C.evaluate(()=>document.getElementById('pr-box').click())]);
 await fc.setFiles({name:'scene.jpg',mimeType:'image/jpeg',buffer:Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==','base64')});await sleep(500);
 await C.evaluate(id=>CivilianApp.sendRequestedPhoto(id),incId);await sleep(4000);
 let man=await L.evaluate(id=>GeamsSync.getShared('archive:'+id+':media',[]),incId);
 ok('photo arrived as evidence from the civilian',man.some(x=>x.who==='civ'&&/image/.test(x.type||x.mime||'')||x.name==='scene.jpg'),JSON.stringify(man).slice(0,300));
 await sleep(3500);ok('request is not shown twice',await C.evaluate(()=>document.getElementById('sheet-overlay').classList.contains('hidden')));
 // video
 const [fc2]=await Promise.all([C.waitForEvent('filechooser'),C.evaluate(()=>CivilianApp.sendVideo())]);
 await fc2.setFiles({name:'clip.mp4',mimeType:'video/mp4',buffer:Buffer.alloc(20000,1)});await sleep(4000);
 man=await L.evaluate(id=>GeamsSync.getShared('archive:'+id+':media',[]),incId);
 ok('civilian video arrived as evidence',man.some(x=>/video/.test(x.type||x.mime||'')||x.name==='clip.mp4'),JSON.stringify(man).slice(0,300));
 // equipment from officer
 await D.evaluate(()=>{document.getElementById('login-name').value='Eq Officer';document.getElementById('login-pass').value='secret12';DispatchApp.doLogin()});await sleep(7000);
 const duty=await L.evaluate(()=>GeamsSync.getShared('lcr:GH-VR-HOH-001-P3Q7:officers',{}).then(o=>Object.values(o).map(x=>x.name+':'+x.status)));
 ok('officer on the roster',duty.length>=1,JSON.stringify(duty));
 await D.evaluate(()=>DispatchApp.reportEquipment());await sleep(300);
 await D.evaluate(()=>{const it=[...document.querySelectorAll('.check-item')];ok_=it.length;});
 await D.evaluate(()=>{document.getElementById('eq-issues').value='Radio battery low';const it=document.querySelectorAll('.check-item');if(it[0])it[0].click();});
 await D.evaluate(()=>DispatchApp.sendEquipmentReport());await sleep(5000);
 const rost=await L.evaluate(()=>GeamsSync.getShared('lcr:GH-VR-HOH-001-P3Q7:officers',{}).then(o=>Object.values(o)[0].equipment));
 ok('equipment report in the roster record',rost&&rost.issues==='Radio battery low'&&rost.items.length>=4,JSON.stringify(rost));
 await L.evaluate(()=>StationApp.navigate('dispatch'));await sleep(1500);
 const flag=await L.evaluate(()=>StationData.officers.find(o=>o.equipment)&&document.body.innerHTML.includes('EQUIPMENT'));
 ok('station shows the equipment warning on that officer',await L.evaluate(()=>{StationDispatch.render&&StationDispatch.render();return document.documentElement.innerHTML.includes('⚠ EQUIPMENT')}),String(flag));
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.message);process.exit(2)});