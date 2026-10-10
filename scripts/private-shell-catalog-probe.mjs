// SPDX-License-Identifier: MPL-2.0
/** Inert until the reviewed owning-process bootstrap is explicitly called. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { get } from 'node:https';
const need = v => { if (!v) throw Error('REFUSED'); };
const hash = b => createHash('sha256').update(b).digest('hex');
const stable = v => Array.isArray(v) ? '['+v.map(stable).join(',')+']' : v && typeof v==='object'
  ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}' : JSON.stringify(v);
export function verifyCatalog({index,envelope,expectedIndex,expectedFiles,publicJwk,notBefore,now}) {
  need(Buffer.isBuffer(index)&&Buffer.isBuffer(envelope)&&index.length>0&&index.length<=2*1024**2&&envelope.length>0&&envelope.length<=2*1024**2);
  need(index.equals(expectedIndex)); const e=JSON.parse(envelope), unsigned={...e}; delete unsigned.signature;
  need(Object.keys(e).sort().join(',')==='alg,files,indexHash,keyId,signature,signedAt');
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
export function fetchBytes(url,cookie,maximum,baseURL) {
  const base=new URL(baseURL),u=new URL(url); need(base.protocol==='https:'&&base.pathname==='/'&&!base.search&&!base.hash&&!base.username&&!base.password
    &&Number.isSafeInteger(maximum)&&maximum>0&&maximum<=2*1024**2&&u.origin===base.origin&&u.protocol==='https:'&&['/catalog/tools/index.json','/catalog/tools/index.sig.json'].includes(u.pathname)
    &&!u.search&&!u.hash&&!u.username&&!u.password&&typeof cookie==='string'&&cookie.startsWith('lw_session=')&&!/[\r\n]/.test(cookie));
  return new Promise((resolve,reject)=>{
    const request=get(u,{headers:{Cookie:cookie,'Accept':'application/json'},rejectUnauthorized:true,servername:u.hostname},response=>{
      const pieces=[];let bytes=0;
      if(response.statusCode!==200||response.socket.authorized!==true){response.resume();reject(Error('REFUSED'));return;}
      response.on('data',piece=>{bytes+=piece.length;if(bytes>maximum){request.destroy(Error('REFUSED'));return;}pieces.push(piece);});
      response.on('error',()=>reject(Error('REFUSED')));response.on('end',()=>resolve(Buffer.concat(pieces)));
    });request.setTimeout(30_000,()=>request.destroy(Error('REFUSED')));request.on('error',()=>reject(Error('REFUSED')));
  });
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
  let session,index,envelope,expectedIndex;const timer=setTimeout(()=>{console.log(JSON.stringify({status:'REFUSED',rawErrorsSuppressed:true}));process.exit(1);},300_000);
  try {
    need(process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');session=await borrow();
    const {servedToolIndexBytes,packToolFileDigests}=await import('file:///app/server/src/catalog/signing.ts');
    const {readFile}=await import('node:fs/promises');
    const served=await servedToolIndexBytes(input.packPath,{overlays:session.overlays,groups:session.user.groups});need(served&&served.json===true);
    expectedIndex=served.bytes;const disk=JSON.parse(await readFile(input.shellPath+'/catalog/tools/index.sig.json','utf8'));
    const allFiles=await packToolFileDigests(input.packPath);need(stable(allFiles)===stable(disk.files));
    const expectedFiles=Object.fromEntries(Object.entries(disk.files).filter(([path])=>served.visible(path.slice(0,path.indexOf('/')))));
    index=await fetchBytes(new URL('catalog/tools/index.json',input.baseURL),session.cookie,2*1024**2,input.baseURL);
    envelope=await fetchBytes(new URL('catalog/tools/index.sig.json',input.baseURL),session.cookie,2*1024**2,input.baseURL);
    const proof=verifyCatalog({index,envelope,expectedIndex,expectedFiles,publicJwk:input.publicJwk,notBefore:input.notBefore,now:Date.now()});
    console.log(JSON.stringify({version:1,status:'AUTHENTICATED_NORMAL_TLS_PER_CALLER_CATALOG_VERIFIED',...proof,
      cookiePrinted:false,cookiePersisted:false,cookieTtlSeconds:300,databaseDirectWrites:false,redirectsFollowed:false,
      certificateRequired:true,hostnameVerified:true,sessionOrigin:'MAINTAINED_OWNING_NODE_OWNER_AND_MIGRATION_LOOKUP',
      envelopeByteEqualityToPreparedClaimed:false,sourceBindingSha256:input.sourceBindingSha256}));
  } finally {
    if(session){session.cookie='';session.user=null;session.overlays=null;session=null;}
    for(const value of [index,envelope,expectedIndex])if(Buffer.isBuffer(value))value.fill(0);clearTimeout(timer);
  }
}
