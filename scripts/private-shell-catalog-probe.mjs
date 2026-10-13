// SPDX-License-Identifier: MPL-2.0
/** Inert until the reviewed owning-process bootstrap is explicitly called. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { get } from 'node:https';
const need = v => { if (!v) throw Error('REFUSED'); };
const hash = b => createHash('sha256').update(b).digest('hex');
const stable = v => Array.isArray(v) ? '['+v.map(stable).join(',')+']' : v && typeof v==='object'
  ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}' : JSON.stringify(v);
export function verifyCatalog({index,envelope,expectedIndex,expectedFiles,publicJwk,notBefore,now,expectedBinding={kind:'legacy'}}) {
  need(Buffer.isBuffer(index)&&Buffer.isBuffer(envelope)&&index.length>0&&index.length<=2*1024**2&&envelope.length>0&&envelope.length<=2*1024**2);
  need(index.equals(expectedIndex)); const e=JSON.parse(envelope), unsigned={...e}; delete unsigned.signature;
  verifyBinding(e,expectedBinding);
  const pinHash=hash(Buffer.from(stable(publicJwk)));
  need(e.alg==='ECDSA-P256-SHA256'&&e.keyId===Buffer.from(pinHash,'hex').toString('base64url')&&e.indexHash===hash(index));
  need(stable(e.files)===stable(expectedFiles)&&Object.keys(expectedFiles).length>0);
  const signedAt=Date.parse(e.signedAt), earliest=Date.parse(notBefore);
  need(Number.isFinite(signedAt)&&Number.isFinite(earliest)&&Number.isSafeInteger(now)&&earliest<=now
    &&signedAt>=earliest-60_000&&signedAt<=now+60_000);
  need(verify('sha256',Buffer.from(stable(unsigned)),{key:createPublicKey({key:publicJwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(e.signature,'base64url')));
  return {indexSha256:hash(index),envelopeSha256:hash(envelope),indexBytes:index.length,envelopeBytes:envelope.length,
    expectedIndexSha256:hash(expectedIndex),expectedFileMapSha256:hash(Buffer.from(stable(expectedFiles))),signedFiles:Object.keys(expectedFiles).length,
    publicPinSha256:pinHash,keyId:e.keyId,signedAt:e.signedAt,signatureVerified:true,exactPerCallerIndexBytes:true,exactVisibleFileMap:true};
}
export function verifyBinding(e,binding) {
  need(binding && ['legacy','build','runtime'].includes(binding.kind));
  const keys=['alg','files','indexHash','keyId','signature','signedAt'];
  if(binding.kind!=='legacy'){
    keys.push('seq','toolDirs');
    need(Number.isSafeInteger(e.seq)&&e.seq>0&&Number.isSafeInteger(binding.seq)&&e.seq===binding.seq
      &&Number.isSafeInteger(binding.minimumSequence)&&e.seq>=binding.minimumSequence);
    if(binding.kind==='runtime'){
      keys.push('catalogScope');need(typeof e.catalogScope==='string'&&/^[0-9a-f]{64}$/.test(e.catalogScope)&&e.catalogScope===binding.catalogScope);
    }
    for(const field of ['assetIndexHash','slimHash'])if(binding[field]!==undefined){
      keys.push(field);need(typeof e[field]==='string'&&/^[0-9a-f]{64}$/.test(e[field])&&e[field]===binding[field]);
    }
    need(e.toolDirs&&typeof e.toolDirs==='object'&&!Array.isArray(e.toolDirs)&&stable(e.toolDirs)===stable(binding.toolDirs));
    for(const [id,digest]of Object.entries(e.toolDirs))need(/^[a-z0-9-]+$/i.test(id)&&typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest));
  }
  need(Object.keys(e).sort().join(',')===keys.sort().join(','));
}
/** Bound streaming bytes even when Content-Length is absent or false. */
export function collectBytes(response,request,maximum) {
  need(Number.isSafeInteger(maximum)&&maximum>0&&maximum<=16*1024**2);
  return new Promise((resolve,reject)=>{
    const pieces=[];let bytes=0,refused=false;
    response.on('data',piece=>{if(refused)return;bytes+=piece.length;
      if(bytes>maximum){refused=true;reject(Error('REFUSED'));request.destroy(Error('REFUSED'));return;}pieces.push(piece);});
    response.on('error',()=>reject(Error('REFUSED')));
    response.on('end',()=>{if(!refused)resolve(Buffer.concat(pieces));});
  });
}
export function fetchBytes(url,cookie,maximum,baseURL) {
  const base=new URL(baseURL),u=new URL(url); need(base.protocol==='https:'&&base.pathname==='/'&&!base.search&&!base.hash&&!base.username&&!base.password
    &&Number.isSafeInteger(maximum)&&maximum>0&&maximum<=(u.pathname==='/catalog/assets/index.json'?16:2)*1024**2&&u.origin===base.origin&&u.protocol==='https:'&&['/catalog/tools/index.json','/catalog/tools/index.sig.json','/catalog/tools/index.slim.json','/catalog/assets/index.json'].includes(u.pathname)
    &&!u.search&&!u.hash&&!u.username&&!u.password&&typeof cookie==='string'&&cookie.startsWith('lw_session=')&&!/[\r\n]/.test(cookie));
  return new Promise((resolve,reject)=>{
    const request=get(u,{headers:{Cookie:cookie,'Accept':'application/json'},rejectUnauthorized:true,servername:u.hostname},response=>{
      if(response.statusCode!==200||response.socket.authorized!==true){response.resume();reject(Error('REFUSED'));return;}
      collectBytes(response,request,maximum).then(resolve,reject);
    });request.setTimeout(30_000,()=>request.destroy(Error('REFUSED')));request.on('error',()=>reject(Error('REFUSED')));
  });
}
export function publicationSequence(row,input,expected) {
  need(row&&Object.keys(row).sort().join(',')==='publication_digest,publication_generation,seq');
  const numeric=v=>typeof v==='number'?Number.isSafeInteger(v):typeof v==='string'&&/^[0-9]+$/.test(v);
  need(numeric(row.seq)&&numeric(row.publication_generation)&&Number.isSafeInteger(input.generation)&&input.generation>0);
  const seq=Number(row.seq);
  need(Number.isSafeInteger(seq)&&seq>0&&Number(row.publication_generation)===input.generation
    &&typeof row.publication_digest==='string'&&/^[0-9a-f]{64}$/.test(row.publication_digest)
    &&row.publication_digest===expected.digest&&expected.generation===input.generation);
  return seq;
}
/** The singleton is read after delivery requests: first publication can create its row normally. */
export async function readPublication(input,expected) {
  const {default:pg}=await import('file:///app/node_modules/pg/lib/index.js');
  const c=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10_000});
  await c.connect();
  try{
    await c.query('begin read only');await c.query("set local statement_timeout = '10s'");
    const r=await c.query('select seq, publication_generation, publication_digest from catalog_delivery_sequence where singleton=true');
    need(r.rows.length===1);const seq=publicationSequence(r.rows[0],input,expected);
    await c.query('commit');return seq;
  }finally{await c.end();}
}
export async function borrow(input) {
  need(process.getuid()===1000&&process.getgid()===1000&&process.env.LW_AUTO_MIGRATE==='false');
  const {readFile,lstat,readlink}=await import('node:fs/promises');
  for(const [path,row] of Object.entries(input.files)) {
    const file='/app/'+path,s=await lstat(file);need(s.size===row.bytes);
    if(row.mode==='symlink')need(s.isSymbolicLink()&&await readlink(file)===row.linkTarget);
    else need(s.isFile()&&!s.isSymbolicLink()&&s.size<=16*1024**2&&hash(await readFile(file))===row.sha256);
  }
  const pinBytes=await readFile(input.pinPath);need(hash(pinBytes)===input.pinSha256&&stable(JSON.parse(pinBytes))===stable(input.pin));
  const {default:pg}=await import('file:///app/node_modules/pg/lib/index.js');
  const {mintSessionCookie}=await import('file:///app/server/src/iam/sessions.ts');
  const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10_000});
  let user,overlays;await client.connect();
  try {
    await client.query('begin read only');await client.query("set local statement_timeout = '10s'");
    const owners=await client.query('select u.id,u.sub,u.email,u.firstname,u.lastname,u.groups,u.role,u.session_epoch,u.disabled_at from users u join projects p on p.owner_id=u.id where p.id=$1',[input.caller.project]);
    need(owners.rows.length===1);user=owners.rows[0];
    need(!user.disabled_at&&typeof user.email==='string'&&input.caller.emails.includes(user.email.toLowerCase()));
    const sessions=await client.query('select id,project_id,tool_id,deleted_at from sessions where id=$1',[input.caller.session]);
    need(sessions.rows.length===1&&sessions.rows[0].project_id===input.caller.project&&sessions.rows[0].tool_id==='design'&&!sessions.rows[0].deleted_at);
    const ledger=await client.query('select name from schema_migrations order by name');
    need(stable(ledger.rows.map(row=>row.name))===stable(input.migrations));
    const rows=await client.query('select tool_id, overlay from tools_policy where state = $1',['published']);
    need(rows.rows.every(row=>typeof row.tool_id==='string')&&new Set(rows.rows.map(row=>row.tool_id)).size===rows.rows.length);
    overlays=new Map(rows.rows.map(row=>[row.tool_id,row.overlay]));await client.query('commit');
  } finally {await client.end();}
  const at=Date.now(),cookie=mintSessionCookie({sub:user.sub,email:user.email,
    name:[user.firstname,user.lastname].filter(Boolean).join(' ')||user.email,groups:user.groups,role:user.role,
    epoch:user.session_epoch,authenticatedAt:at,authAt:at},process.env.LW_SESSION_SECRET,true,300,at).split(';')[0];
  return {cookie,user,overlays};
}
export async function bootstrap({input,borrow}) {
  let session,index,envelope,expectedIndex,assets,slim;const timer=setTimeout(()=>{console.log(JSON.stringify({status:'REFUSED',rawErrorsSuppressed:true}));process.exit(1);},300_000);
  try {
    need(process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');session=await borrow();
    const signing=await import('file:///app/server/src/catalog/signing.ts');
    const {servedToolIndexBytes,packToolFileDigests,completeToolFileDigests,toolDirectoryDigests}=signing;
    const {readFile}=await import('node:fs/promises');
    const served=await servedToolIndexBytes(input.packPath,{overlays:session.overlays,groups:session.user.groups});need(served&&served.json===true);
    expectedIndex=served.bytes;const disk=JSON.parse(await readFile(input.shellPath+'/catalog/tools/index.sig.json','utf8'));
    const allFiles=await (input.publication?completeToolFileDigests:packToolFileDigests)(input.packPath);need(stable(allFiles)===stable(disk.files));
    const expectedFiles=Object.fromEntries(Object.entries(disk.files).filter(([path])=>served.visible(path.slice(0,path.indexOf('/')))));
    index=await fetchBytes(new URL('catalog/tools/index.json',input.baseURL),session.cookie,2*1024**2,input.baseURL);
    envelope=await fetchBytes(new URL('catalog/tools/index.sig.json',input.baseURL),session.cookie,2*1024**2,input.baseURL);
    let expectedBinding={kind:'legacy'};
    if(input.publication){
      const config=await readFile(input.publication.configPath);need(hash(config)===input.publication.configSha256);
      need(JSON.parse(config).instance.catalogPublicationGeneration===input.publication.generation);config.fill(0);
      const {servedToolSidecar}=await import('file:///app/server/src/catalog/tool-sidecars.ts');
      const {catalogVisibilityScope}=await import('file:///app/server/src/catalog/delivery.ts');
      const {catalogPublication}=await import('file:///app/server/src/catalog/publication.ts');
      expectedBinding={kind:'runtime',minimumSequence:1,catalogScope:catalogVisibilityScope({groups:session.user.groups}),toolDirs:toolDirectoryDigests(expectedFiles)};
      if(disk.assetIndexHash!==undefined){assets=await fetchBytes(new URL('catalog/assets/index.json',input.baseURL),session.cookie,16*1024**2,input.baseURL);expectedBinding.assetIndexHash=hash(assets);}
      const slimOracle=await servedToolSidecar(input.packPath,'tools/index.slim.json',{overlays:session.overlays,groups:session.user.groups});
      if(disk.slimHash!==undefined){need(slimOracle.kind==='json');slim=await fetchBytes(new URL('catalog/tools/index.slim.json',input.baseURL),session.cookie,2*1024**2,input.baseURL);need(slim.equals(slimOracle.bytes));expectedBinding.slimHash=hash(slim);}
      else need(slimOracle.kind==='not-found');
      const source=await catalogPublication({pack:input.packPath,generation:input.publication.generation,publicKey:input.publicJwk,signing:null,fileDigests:async()=>allFiles});
      expectedBinding.seq=await readPublication({generation:input.publication.generation},source);
    }
    const proof=verifyCatalog({index,envelope,expectedIndex,expectedFiles,publicJwk:input.publicJwk,notBefore:input.notBefore,now:Date.now(),expectedBinding});
    console.log(JSON.stringify({version:1,status:'AUTHENTICATED_NORMAL_TLS_PER_CALLER_CATALOG_VERIFIED',...proof,
      cookiePrinted:false,cookiePersisted:false,cookieTtlSeconds:300,databaseDirectWrites:false,redirectsFollowed:false,
      certificateRequired:true,hostnameVerified:true,sessionOrigin:'MAINTAINED_OWNING_NODE_OWNER_AND_MIGRATION_LOOKUP',
      envelopeByteEqualityToPreparedClaimed:false,sourceBindingSha256:input.sourceBindingSha256}));
  } finally {
    if(session){session.cookie='';session.user=null;session.overlays=null;session=null;}
    for(const value of [index,envelope,expectedIndex,assets,slim])if(Buffer.isBuffer(value))value.fill(0);clearTimeout(timer);
  }
}
