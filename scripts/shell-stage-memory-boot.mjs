// SPDX-License-Identifier: MPL-2.0
// Source-only preparation. Root executes in the exact isolated stager after native/signature checks.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import path from 'node:path';
const need=(c,m)=>{if(!c)throw Error(m)};const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const parts=[];let n=0;for await(const b of process.stdin){n+=b.length;need(n<64*1024,'bounded boot input');parts.push(b)}const x=JSON.parse(Buffer.concat(parts));
need(process.getuid()>0&&process.getgid()>0&&Number(process.versions.node.split('.')[0])>=24,'isolated runtime identity');
need(['DATABASE_URL','DATABASE_URL_UNPOOLED','LW_DATABASE_URL','LW_SESSION_SECRET','LW_LINK_SECRET','LW_RENDER_WORKER_SECRET','LW_CATALOG_SIGNING_KEY','LW_CONFIG','LW_SEED_CONFIG','LW_ALLOW_STALE_SHELL','NODE_OPTIONS'].every(k=>!process.env[k]),'production environment/bypass refused');
need(hash(fs.readFileSync('/app/engine-pin.json'))===x.pinSha256,'new image pin');need(fs.readFileSync('/stage/engine-pin.json').equals(fs.readFileSync('/app/engine-pin.json')),'actual mounted pin must equal qualified baked pin');
need(/^[0-9a-f]{64}$/.test(x.indexSha256),'expected reviewed index required');
need(x.publicKey?.kty==='EC'&&x.publicKey.crv==='P-256'&&!Object.hasOwn(x.publicKey,'d'),'public-only existing P256 pin');
const cfg={deployment:{mode:'evaluation',application:'web',requireServerRendering:false},instance:{name:'Isolated private cohort smoke',baseUrl:'http://127.0.0.1:18987',pack:'/stage/pack',shellDir:'/stage/shell',catalogPublicKey:x.publicKey},idp:{issuer:'',clientId:'',additional:[{id:'isolated-password',kind:'password',issuer:'',clientId:'',displayName:'Isolated password (no accounts)'}],bootstrapOwners:[]},policy:{defaultAccessMode:'gated',telemetry:'off',ai:{enabled:false,capabilities:[]},nearby:{enabled:false},guestLinks:{enabled:false,maxTtlHours:1,defaultTtlHours:1},requests:{join:false,project:false,ttlDays:1,joinOpenMax:1},retention:{telemetryDays:0,auditDays:0}},render:{allowHooksInFastPath:false,worker:{url:'',timeoutMs:20000},c2pa:{certFile:'',claimGenerator:''}},dev:{enabled:false,users:[]},proxyAuth:{enabled:false},catalogProviders:[],delivery:{maxBytes:67108864,destinations:[]},blobs:{driver:'pg'},notify:{people:{email:false}},siem:{batchSize:200,intervalSeconds:30},audit:{headLog:{onBoot:false,intervalMinutes:0}}};
// Parse through the exact maintained parser before any process/file writes; no alternate policy parser.
const {parseConfig}=await import('/app/server/src/config/instance.ts');const parsed=parseConfig(JSON.stringify(cfg));
need(JSON.stringify(parsed.instance.catalogPublicKey)===JSON.stringify(x.publicKey),'parsed existing catalog public key required');
need(parsed.deployment.mode==='evaluation'&&parsed.policy.defaultAccessMode==='gated'&&!parsed.dev.enabled&&!parsed.idp.issuer&&parsed.idp.additional.length===1&&parsed.idp.additional[0].kind==='password'&&parsed.idp.additional[0].id==='isolated-password'&&!parsed.idp.additional[0].issuer&&!parsed.idp.additional[0].clientId&&!parsed.idp.bootstrapOwners.length&&!parsed.proxyAuth.enabled&&!parsed.catalogProviders.length&&!parsed.render.worker.url&&!parsed.render.allowHooksInFastPath&&!parsed.delivery.destinations.length&&!parsed.notify.smtp&&!parsed.notify.webhook&&!parsed.siem.url&&!parsed.instance.appUrl&&!parsed.policy.ai.enabled,'strict isolated startup config');
let child=null,exit=null,stdout='',stderr='',overflow=false,spawnError=false,graceful=false,result=null,failure=null;const readinessHistory=[];const started=Date.now();const startupDeadline=started+90000;const dir=fs.mkdtempSync('/tmp/lolly-isolated-cohort-boot-');const conf=path.join(dir,'instance.json');
try{
 fs.writeFileSync(conf,JSON.stringify(cfg)+'\n',{flag:'wx',mode:0o600});
 const env={PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',NODE_ENV:'production',HOME:dir,TMPDIR:dir,PORT:'18987',LW_CONFIG:conf,LW_AUTO_MIGRATE:'false',LW_BACKGROUND_POLL_MS:'0',LW_SESSION_SECRET:crypto.randomBytes(48).toString('hex'),LW_LINK_SECRET:crypto.randomBytes(48).toString('hex')};
 need(Object.keys(env).length===10&&!env.DATABASE_URL&&!env.LW_RENDER_WORKER_SECRET&&!env.LW_CATALOG_SIGNING_KEY&&!env.LW_ALLOW_STALE_SHELL&&!env.NODE_OPTIONS,'no inherited credentials or bypasses');
 child=spawn(process.execPath,['server/src/main.ts'],{cwd:'/app',env,stdio:['ignore','pipe','pipe']});exit=new Promise(resolve=>{child.once('error',()=>{spawnError=true;resolve({error:true})});child.once('exit',(code,signal)=>resolve({code,signal}))});
 const logChunk=(previous,b)=>{const all=Buffer.concat([Buffer.from(previous),Buffer.from(b)]);if(all.length>512*1024){overflow=true;child.kill('SIGKILL')}return all.subarray(0,512*1024).toString('utf8')};
 child.stdout.on('data',b=>{stdout=logChunk(stdout,b)});child.stderr.on('data',b=>{stderr=logChunk(stderr,b)});
 const deadline=Math.min(startupDeadline,Date.now()+30000);let health=null;
 while(Date.now()<deadline){need(!spawnError&&!overflow&&child.exitCode===null&&child.signalCode===null,'boot child exited before readiness');try{const r=await fetch('http://127.0.0.1:18987/healthz',{redirect:'error',signal:AbortSignal.timeout(1000)});if(r.status===200){const b=await r.text();need(b.length<8192,'health body bound');health=JSON.parse(b);break}}catch{}await new Promise(r=>setTimeout(r,100))}
 need(health?.ok===true&&health.name===cfg.instance.name&&health.accessMode==='gated','bounded actual health proof');
 let rv=null;
 while(Date.now()<startupDeadline){
  need(!spawnError&&!overflow&&child.exitCode===null&&child.signalCode===null,'boot child exited before catalog readiness');
  need(readinessHistory.length<96,'bounded readiness history');
  let ready;
  try{ready=await fetch('http://127.0.0.1:18987/readyz',{redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(3000,startupDeadline-Date.now())))})}
  catch(error){readinessHistory.push({elapsedMs:Date.now()-started,error:String(error?.message??error).slice(0,512)});await new Promise(r=>setTimeout(r,1000));continue}
  const readyBody=await ready.text();need(Buffer.byteLength(readyBody)<8192,'ready body bound');
  readinessHistory.push({elapsedMs:Date.now()-started,status:ready.status,body:readyBody});
  if(ready.status===200){rv=JSON.parse(readyBody);break}
  need(ready.status===503,'unexpected local readiness status');await new Promise(r=>setTimeout(r,1000));
 }
 need(rv?.ok===true&&rv.store==='memory','bounded memory-only catalog readiness proof');
 const root=await fetch('http://127.0.0.1:18987/',{redirect:'error',signal:AbortSignal.timeout(3000)});need(root.status===200&&root.headers.get('content-type')?.includes('text/html'),'real shell root');const rootBytes=Buffer.from(await root.arrayBuffer());need(rootBytes.length<2*1024*1024&&hash(rootBytes)===x.indexSha256,'actual mounted governed shell index');
 need(stdout.includes('deployment mode=evaluation; storage=memory'),'actual memory mode log');
 result={status:'ISOLATED_EPHEMERAL_MEMORY_WORK_STARTUP_SMOKE',healthStatus:200,readyStatus:200,rootStatus:200,indexSha256:hash(rootBytes),storage:'memory',deploymentMode:'evaluation',governedAccessMode:'gated',devLogin:false,externalIdentityConfigured:false,localPasswordChooserEnabled:true,usersOrCredentialsSeeded:false,registrationOrInvitationRequests:false,authOrSessionRequests:false,providers:false,workerConfigured:false,networkIntegrationConfigured:false,productionConfigRead:false,productionEnvironmentInherited:false,databaseAccessed:false,productionSecretsAccessed:false,migrationsQualified:false,productionModeQualified:false,catalogSignatureBypass:false,publicP256PinSupplied:true,requests:['GET /healthz','GET /readyz','GET /'],documentWrites:false};
}catch(error){failure=error}finally{
 if(child){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timer;const ended=await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000)})]);if(timer)clearTimeout(timer);if(!ended){child.kill('SIGKILL');await exit}else graceful=ended.code===0&&stdout.includes('[lolly-work] drained');}
 fs.rmSync(conf,{force:true});fs.rmdirSync(dir);
}
const diagnostics={readinessHistory,elapsedMs:Date.now()-started,gracefulShutdown:graceful,overflow,spawnError,originalStdout:stdout,originalStderr:stderr,originalStdoutSha256:hash(Buffer.from(stdout)),originalStderrSha256:hash(Buffer.from(stderr)),ephemeralKeysDiscarded:true};
if(failure||!result||!graceful||overflow||spawnError){console.error(JSON.stringify({status:'ISOLATED_MEMORY_BOOT_REFUSED',failure:failure?{name:failure.name,message:String(failure.message).slice(0,2048)}:{name:'Error',message:'child must gracefully drain and exit0 before accepting smoke'},...diagnostics}));throw failure??Error('child must gracefully drain and exit0 before accepting smoke')}
console.log(JSON.stringify({...result,readinessHistory,elapsedMs:Date.now()-started,gracefulShutdown:true,childExitCode:0,originalStdout:stdout,originalStderr:stderr,originalStdoutSha256:hash(Buffer.from(stdout)),originalStderrSha256:hash(Buffer.from(stderr)),ephemeralKeysDiscarded:true}));
