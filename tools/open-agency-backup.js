// Opens an encrypted Fire or Ambulance HQ backup:  node tools/open-agency-backup.js file.enc [out.json]
const fs=require('fs'),crypto=require('crypto'),rl=require('readline');
const f=process.argv[2],out=process.argv[3]||f.replace(/\.enc$/,'')+'.json';if(!f){console.log('Usage: node tools/open-agency-backup.js file.enc [out.json]');process.exit(1)}
const buf=fs.readFileSync(f);if(buf.slice(0,8).toString()!=='GEAMSAG1'){console.log('This is not a GEAMS agency backup.');process.exit(1)}
const i=rl.createInterface({input:process.stdin,output:process.stdout});
i.question('Passphrase: ',p=>{i.close();try{const d=crypto.createDecipheriv('aes-256-gcm',crypto.scryptSync(p,buf.slice(8,24),32),buf.slice(24,36));d.setAuthTag(buf.slice(36,52));
 fs.writeFileSync(out,Buffer.concat([d.update(buf.slice(52)),d.final()]));console.log('Opened. Written to '+out+' (it contains crew phone numbers: store it carefully).')}catch(e){console.log('Wrong passphrase, or the file was changed.');process.exit(1)}});
