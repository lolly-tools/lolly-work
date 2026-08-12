(()=>{function M(e){let t=0;for(let o of e)t+=o.length;let n=new Uint8Array(t),r=0;for(let o of e)n.set(o,r),r+=o.length;return n}var D=e=>e;async function re(e){return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",D(e)))}var b=e=>Array.from(e,t=>t.toString(16).padStart(2,"0")).join("");function we(e){let t=atob(e),n=new Uint8Array(t.length);for(let r=0;r<t.length;r++)n[r]=t.charCodeAt(r);return n}function W(e){let t="";for(let n=0;n<e.length;n+=32768)t+=String.fromCharCode.apply(null,e.subarray(n,n+32768));return t}function Z(e,t){if(t+2>e.length)throw new Error("der: truncated");let n=e[t],r=e[t+1],o=t+2;if(r&128){let a=r&127;if(o+a>e.length)throw new Error("der: length overruns buffer");r=0;for(let i=0;i<a;i++)r=r*256+e[o++]}if(o+r>e.length)throw new Error("der: length overruns buffer");return{tag:n,start:t,contentStart:o,end:o+r}}function U(e,t){let n=[],r=t.contentStart;for(;r<t.end;){let o=Z(e,r);n.push(o),r=o.end}return n}var ze={"2a8648ce3d030107":{curve:"P-256",hash:"SHA-256",size:32},"2b81040022":{curve:"P-384",hash:"SHA-384",size:48},"2b81040023":{curve:"P-521",hash:"SHA-512",size:66}};function He(e,t){let n=Z(e,0);if(n.tag!==48)throw new Error("der: not an ECDSA-Sig-Value");let[r,o]=U(e,n);if(!r||!o||r.tag!==2||o.tag!==2)throw new Error("der: not an ECDSA-Sig-Value");let a=new Uint8Array(t*2),i=0;for(let A of[r,o]){let s=A.contentStart;for(;s<A.end&&e[s]===0;)s++;let c=e.subarray(s,A.end);if(c.length>t)throw new Error("der: ECDSA integer wider than the curve");a.set(c,i+t-c.length),i+=t}return a}var Vn=new TextEncoder,Fn=globalThis.crypto.subtle;function le(e){let t=String(e).replace(/-----[^-]+-----/g,"").replace(/\s+/g,"");if(!t)throw new Error("x509: no PEM body found");return we(t)}var oe=(...e)=>M(e);var Mt=e=>new Uint8Array([e>>>24&255,e>>>16&255,e>>>8&255,e&255]),Ct=e=>Uint8Array.from(e,t=>t.charCodeAt(0)&255),Pe=(e,...t)=>{let n=oe(...t);return oe(Mt(8+n.length),Ct(e),n)},mt=(e,t)=>((e[t]??0)<<24|(e[t+1]??0)<<16|(e[t+2]??0)<<8|(e[t+3]??0))>>>0,It=(e,t)=>String.fromCharCode(e[t+4]??0,e[t+5]??0,e[t+6]??0,e[t+7]??0);function We(e,t,n){let r=[],o=t;for(;o<n;){if(o+8>n)return null;let a=mt(e,o);if(a===0&&(a=n-o),a===1||a<8||o+a>n)return null;r.push({off:o,size:a,type:It(e,o)}),o+=a}return r}var X=[26,69,223,163],L=[24,83,128,103],kn=new Uint8Array([18,84,195,103]),zn=new Uint8Array([115,115]),Hn=new Uint8Array([99,192]),Pn=new Uint8Array([104,202]),Wn=new Uint8Array([103,200]),Zn=new Uint8Array([69,163]),Ln=new Uint8Array([68,135]),ht=new Uint8Array([77,187]),pt=new Uint8Array([83,171]),Dt=new Uint8Array([83,172]),ue=290298740,Qt=524531317,Ze=475249515,Le=236,yt=191;function F(e,t){let n=e[t];if(n===void 0||n===0)return null;let r=1;for(;!(n&128>>r-1);)r++;if(t+r>e.length)return null;let o=n&255>>r,a=o===255>>r;for(let i=1;i<r;i++)o=o*256+(e[t+i]??0),a=a&&e[t+i]===255;return{width:r,value:o,unknown:a}}function ae(e,t){let n=t??1;if(t==null)for(;n<8&&e>2**(7*n)-2;)n++;if(e>2**(7*n)-2)return null;let r=new Uint8Array(n),o=e;for(let a=n-1;a>=0;a--)r[a]=o&255,o=Math.floor(o/256);return r[0]=(r[0]??0)|128>>n-1,r}var k=(e,t)=>oe(e,ae(t.length),t);var $=(e,t,n)=>n.every((r,o)=>e[t+o]===r);function Me(e,t){let n=e[t];if(n===void 0||n===0)return null;let r=1;for(;r<=4&&!(n&128>>r-1);)r++;if(r>4||t+r>e.length)return null;let o=0;for(let a=0;a<r;a++)o=o*256+(e[t+a]??0);return{width:r,value:o}}function he(e,t,n){let r=[],o=t;for(;o<n;){let a=Me(e,o);if(!a)return null;let i=F(e,o+a.width);if(!i)return null;let A={off:o,id:a.value,idWidth:a.width,sizeWidth:i.width,size:i.value,unknown:i.unknown};if(r.push(A),a.value===Qt)return{elements:r,firstCluster:A};if(i.unknown)return{elements:r,firstCluster:null};o+=a.width+i.width+i.value}return{elements:r,firstCluster:null}}var pe=e=>{let t=[];do t.unshift(e&255),e=Math.floor(e/256);while(e>0);return new Uint8Array(t)};function Ut(e){for(let t=1;t<=8;t++){let n=e-1-t;if(n<0)continue;let r=ae(n,t);if(r)return oe(new Uint8Array([Le]),r,new Uint8Array(n))}return null}function Oe(e,t,n,r){let o=t.elements.findIndex(f=>f.id===ue&&!f.unknown);if(o<0)return null;let a=t.elements[o],i=t.elements[o+1];if(!i||i.id!==Le||i.unknown)return null;let A=a.off+a.idWidth+a.sizeWidth;if(Me(e,A)?.value===yt)return null;let s=k(ht,oe(k(pt,n),k(Dt,pe(r)))),c=ae(a.size+s.length,a.sizeWidth),l=i.idWidth+i.sizeWidth+i.size,g=l-s.length>=2?Ut(l-s.length):null;if(!c||!g)return null;let d=i.off+l;return{start:a.off,end:d,bytes:oe(e.subarray(a.off,a.off+a.idWidth),c,e.subarray(A,A+a.size),s,g)}}var bt=new TextEncoder;function xt(e){let t=new Uint8Array(e.length);for(let n=0;n<e.length;n++)t[n]=e.charCodeAt(n)&255;return t}var z=e=>bt.encode(e);function me(e){return Uint8Array.of(e>>>24&255,e>>>16&255,e>>>8&255,e&255)}function Tt(e){return Uint8Array.of(e&255,e>>>8&255,e>>>16&255,e>>>24&255)}function Nt(e){return Uint8Array.of(e>>>8&255,e&255)}var Gt=(()=>{let e=new Uint32Array(256);for(let t=0;t<256;t++){let n=t;for(let r=0;r<8;r++)n=n&1?3988292384^n>>>1:n>>>1;e[t]=n>>>0}return e})();function St(...e){let t=4294967295;for(let n of e)for(let r=0;r<n.length;r++)t=Gt[(t^n[r])&255]^t>>>8;return(t^4294967295)>>>0}var Yt=Uint8Array.of(137,80,78,71,13,10,26,10);function Je(e,t){for(let g=0;g<8;g++)if(e[g]!==Yt[g])throw new Error("C2PA embed: not a PNG");let n=new DataView(e.buffer,e.byteOffset),r=-1,o=[];for(let g=8;g+8<=e.length;){let d=n.getUint32(g),f=String.fromCharCode(e[g+4],e[g+5],e[g+6],e[g+7]),m=g+d+12;if(m>e.length)throw new Error("C2PA embed: malformed PNG chunk");if(f==="IHDR"&&(r=m),f==="caBX"&&o.push({start:g,end:m}),f==="IEND")break;g=m}if(r<0)throw new Error("C2PA embed: PNG has no IHDR");let a=M([me(t.length),z("caBX"),t,me(St(z("caBX"),t))]),i=[],A=r;for(let g of o)g.end<=r&&(A-=g.end-g.start);let s=0;for(let g of o)i.push(e.subarray(s,g.start)),s=g.end;i.push(e.subarray(s));let c=o.length?M(i):e;return{out:M([c.subarray(0,A),a,c.subarray(A)]),exclusions:[{start:A,length:a.length}]}}var Ke=64e3;function Xe(e,t){if(!(e[0]===255&&e[1]===216))throw new Error("C2PA embed: not a JPEG");let n=2,r=[],o=-1;for(let E=2;E+4<=e.length&&e[E]===255;){let x=e[E+1];if(x===216||x>=208&&x<=217){E+=2;continue}let Y=e[E+2]<<8|e[E+3],w=E+2+Y;if(w>e.length)throw new Error("C2PA embed: malformed JPEG segment");if(x===224&&(n=w),x===235&&Y>=18){let p=e.subarray(E+4,w),J=p[2]<<8|p[3];p.length>28&&p[24]===99&&p[25]===50&&p[26]===112&&p[27]===97?(r.push({start:E,end:w}),o=J):J===o&&r.length&&r.push({start:E,end:w})}if(x===218)break;E=w}let a=[],i=t.subarray(0,8),A=1;for(let E=0;E<t.length;E+=Ke,A++){let x=t.subarray(E,Math.min(E+Ke,t.length)),Y=A===1?M([z("JP"),Uint8Array.of(2,17),me(A),x]):M([z("JP"),Uint8Array.of(2,17),me(A),i,x]);a.push(M([Uint8Array.of(255,235),Nt(Y.length+2),Y]))}let s=M(a),c=0;for(let E of r)E.end<=n&&(c+=E.end-E.start);let l=[],g=0;for(let E of r)l.push(e.subarray(g,E.start)),g=E.end;l.push(e.subarray(g));let d=r.length?M(l):e,f=n-c;return{out:M([d.subarray(0,f),s,d.subarray(f)]),exclusions:[{start:f,length:s.length}]}}function Rt(e,t){let n=String.fromCharCode(...e.subarray(0,6));if(n!=="GIF87a"&&n!=="GIF89a")throw new Error("C2PA embed: not a GIF");let r=e[10],o=13;r&128&&(o+=3*(1<<(r&7)+1));let a=null;for(let l=o;l<e.length&&!a;){let g=e[l];if(g===44||g===59)break;if(g!==33)throw new Error("C2PA embed: malformed GIF block");let d=e[l+1],f=l+2;if(f>=e.length)throw new Error("C2PA embed: truncated GIF block");for((d===255||d===1||d===249)&&(f+=1+e[f]);f<e.length&&e[f]!==0;)f+=1+e[f];if(f>=e.length)throw new Error("C2PA embed: truncated GIF sub-blocks");f+=1,d===255&&String.fromCharCode(...e.subarray(l+3,l+11))==="C2PA_GIF"&&e[l+11]===1&&e[l+12]===0&&e[l+13]===0&&(a={start:l,end:f}),l=f}let i=[];for(let l=0;l<t.length;l+=255){let g=t.subarray(l,Math.min(l+255,t.length));i.push(Uint8Array.of(g.length),g)}let A=M([Uint8Array.of(33,255,11),z("C2PA_GIF"),Uint8Array.of(1,0,0),...i,Uint8Array.of(0)]),s=a?M([e.subarray(0,a.start),e.subarray(a.end)]):e,c=M([s.subarray(0,o),A,s.subarray(o)]);return c[4]=57,{out:c,exclusions:[{start:o,length:A.length}]}}var qe=' xmlns:c2pa="http://c2pa.org/manifest"';function Vt(e,t){let n=W(e),r=/<svg(?=[\s>])/.exec(n);if(!r)throw new Error("C2PA embed: not an SVG (no <svg> root)");let o=r.index+4,a=null;for(;o<n.length;o++){let E=n[o];if(a)E===a&&(a=null);else if(E==='"'||E==="'")a=E;else if(E===">")break}if(o>=n.length)throw new Error("C2PA embed: unterminated <svg> tag");if(n[o-1]==="/")throw new Error("C2PA embed: self-closing <svg/> cannot hold a manifest");let i=n.slice(r.index,o),A=n,s=o+1;i.includes("xmlns:c2pa")||(A=n.slice(0,o)+qe+n.slice(o),s+=qe.length);let c=btoa(W(t)),l=/<c2pa:manifest[^>]*>/.exec(A),g,d,f;if(l){let E=A.indexOf("</c2pa:manifest>",l.index);if(E<0)throw new Error("C2PA embed: unterminated c2pa:manifest element");g=A.slice(0,l.index+l[0].length),d=A.slice(E),f=g.length}else{let E=/<metadata(?=[\s>])[^>]*>/.exec(A);E&&A[E.index+E[0].length-2]!=="/"?(g=A.slice(0,E.index+E[0].length)+"<c2pa:manifest>",d="</c2pa:manifest>"+A.slice(E.index+E[0].length)):(g=A.slice(0,s)+"<metadata><c2pa:manifest>",d="</c2pa:manifest></metadata>"+A.slice(s)),f=g.length}return{out:xt(g+c+d),exclusions:[{start:f,length:c.length}]}}function _e(e,t){let n=e[0]===73&&e[1]===73,r=e[0]===77&&e[1]===77;if(!n&&!r)throw new Error("C2PA embed: not a TIFF");let o=new DataView(e.buffer,e.byteOffset),a=w=>o.getUint16(w,n),i=w=>o.getUint32(w,n);if(a(2)!==42)throw new Error("C2PA embed: BigTIFF is not supported");let A=new Set,s=i(4);if(!s)throw new Error("C2PA embed: TIFF has no IFD");let c=s,l=4;for(;s&&!A.has(s);){A.add(s);let w=a(s),p=s+2+w*12;if(p+4>e.length)throw new Error("C2PA embed: malformed TIFF IFD");c=s,l=p,s=i(p)}if(s)throw new Error("C2PA embed: cyclic TIFF IFD chain");let g=(4-e.length%4)%4,d=e.length+g,f=d+2+12+4,m=w=>{let p=new Uint8Array(2);return new DataView(p.buffer).setUint16(0,w,n),p},E=w=>{let p=new Uint8Array(4);return new DataView(p.buffer).setUint32(0,w,n),p},x=M([m(1),m(52545),m(7),E(t.length),E(f),E(0)]),Y=M([e,new Uint8Array(g),x,t]);return new DataView(Y.buffer,Y.byteOffset).setUint32(l,d,n),{out:Y,exclusions:[{start:d+2+2+2,length:4},{start:f,length:t.length}]}}function Ft(e,t){let n=c=>String.fromCharCode(e[c],e[c+1],e[c+2],e[c+3]);if(n(0)!=="RIFF"||n(8)!=="WEBP")throw new Error("C2PA embed: not a WebP");let r=new DataView(e.buffer,e.byteOffset),o=null;for(let c=12;c+8<=e.length;){let l=r.getUint32(c+4,!0),g=c+8+l+(l&1);if(g>e.length+1)throw new Error("C2PA embed: malformed WebP chunk");n(c)==="C2PA"&&(o={start:c,end:Math.min(g,e.length)}),c=g}let a=o?M([e.subarray(0,o.start),e.subarray(o.end)]):e,i=M([z("C2PA"),Tt(t.length),t,t.length&1?Uint8Array.of(0):new Uint8Array(0)]),A=a.length,s=M([a,i]);return new DataView(s.buffer,s.byteOffset).setUint32(4,s.length-8,!0),{out:s,exclusions:[{start:A,length:t.length+8}]}}var Be=Uint8Array.of(216,254,195,214,27,14,72,60,146,151,88,40,135,126,196,129);var jt=(e,t)=>t.type==="uuid"&&t.size>=24&&Be.every((n,r)=>e[t.off+8+r]===n);function vt(e,t){let n=We(e,0,e.length);if(!n||!n.length)throw new Error("C2PA embed: malformed MP4 (truncated or 64-bit boxes)");if(n[0].type!=="ftyp")throw new Error("C2PA embed: not an MP4 (no leading ftyp box)");let r=n.filter(s=>jt(e,s));if(r.length>1||r.length===1&&r[0]!==n[n.length-1])throw new Error("C2PA embed: cannot replace an existing MP4 credential that is not the last box");let o=r.length?e.subarray(0,r[0].off):e,a=r.length?n[n.length-2]:n[n.length-1];if(a&&(e[a.off]|e[a.off+1]|e[a.off+2]|e[a.off+3])===0){if(a.size>4294967295)throw new Error("C2PA embed: cannot finalise a to-EOF MP4 box over 4GB");o=o.slice(),o[a.off]=a.size>>>24,o[a.off+1]=a.size>>>16&255,o[a.off+2]=a.size>>>8&255,o[a.off+3]=a.size&255}let i=Pe("uuid",Be,new Uint8Array(4),z("manifest\0"),new Uint8Array(8),t),A=o.length;return{out:M([o,i]),exclusions:[{start:A,length:i.length}]}}var De=Uint8Array.of(25,65,164,105),kt=Uint8Array.of(97,167),zt=Uint8Array.of(70,110),ge=Uint8Array.of(70,96),Ht=Uint8Array.of(70,174),Pt=Uint8Array.of(70,92),Qe=423732329,Ee="application/c2pa",Wt=e=>k(De,k(kt,M([k(zt,z("manifest.c2pa")),k(ge,z(Ee)),k(Ht,pe(1)),k(Pt,e)])));function Ce(e,t){if(t.id!==Qe||t.unknown)return!1;let n=z(Ee),r=Math.min(t.off+t.idWidth+t.sizeWidth+t.size,e.length);e:for(let o=t.off;o+ge.length<=r-n.length;o++){if(!$(e,o,ge))continue;let a=F(e,o+ge.length);if(!a||a.unknown||a.value!==n.length)continue;let i=o+ge.length+a.width;if(!(i+n.length>r)){for(let A=0;A<n.length;A++)if(e[i+A]!==n[A])continue e;return!0}}return!1}function Zt(e,t){if(!$(e,0,X))throw new Error("C2PA embed: not a WebM/Matroska file");let n=F(e,X.length);if(!n||n.unknown)throw new Error("C2PA embed: malformed EBML header");let r=X.length+n.width+n.value;if(!$(e,r,L))throw new Error("C2PA embed: no Matroska Segment");let o=F(e,r+L.length);if(!o)throw new Error("C2PA embed: malformed Segment size");let a=Wt(t),i=r+L.length+o.width;if(o.unknown){let w=he(e,i,e.length);if(!w)throw new Error("C2PA embed: malformed Matroska Segment");let p=w.firstCluster&&!w.firstCluster.unknown?w.firstCluster.off+w.firstCluster.idWidth+w.firstCluster.sizeWidth+w.firstCluster.size:-1,J=p>=0?Ot(e,p,e.length):[];if([...w.elements.map(G=>G.id),...J].some(G=>G===ue||G===Ze))throw new Error("C2PA embed: unsupported Matroska shape (unknown-size Segment with an index)");if(w.elements.some(G=>G.id===Qe&&!Ce(e,G)))throw new Error("C2PA embed: Matroska file already has attachments");let R=w.elements[w.elements.length-1];if(!w.firstCluster&&R){let G=R.off+R.idWidth+R.sizeWidth+R.size;if(R.unknown||G>e.length)throw new Error("C2PA embed: unsupported Matroska shape (unmeasurable Segment tail)")}let N=w.elements.find(G=>Ce(e,G)),Ae=N?N.off:-1,ce=N?N.off+N.idWidth+N.sizeWidth+N.size:-1,K=w.firstCluster?w.firstCluster.off:e.length;if(N&&ce>K)throw new Error("C2PA embed: cannot replace existing Matroska credential");let _=N?M([e.subarray(0,Ae),e.subarray(ce,K)]):e.subarray(0,K);return{out:M([_,a,e.subarray(K)]),exclusions:[{start:_.length,length:a.length}]}}let A=i+o.value;if(A>e.length)throw new Error("C2PA embed: truncated Matroska Segment");let s=e,c=o.value,l=Lt(s,i,A);if(l.some(w=>w.id===Qe&&!Ce(s,w)))throw new Error("C2PA embed: Matroska file already has attachments");let g=l.filter(w=>Ce(s,w));if(g.length){let w=g[g.length-1],p=w.off+w.idWidth+w.sizeWidth+w.size;if(g.length>1||p!==A)throw new Error("C2PA embed: cannot replace existing Matroska credential");c-=p-w.off,s=M([s.subarray(0,w.off),s.subarray(p)]),A=w.off}let d=ae(c+a.length,o.width);if(!d)throw new Error("C2PA embed: Segment size does not fit its VINT width");let f=he(s,i,A),m=f&&Jt(s,f,De),E=f&&!m?Oe(s,f,De,c):null,x=E?M([s.subarray(i,E.start),E.bytes,s.subarray(E.end,A)]):s.subarray(i,A);return{out:M([s.subarray(0,r+L.length),d,x,a,s.subarray(A)]),exclusions:[{start:i+c,length:a.length}]}}function Lt(e,t,n){let r=[],o=t;for(;o<n;){let a=$e(e,o,n),i=a&&F(e,o+a.width);if(!a||!i||i.unknown)throw new Error("C2PA embed: malformed Matroska Segment");let A=o+a.width+i.width+i.value;if(A>n||A<=o)throw new Error("C2PA embed: malformed Matroska Segment");r.push({off:o,id:a.value,idWidth:a.width,sizeWidth:i.width,size:i.value,unknown:!1}),o=A}return r}function Ot(e,t,n){let r=[],o=t;for(;o<n;){let a=$e(e,o,n),i=a&&F(e,o+a.width);if(!a||!i||i.unknown)break;let A=o+a.width+i.width+i.value;if(A>n||A<=o)break;r.push(a.value),o=A}return r}function $e(e,t,n){let r=e[t];if(r===void 0||r===0)return null;let o=1;for(;o<=4&&!(r&128>>o-1);)o++;if(o>4||t+o>n)return null;let a=0;for(let i=0;i<o;i++)a=a*256+e[t+i];return{width:o,value:a}}function Jt(e,t,n){let r=t.elements.find(A=>A.id===ue&&!A.unknown);if(!r)return!1;let o=r.off+r.idWidth+r.sizeWidth,a=o+r.size,i=M([Uint8Array.of(83,171),ae(n.length),n]);e:for(let A=o;A+i.length<=a;A++){for(let s=0;s<i.length;s++)if(e[A+s]!==i[s])continue e;return!0}return!1}var Kt={png:{place:Je,mime:"image/png"},apng:{place:Je,mime:"image/png"},jpg:{place:Xe,mime:"image/jpeg"},jpeg:{place:Xe,mime:"image/jpeg"},gif:{place:Rt,mime:"image/gif"},svg:{place:Vt,mime:"image/svg+xml"},tiff:{place:_e,mime:"image/tiff"},"cmyk-tiff":{place:_e,mime:"image/tiff"},webp:{place:Ft,mime:"image/webp"},mp4:{place:vt,mime:"video/mp4",hash:"bmff"},webm:{place:Zt,mime:"video/webm"}},Xt=Object.freeze(["pdf","pdf-cmyk",...Object.keys(Kt)]);var qt=new TextEncoder,tr=globalThis.crypto.subtle,ye=class{tag;value;constructor(t,n){this.tag=t,this.value=n}};function q(e,t){let n=e<<5;if(t<24)return Uint8Array.of(n|t);if(t<256)return Uint8Array.of(n|24,t);if(t<65536)return Uint8Array.of(n|25,t>>>8,t&255);if(t<4294967296)return Uint8Array.of(n|26,t>>>24,t>>>16&255,t>>>8&255,t&255);let r=new Uint8Array(9);return r[0]=n|27,new DataView(r.buffer).setBigUint64(1,BigInt(t)),r}function ee(e,t){if(e===null){t.push(Uint8Array.of(246));return}if(e===!0){t.push(Uint8Array.of(245));return}if(e===!1){t.push(Uint8Array.of(244));return}if(typeof e=="number"){if(!Number.isSafeInteger(e))throw new Error("cbor: only safe integers are supported, got "+e);t.push(e>=0?q(0,e):q(1,-1-e));return}if(typeof e=="string"){let n=qt.encode(e);t.push(q(3,n.length),n);return}if(e instanceof Uint8Array){t.push(q(2,e.length),e);return}if(Array.isArray(e)){t.push(q(4,e.length));for(let n of e)ee(n,t);return}if(e instanceof ye){t.push(q(6,e.tag)),ee(e.value,t);return}if(e instanceof Map){t.push(q(5,e.size));for(let[n,r]of e)ee(n,t),ee(r,t);return}if(typeof e=="object"){let n=Object.keys(e);t.push(q(5,n.length));for(let r of n)ee(r,t),ee(e[r],t);return}throw new Error("cbor: unsupported value type "+typeof e)}function et(e){let t=[];return ee(e,t),M(t)}var _t=[0,17,0,16,128,0,0,170,0,56,155,113],te=e=>Uint8Array.of(e.charCodeAt(0),e.charCodeAt(1),e.charCodeAt(2),e.charCodeAt(3),..._t),nr=te("c2pa"),rr=te("c2ma"),or=te("c2as"),ar=te("c2cl"),ir=te("c2cs"),sr=te("cbor"),Ar=te("json");var tt="tools.lolly.export";var $t=`# Google C2PA hierarchy (NOT in the Adobe/C2PA list below; sourced from Google PKI)
Google C2PA Root CA G3 (Google LLC) \u2014 fetched from http://pki.goog/c2pa/root-g3.crt
-----BEGIN CERTIFICATE-----
MIICLjCCAbOgAwIBAgIUUZK4AROFKiXQZ1UG7FG6qPGc1g8wCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwIBcNMjUwNTA4MjIzMjIxWhgPMjA1MDA1MDgy
MjMyMjFaMEMxCzAJBgNVBAYTAlVTMRMwEQYDVQQKDApHb29nbGUgTExDMR8wHQYD
VQQDDBZHb29nbGUgQzJQQSBSb290IENBIEczMHYwEAYHKoZIzj0CAQYFK4EEACID
YgAEhv9f/juKcPpe3Fm7eAISMuSyS+tBxn0aYHC83J+qAsFWREGN9p6PN/OBoouP
zpOFRxvrlWoWmAI3p1lXyPg4E3eg7SNChgopUIpihGu6qlhP8rLXf3p8bhI5FTQ2
MaF2o2YwZDASBgNVHRMBAf8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBBjAfBgNV
HSMEGDAWgBScXNiJU0PnWtWB2wPeGX8EKiotqjAdBgNVHQ4EFgQUnFzYiVND51rV
gdsD3hl/BCoqLaowCgYIKoZIzj0EAwMDaQAwZgIxAIyVEe5bdUMkk6BthEWy9QSE
Mb74BOyK8/8pgMX0NPwLlo1ikLNY78ov+k21vZrEZQIxANQ91muDXgPjAMAkzAlK
i32Z9VBB37ynTveKVC7ofTW0ZFfIIYYpWUR1+C4m2yRkOQ==
-----END CERTIFICATE-----

# C2PA / Content Authenticity trust list \u2014 https://verify.contentauthenticity.org/trust/anchors.pem
## This interim trust list is now frozen.  C2PA has published an official trust list, and new anchor certificates should be added to that list. NOTE: Content Credentials are still valid which were signed using certificates chaining back to root certs on this list. Validators can still refer to this trust list, but should distinguish between Content Credentials signed with certs tracing back to these and those signed with certs tracing back to root certs on the official C2PA trust list.  
## Currently, the verifier at https://verify.contentauthenticity.org/ uses this list.  
## 

Leica C2PA Root 
-----BEGIN CERTIFICATE-----
MIIDCDCCAq2gAwIBAgIQfj2771gNZMLyE3lSWlq8UDAKBggqhkjOPQQDAjCBojEL
MAkGA1UEBhMCREUxGDAWBgNVBAoTD0xlaWNhIENhbWVyYSBBRzEbMBkGA1UEAxMS
TGVpY2EgQzJQQSBSb290IENBMRAwDgYDVQQHEwdXZXR6bGFyMQ4wDAYDVQQREwUz
NTU3ODEYMBYGA1UECRMPQW0gTGVpdHotUGFyayA1MQ8wDQYDVQQFEwYyMDIzLTEx
DzANBgNVBAgTBkhlc3NlbjAgFw0yMzA3MDQxMjM1MzNaGA8yMDczMDcwNDEyMzUz
M1owgaIxCzAJBgNVBAYTAkRFMRgwFgYDVQQKEw9MZWljYSBDYW1lcmEgQUcxGzAZ
BgNVBAMTEkxlaWNhIEMyUEEgUm9vdCBDQTEQMA4GA1UEBxMHV2V0emxhcjEOMAwG
A1UEERMFMzU1NzgxGDAWBgNVBAkTD0FtIExlaXR6LVBhcmsgNTEPMA0GA1UEBRMG
MjAyMy0xMQ8wDQYDVQQIEwZIZXNzZW4wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AATYWHZLNiNnug3OVuNy0DbdTFEDDuVfzZeqis2yX2AgqZ9fM2R7UqC01v5pMx/N
xRMSV/Q/DD6wR0dwtkXaxohko4HAMIG9MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0O
BBYEFK1aJ39jgaFAW/vnqbxTtDBFVI77MDUGCCsGAQUFBwEBBCkwJzAlBggrBgEF
BQcwAYYZaHR0cDovL29jc3AubGVpY2Euc3lzdGVtczAOBgNVHQ8BAf8EBAMCAQYw
RAYDVR0fBD0wOzA5oDegNYYzaHR0cDovL2NybC5sZWljYS5zeXN0ZW1zL2NybC9s
ZWljYV9jMnBhX3Jvb3RfY2EuY3JsMAoGCCqGSM49BAMCA0kAMEYCIQCMmLG+9WqL
EFo+xkgDMaihJTTpbWDfSCcNrMfb9KEl+wIhAORyQm7Wchx4fmMQKYubFjeYCZtP
u+FSiisFK83vwhTQ
-----END CERTIFICATE-----

Microsoft Root 
-----BEGIN CERTIFICATE-----
MIIFrzCCA5egAwIBAgIQaCjVTH5c2r1DOa4MwVoqNTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTAw
LgYDVQQDEydNaWNyb3NvZnQgU3VwcGx5IENoYWluIFJTQSBSb290IENBIDIwMjIw
HhcNMjIwMjE3MDAxMjM2WhcNNDcwMjE3MDAyMTA5WjBfMQswCQYDVQQGEwJVUzEe
MBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTAwLgYDVQQDEydNaWNyb3Nv
ZnQgU3VwcGx5IENoYWluIFJTQSBSb290IENBIDIwMjIwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCeJQFmGR9kNMGdOSNiHXGLVuol0psf7ycBgr932JQz
gxhIm1Cee5ZkwtDDX0X/MpzoFxe9eO11mF86BggrHDebRkqQCrCvRpI+M4kq+rjn
MmPzI8du0hT7Jlju/gaEVPrBHzeq29TsViq/Sb3M6wLtxk78rBm1EjVpFYkXTaNo
6mweKZoJ8856IcYJ0RnqjzBGaTtoBCt8ii3WY13qbdY5nr0GPlvuLxFbKGunUqRo
Xkyk6q7OI79MNnHagUVQjsqGzv9Tw7hDsyTuB3qitPrHCh17xlI1MewIH4SAklv4
sdo51snn5YkEflF/9OZqZEdJ6vjspvagQ1P+2sMjJNgl2hMsKrc/lN53HEx4HGr5
mo/rahV3d61JhM4QQMeZSA/Vlh6AnHOhOKEDb9NNINC1Q+T3LngPTve8v2XabZAL
W7/e6icnmWT4OXxzPdYh0u7W81MRLlXD3OrxKVfeUaF4c5ALL/XJdTbrjdJtjnld
uho4/98ZAajSyNHW8uuK9S7RzJMTm5yQeGVjeQTE8Z6fjDrzZAz+mB2T4o9WpWNT
I7hucxZFGrb3ew/NpDL/Wv6WjeGHeNtwg6gkhWkgwm0SDeV59ipZz9ar54HmoLGI
LQiMC7HP12w2r575A2fZQXOpq0W4cWBYGNQWLGW60QXeksVQEBGQzkfM+6+/I8Cf
BQIDAQABo2cwZTAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HQ4EFgQUC7NoO6/ar+5wpXbZIffMRBYH0PgwEAYJKwYBBAGCNxUBBAMCAQAwEQYD
VR0gBAowCDAGBgRVHSAAMA0GCSqGSIb3DQEBDAUAA4ICAQBIxzf//8FoV9eLQ2ZG
OiZrL+j63mihj0fxPTSVetpVMfSV0jhfLLqPpY1RMWqJVWhsK0JkaoUkoFEDx93R
cljtbB6M2JHF50kRnRl6N1ged0T7wgiYQsRN45uKDs9ARU8bgHBZjJOB6A/VyCaV
qfcfdwa4yu+c++hm2uU54NLSYsOn1LYYmiebJlBKcpfVs1sqpP1fL37mYqMnZgz6
2RnMER0xqAFSCOZUDJljK+rYhNS0CBbvvkpbiFj0Bhag63pd4cdE1rsvVVYl8J4M
5A8S28B/r1ZdxokOcalWEuS5nKhkHrVHlZKu0HDIk318WljxBfFKuGxyGKmuH1eZ
JnRm9R0P313w5zdbX7rwtO/kYwd+HzIYaalwWpL5eZxY1H6/cl1TRituo5lg1oWM
ZncWdq/ixRhb4l0INtZmNxdl8C7PoeW85o0NZbRWU12fyK9OblHPiL6S6jD7LOd1
P0JgxHHnl59zx5/K0bhsI+pQKB0OQ8z1qRtA66aY5eUPxZIvpZbH1/o8GO4dG2ED
/YbnJEEzvdjztmB88xyCA9Vgr9/0IKTkgQYiWsyFM31k+OS4v4AX1PshP2Ou54+3
F0Tsci41yQvQgR3pcgMJQdnfCUjmzbeyHGAlGVLzPRJJ7Z2UIo5xKPjBB1Rz3TgI
tIWPFGyqAK9Aq7WHzrY5XHP5kA==
-----END CERTIFICATE-----

Adobe Root 
-----BEGIN CERTIFICATE-----
MIIFpDCCA4ygAwIBAgIQXfEvX1enw+GwAtiTJwzd4TANBgkqhkiG9w0BAQsFADBs
MQswCQYDVQQGEwJVUzEjMCEGA1UEChMaQWRvYmUgU3lzdGVtcyBJbmNvcnBvcmF0
ZWQxHTAbBgNVBAsTFEFkb2JlIFRydXN0IFNlcnZpY2VzMRkwFwYDVQQDExBBZG9i
ZSBSb290IENBIEcyMB4XDTE2MTEyOTAwMDAwMFoXDTQ2MTEyODIzNTk1OVowbDEL
MAkGA1UEBhMCVVMxIzAhBgNVBAoTGkFkb2JlIFN5c3RlbXMgSW5jb3Jwb3JhdGVk
MR0wGwYDVQQLExRBZG9iZSBUcnVzdCBTZXJ2aWNlczEZMBcGA1UEAxMQQWRvYmUg
Um9vdCBDQSBHMjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBALbacmKb
7oN7MqJG44ojMpdXrC1zdFHLBv97MuaXDKzI59kgZ0hK900lgU8iXW9p2iwYQs/F
bJ0+cTRxUlKhthpbnRTNu42R5LGI+XAPbQznxqfr82ScT11BwF/mF4hATOsDy5Xv
sqXmjji9HCN5V8MicQTJcQ6zK9W9U52m7lLt3vK1T/eQKFL9UBd+JN032AoSGxOL
oxQ55qlJp8bVTBbBX220ZwrnGpl2Q59F7Mwc9KQSUG/6kJ/maqi7l5E//eUgj+CP
+WO82cW5XQmMp5aSZ6hg1dW2dBLDddEZe7/zl43eWp+S8DRByzQofDt+yAKkp7MJ
K5Vdhh4RnMGdAkkg1s7e2osxG090hIfqwV4pE5m7QT4ikNJmxxorvZNETfO+FxCJ
o72i7yMymZWHmKXObvluPvByzqVpuFPldywKvZgHIte730TZ2JZtnArX638/APjD
KH3hJRJNnx8KH2/WWNTek2IY8vuyMMrFukKMzDiglqfL2QGzyWpObMTazhvP/Z2M
MjtWVtMoZeGceUTfSq64HNwzFkZoz3rOPYu1ZYw493PEjqaY5fxIMtBd/kv2m5WS
FUUwBA2eJWKkx0u/cZ91ZAfxSwuGbaplDvr9NzIJXRdtiZRAI4fptFOVzSNvCQ9C
zK7QQRrbbLdFjsMP3VxSfsIJcrcMATSDLm6BAgMBAAGjQjBAMA4GA1UdDwEB/wQE
AwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSmHOFtVCRMqI9Icr9uqYzV
5Owx1DANBgkqhkiG9w0BAQsFAAOCAgEAlfp1Y79qJhM2l0QgpaXieeEB7wgURNlA
QRPQOjw24NlmnM4Kquzx9LSVoP1EPlTx+3ku0dGcTYhZiBsLTeOTjMT4j36j5jKT
WfWuuGwQboawtSftbmW7Bsy5x8ZEU7g70toZR2HVlXbaR46ChinHlNu79IXBtWZs
bdG+/btjGrVg6cQAs3U/GAFsoL4G1MkqV6shDvHQNjlzEBbkS0Idcvt+J3sqn/Om
JU8tAqzNx7e2RLUI2ZH4DT1QjVadgik5UVM9AAeTS1gTsIp3nCCid2aF0MpeIZp1
u25E8yQRxBYeVFoj1ZYtxwYfcz3X6A68gIb6ZBeRzPq+wt8bEpS8h47O6hJ5pyNB
bdqBDe6SVdwz7ZUtjGBEJM5oc68j+QNShnke23/duIeK0jopwpyCeEtFckyNjAoL
YsrGG3+MQQGVDqgYZ/W8Ow0AQz/Zt0RfcqQmfCdbxWbTusR8lpZf8reaPU2X5adp
YDpY8W+rVNULcsk/Sj+BZ8YpcrMk90BbXf2K7bbzQw2ODtzHphL6SQkt3Ja6oKLa
WRvQTsaK7K8w+WSilfCtt4u4AAxByxlwmt/KHeMfHZskty/rHLyk7kwgtRzXdvpA
7quYkGyLWtTtZoB5J1b7OYUraMDuqG1s39jMchHjda1GqOwsBWxDqC4HqtdY7TK2
ofZLvqTHvT4=
-----END CERTIFICATE-----

Truepic Root 
-----BEGIN CERTIFICATE-----
MIIFbzCCA1egAwIBAgIUQfJJVcjenVsqV04ke2B6+nMusbowDQYJKoZIhvcNAQEM
BQAwPzEPMA0GA1UEAwwGUm9vdENBMQ0wCwYDVQQLDARMZW5zMRAwDgYDVQQKDAdU
cnVlcGljMQswCQYDVQQGEwJVUzAeFw0yMTEyMDkyMDA0MTdaFw0zNjEyMDUyMDA0
MTZaMD8xDzANBgNVBAMMBlJvb3RDQTENMAsGA1UECwwETGVuczEQMA4GA1UECgwH
VHJ1ZXBpYzELMAkGA1UEBhMCVVMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK
AoICAQDpdmLCqEXVSqb2GVireQbWQHTh9fo3Sja9r9grNAgH4iqEKS7Wlv+zDFmB
lWEfED/e1teBFy8sXqQTZM/nqfEuOAYbepJl535Olp/vOUryAMx78M2svGGug8xG
IOTXGJPekK9sqUwgNe6lgAP7v648d2ygw58MHZ/y20B3XMgiWMwVeM24PHYfQ/bp
zYz3AkG9lrmHbFu8Aily4jFe2b6VI1JbQYgo6DM2uPl7l3VRK2a857+WZioco425
a1xWnv/sJYxPjLEBNq3BDkAJ8vz4DbKnGbRg4mwFQLpLY7bGJVfU14xEbDfuoz/K
ZBO8D2ktLGQGtFdldtsbVGdGvyvuOz/gcwJ/Vq5om7+8OkByiCw50bjU1caReS4q
842VZt1Hw6P3MUsfjHycG+xwYwu0jC4DXl1xCdnuRtYlYZhP8TkUUCN5XeLdnyAm
HIlItkhxin9+2UcNUJUFckyuR2Y5rqAMWZslzb22vPV1QAuBB+wHFPjJrMPMWuw6
3wOBqLAPhplMUp//Ixbo6RXuhs5duNn7Jq6FLx5Eu6sZOiF/MuFnGpvKWr0LrGkP
bnc7wPcFMafh/7Ha9IhAGsD4sELsgTNWcklyPYxLESy+DHptF9nLc+6SAzDPy4ci
qB0tSRS/jehD6hQ5XdTcyYUjjFUlG04uRqImKJhEQVN8/A/GGQIDAQABo2MwYTAP
BgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFFi68anyDedFBgqwKadalzDqJz0L
MB0GA1UdDgQWBBRYuvGp8g3nRQYKsCmnWpcw6ic9CzAOBgNVHQ8BAf8EBAMCAYYw
DQYJKoZIhvcNAQEMBQADggIBAIM3f+uTGlEhxinXEASr0MfbUZOK1i58KyDM35Ot
NOHrXv4+z468US40tSYYizto2tpALygkAh0ddywgayOGwLaKR00IkIVwbEH4UVho
pR1QK7PXmmqrF8MTe60TNUiRgC6NUzzKyCIZzIy5e4Q3Cx8uMnNYniaU0TPZeWF9
pWRiIPc7QOZPl3pAUMtHMFv1z5Ww+vJ6iUHKSQFCSs6vy+/fdiWLfdgok6mvXbw1
EE6J6DIypwZU275v5L4UM9b40uNqlSdk6ckraNcj2whsx7D8fpXwKjvkCbihWt8l
gd05fL/7tJBnO/YorriTtBqtUviLnnTc0iEjC5S6yo/HIEWJUL+VK8hH4Tvq4e7Q
W5KC2/hFQ40CyOIuq0QMfjml+Uwp/4zW6LGK+OA09VhQ1dilztXvOE+tZorPTwy5
CPRDi5Mjou6ZQy8LbhSdzrjVJGmEbv/7bsDDxHB/zN4Xb8LrtS89hoGDowu/y/vh
p4/IGuK7iAYb7mLrho0Xl9FUnavgYSm/tMh9UvcZ4Hs5ZeOhdbr5cbxVKDrCGwTs
77U+mI4JBR4WdoORw/CMyjLF7mkO3QZmr0YhTLMdRzn6/yPkotg9OAbLEM1cVZSt
wiz6O4c5amE4Nx+V6hBaLctoD23No45vnrnBDCF3BcVmFcQPBGF450dzKAnuY25a
wpEZ
-----END CERTIFICATE-----

Microsoft RNC Root
-----BEGIN CERTIFICATE-----
MIIFzDCCA7SgAwIBAgIQVJjS0dRbGZVIE3nIEcCHmTANBgkqhkiG9w0BAQwFADB3
MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMUgw
RgYDVQQDEz9NaWNyb3NvZnQgSWRlbnRpdHkgVmVyaWZpY2F0aW9uIFJvb3QgQ2Vy
dGlmaWNhdGUgQXV0aG9yaXR5IDIwMjAwHhcNMjAwNDE2MTgzNjE2WhcNNDUwNDE2
MTg0NDQwWjB3MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBv
cmF0aW9uMUgwRgYDVQQDEz9NaWNyb3NvZnQgSWRlbnRpdHkgVmVyaWZpY2F0aW9u
IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMjAwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCzkSoHgwZn/Z6d4MfAt6TmQgR/D6bbX/vVWtdFoPt3
C/CA86ZtWk15U9ighoRXRSDHolT7x6K/isduNfOiFcQvTuNKhZZJDf++mdgU9rwn
B+5Cmyv1C5IG5P1pE2WokXLymITrgz0O5NdxEkghyw3t9kdJt5v5yccXtoRP/7is
mtdzZ0mF44a9N0DQJYbU3rXCbWJq1al4vC1vSfnlbBQU/RTH02UWN97LbrxeKY39
YpsVLNYF5rmJMjOjYsfX1lJnCMQu9FYrnguHzOyntKaq6wXNGVelOgsEJxyRZ54t
Yi0vHr7awCDLBBnKM/uJvpjicqByNb554ZyDb+RtF2+Q8z0AhnU4jtDgSZq729P4
MMrVV4hoTXLTv21/cdj9vQ2ukmRIt1tveSa1zZuVIYTR7w8yPXtXjPNFB0x84F4Y
DjV2i22eyzZ0qwX44HNdMlaUZ5clCsY1PZSX58FEi4D9wfj0dBnlMPYG+yFXPgYc
i2sVhidJe4KTylnodUfoPzj0x1N5oLa04lxR771fOMET5ngMlVouxUBZKMwPJMDs
ugl3I5k4prYc2se6ILbXN9h/N68I4ztx225zG32ZcrDkhjNZdLUWAHtQbcaGE9r9
xDmCPSQAmmDaupTABVEsNKxQmROHu7MFgLJNMAJcuCaDXbRjc++uI5VPYCi+N9Vb
pQIDAQABo1QwUjAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HQ4EFgQUyH7SaoUqG8oZmAQHJ89QEE9oqKIwEAYJKwYBBAGCNxUBBAMCAQAwDQYJ
KoZIhvcNAQEMBQADggIBAK9q3eYZ5y2UQxlOy+lQlWSlA5ECi+I2gDsVolLCFhm2
alpddEMw9Jv/YHQJsSEekBZtxSSPXGaIY/RPzH3yEkxAEIsBn9qpyK7ylRvPnQXr
ST50oGhb5VYsZRyCflPaVtlGF3mSRcQQNghSKRfLL6byftRpJIoej7BzDcwcSquy
qu2nkWMBZCKoMrh+MiizZ3MtkbTcMQEL90cKpvHXSu1WYMQsCKN7QLC8dCdSh9a+
iN03ioluZ4gd9cldoP62qzqA1xqXPBc2IkEerE3Vg+Y8OL1PMOlUqdO2BMMydmG7
sBjFKxizwIDVt5WwXlFNIvzsWKro2JS0pS7tkt7nGHwhV91VY/e/bc0f0qZ3KHDH
4ls6WwjSW07IAJaz4YM2r4YKZVx09ursemp0oPBL7u+Uo6xQ8oft1zowg8n7fVe+
5eP4QcrlZK6zo+xY7IWazO+56vNWGLlcc5qvxXcXg1nbNxoYclSlQdK2I3WjQ5rl
d3yWebdBjb/s3ICgn9F3dVhfNRPgJRpnC33OJfoHCuRhIdjUHOUHxjaZ9JbQxhX+
Ts3Xroud2xb9BMaSvdSI5qmjqrv3ZDg7X8wM0DW+dBkDpsWqTKJhNoI+HfMrvJdd
20t4Oy31O+9gI+j17AsjNpWvmGa/U9N7uGlKKpZmacSUxvRfbqyYeIiABlyisu2i
-----END CERTIFICATE-----

Click/Nodle Root
-----BEGIN CERTIFICATE-----
MIICHDCCAaGgAwIBAgITEkGhSPCEEtphvbOmfJRJGv/f3TAKBggqhkjOPQQDAzA9
MR0wGwYDVQQKExRDb250ZW50U2lnbiBieSBOb2RsZTEcMBoGA1UEAxMTQ29udGVu
dFNpZ24gUm9vdCBDQTAeFw0yMzExMjAyMzIzMzJaFw0zMzExMTcyMzIzMzFaMD0x
HTAbBgNVBAoTFENvbnRlbnRTaWduIGJ5IE5vZGxlMRwwGgYDVQQDExNDb250ZW50
U2lnbiBSb290IENBMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEKKjUvBHg3eBRpS38
LIuBZ4kfP/pfQw2CzsgT95JqZBrPnlkYvTcEg7tIEriPgVHLC5pXHMSbbQFIYEJ8
YLXHY335sBmhnomZFDM1yqN0P3PK/cfsMKIZ5aIkAhD93fqGo2MwYTAOBgNVHQ8B
Af8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUDK+bQAU+9IPexRNP
ElBJtbIbSRIwHwYDVR0jBBgwFoAUDK+bQAU+9IPexRNPElBJtbIbSRIwCgYIKoZI
zj0EAwMDaQAwZgIxAI6PtQ946M7E9Ex4fFb9djgYIbVqJ8Em4ywOFddNAR6DvD8D
u0ZmTtCWBQqWvFxG4gIxAM7eUjCRqT6YLjbsD7eB6k3VPdm46erzQd/Cad820I2E
ThMCsJUSjNKONkZH/JuQJA==
-----END CERTIFICATE-----

Samsung Root
-----BEGIN CERTIFICATE-----
MIICjzCCAfCgAwIBAgIEXHYjDTAKBggqhkjOPQQDBDBZMQswCQYDVQQGEwJLUjET
MBEGA1UEBxMKU3V3b24gY2l0eTEXMBUGA1UECxMOU2Ftc3VuZyBNb2JpbGUxHDAa
BgNVBAMTE1NhbXN1bmcgY29ycG9yYXRpb24wHhcNMTkwMjI3MDU0MTMzWhcNMzkw
MjIyMDU0MTMzWjBZMQswCQYDVQQGEwJLUjETMBEGA1UEBxMKU3V3b24gY2l0eTEX
MBUGA1UECxMOU2Ftc3VuZyBNb2JpbGUxHDAaBgNVBAMTE1NhbXN1bmcgY29ycG9y
YXRpb24wgZswEAYHKoZIzj0CAQYFK4EEACMDgYYABAGFsa4uumqXkjZYmasTmQRV
k6j52ADjqYqtUl/+yDN/Oza7sz1zVj1mQISKJiSFMUT289tqyZR9fJvCBnYQzfQD
UAE93XbifclsQN+wH/CcwfUByCwnIkU9sRNmLLjYWHCL7YEIDltwd7tKt2REhhKx
0FFooGhmxqnEHSAA6zSNI9Ffk6NjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8B
Af8EBAMCAQYwHQYDVR0OBBYEFGbsTn+ECfTAKlYSkIP+hkA01S7/MB8GA1UdIwQY
MBaAFGbsTn+ECfTAKlYSkIP+hkA01S7/MAoGCCqGSM49BAMEA4GMADCBiAJCAeGM
gCL5SfTUycZWd+37+cQIFSn5E1AzLIDw1ps1heoWoTj0dM9SPmWBo/TlWZrbtD4G
yH2VI7vz3wkpB9W7oT9RAkIAluAfQFNEqCoYndVEyGhu5RjG412BQdNbh8Y5NzZy
mu4/Zg7pC0ctus6hdJ8J5DjekOEh6tTy8poqNYC+wvHgAJg=
-----END CERTIFICATE-----

Metaphysic PRO
-----BEGIN CERTIFICATE-----
MIICEzCCAbmgAwIBAgIUVIrV56rbRKoLP81rfblb/2mrQPkwCgYIKoZIzj0EAwIw
WjELMAkGA1UEBhMCR0IxFzAVBgNVBAoMDk1ldGFwaHlzaWMgUFJPMRcwFQYDVQQL
DA5NZXRhcGh5c2ljIFBSTzEZMBcGA1UEAwwQTWV0YXBoeXNpY1Jvb3RDQTAeFw0y
NDA5MDMxMDM4NTBaFw0zNDA5MDExMDM4NTBaMFoxCzAJBgNVBAYTAkdCMRcwFQYD
VQQKDA5NZXRhcGh5c2ljIFBSTzEXMBUGA1UECwwOTWV0YXBoeXNpYyBQUk8xGTAX
BgNVBAMMEE1ldGFwaHlzaWNSb290Q0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAQeOqzGfyAbOjAM4Mf7xeWppTYdolsa7w4BKbXVrBtY5lS4lWrDR3m5JzB31BlL
hR+3pq0AmtdVMz9heQgHD5rRo10wWzAdBgNVHQ4EFgQUC+M9/xDkKCtSA7GVwbFG
YFEH3aowHwYDVR0jBBgwFoAUC+M9/xDkKCtSA7GVwbFGYFEH3aowDAYDVR0TBAUw
AwEB/zALBgNVHQ8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIgPb9+Evw000uDjMQg
3TeRvzhl8+B+03OG5WoyyjZvb90CIQCTDCIltIkUr0/EYTJf6VLKM7mBAZlWX4s2
Bz3E79YeEQ==
-----END CERTIFICATE-----

Canon Inc.
-----BEGIN CERTIFICATE-----
MIICBzCCAaygAwIBAgIUapyBGpjTU7rmwk5Y6gO5m3d2hBYwCgYIKoZIzj0EAwIw
YDELMAkGA1UEBhMCSlAxDjAMBgNVBAgTBVRva3lvMQ8wDQYDVQQHEwZPdGEta3Ux
EzARBgNVBAoTCkNhbm9uIEluYy4xGzAZBgNVBAMTEkNhbm9uIEMyUEEgUm9vdCBD
QTAgFw0yNDEwMTcwNzI1MDZaGA8yMDY0MTAxNjA3MjIxM1owYDELMAkGA1UEBhMC
SlAxDjAMBgNVBAgTBVRva3lvMQ8wDQYDVQQHEwZPdGEta3UxEzARBgNVBAoTCkNh
bm9uIEluYy4xGzAZBgNVBAMTEkNhbm9uIEMyUEEgUm9vdCBDQTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABFnVKwHeC+Cx3gDiLhatGQObilqx5huCx3iQ4dF98gsr
oT1fBIL3yUyWtXK4yt3yfYt/t1sUozjTWQboJiZKLvejQjBAMA8GA1UdEwEB/wQF
MAMBAf8wHQYDVR0OBBYEFNuSgKOKZTMu1E0kQKoSAICI5R7TMA4GA1UdDwEB/wQE
AwIBhjAKBggqhkjOPQQDAgNJADBGAiEA2GLR9KHDjO+0Wf9PKsTckmKeSzvz6cGh
54p6z6Z7lAECIQDx7lT/5ByzxTbYB36Pd6x+9eqkvM69QddPh+pRpvYk/A==
-----END CERTIFICATE-----

Fujifilm
-----BEGIN CERTIFICATE-----
MIIB4jCCAYegAwIBAgIRAI3b5qRoBIlWVln9WIRMnmMwCgYIKoZIzj0EAwIwTzEL
MAkGA1UEBhMCSlAxHTAbBgNVBAoMFEZVSklGSUxNIENvcnBvcmF0aW9uMSEwHwYD
VQQDDBhGVUpJRklMTSBDMlBBIFJvb3QgQ0EgRzEwIBcNMjQxMjA5MjI1ODQ3WhgP
MjA3NDEyMDkyMzU4MjBaME8xCzAJBgNVBAYTAkpQMR0wGwYDVQQKDBRGVUpJRklM
TSBDb3Jwb3JhdGlvbjEhMB8GA1UEAwwYRlVKSUZJTE0gQzJQQSBSb290IENBIEcx
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6Xo4h6qtgkxn+LAWDsDU5GSCHYjj
Zm4tHIEmmdyJrZCDYEyXfPhvSS09XKyXIDIEwQcdZU9gAsZdjNjP8cVva6NCMEAw
DwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUjBEQ4pKsJIoIJzI2jJqKQ+78Mfww
DgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA0kAMEYCIQDTnTnmnXrgRZpdDY9i
YlXwoF5tJpTaU30UFLUO9PdtpAIhAMoOjajOcuooANmO4ZSFobiaw6wGndE0BxyZ
ic3gTwMF
-----END CERTIFICATE-----

Pinterest
-----BEGIN CERTIFICATE-----
MIIF7DCCA9SgAwIBAgIJAMm9DzS6qm7hMA0GCSqGSIb3DQEBCwUAMIGCMQswCQYD
VQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMNU2FuIEZyYW5j
aXNjbzEXMBUGA1UEChMOUGludGVyZXN0IEluYy4xLTArBgNVBAMTJFBpbnRlcmVz
dCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eTAeFw0yNDA3MzEyMTMxMjRaFw0z
NDA4MDMyMTMxMjRaMIGCMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5p
YTEWMBQGA1UEBxMNU2FuIEZyYW5jaXNjbzEXMBUGA1UEChMOUGludGVyZXN0IElu
Yy4xLTArBgNVBAMTJFBpbnRlcmVzdCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0
eTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANlgMDVxsvPvDRA7m3oJ
vr7ZqRcJxHW/wOSQjcKEWLe4nAQS+vRfe19A+mT/jzPdmILS5HNp2hm6cXgsDlWK
nlHZzPYr5X4lBTATSjh+yjGfNOdeqmdSshi7fPo5FqhdpTfKFaDMrRx8+7YumQGI
fB1cxRMTYDQLD/rU5CZOkiPZzTgo5l6Obgo6WtfHsSBUZkXujLmA9w5B6pU2vj8/
8kxknUung5JJ/XEyO3nGBjVpvXfqGhy/UHnVuVDlIpqf8Xu3LJ3mVnDYlfBVb9AO
R8Fl3Le48k/AkeGWIZXgwoSVCd8UelwEv9AcROSOEe5nVM+5nEsk1symdiXnpHdp
GRTfvlpbzi02J4t7tjbdSnnA4uigioNskiD0armJU88luFAJPncQH/gy8SFN5XdT
NLJjauNduwkNwpfOcWEEqDxxTH+ErbCyvwb5+FBweZSlf23U5k1fLKcm7yW79o9E
uPBt9H5yaP2WvDrvIxIhhrtrvmVLqyPVfiNFe7DYnt0Z+BOk/eax8nC1SyjvAzrh
BUWKgbOb45YB3dn0XBmnCoiaMoq9GjmtUk1k1v5IUBgp8P8cVEMor2kX6PrEQGFA
H0wQSkSxGFAuemeY1t/dEI9paUc57uNdKvvN/CjElmytNvluYRwREAZTSjpd4ngz
z/gHxiiy8TlA7IZBaTCXEah3AgMBAAGjYzBhMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgGGMB0GA1UdDgQWBBQwHanMifxO2QnKWAP9FT8C+iGXozAfBgNV
HSMEGDAWgBQwHanMifxO2QnKWAP9FT8C+iGXozANBgkqhkiG9w0BAQsFAAOCAgEA
DxTjUe0RU6KoLvgYmXYMWJlhtJw3B0rEQYA7+ICHQPBPhElTyoHnSZQUBWIOqSWB
VjgYOvyX8E9EAVaHRBel4pQOn6b3chK50xm3psjGU7bZhf0DISMGlrHHLmxSU705
5JsYE0SOYuNTYp7rb9Rbbj1UTMI0PtAKIMVxWeWiEOoYWX78urQO9XD02OVHFSTI
HlKtA91mNrCO9I99pJeM9Shh485b5B9cSvOfvtTX8bdWHL8nFFWXjgrB4XnPsrKy
chTb5+4CxnIVps8x4bu8BGNu/NDck/+XrB1wvpPP/StIPY52ZVXvXzGXDUMvW91d
j7uRx6Te3sro0csNlhLMvZJRnk+VTvUB5/XsTAKZ4YlX2QZ3YuG/VWjt6NPtE5gQ
+QqksZUdhyRKoIY8kGk540PD+3UAgwHnbrPznNc0EoMBphe4oI9zKb6BB1tpivGy
vL6ZFIKcKPJSmtaB95tipnFkTTmJmgxY0bWD2GXnjS6w+EpMhdiXYWg+ALdGZwb0
B5JosgHQw2NGCZ9aVimITFynJUTOtFcXaO8MxsKdri0rNDp+dWsHlKtbQYaxolCC
M4YU9ykc8OCDySb4NwX7m59GDA0xELtiDyW4hGagAY+bzzUfigZY9jzuTCq2tkX5
s6SDrqImp50u2dqUUAfvBDHTNutzbhkxow+sQ+lfr4k=
-----END CERTIFICATE-----

ATOM
-----BEGIN CERTIFICATE-----
MIICmzCCAiCgAwIBAgIUAJqo+ansD9x4r/iaYV5AaQX5jQAwCgYIKoZIzj0EAwMw
fDELMAkGA1UEBhMCVVMxDjAMBgNVBAgTBVRleGFzMQ8wDQYDVQQHEwZBdXN0aW4x
GjAYBgNVBAoTEUFUT00gVGVjaG5vbG9naWVzMRYwFAYDVQQLEw1BVE9NIFNlY3Vy
aXR5MRgwFgYDVQQDEw9BVE9NIHJvb3QgQ0EgdjEwHhcNMjQwOTA5MTkwODM4WhcN
MzQwOTA3MTkwODM3WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECBMFVGV4YXMxDzAN
BgNVBAcTBkF1c3RpbjEaMBgGA1UEChMRQVRPTSBUZWNobm9sb2dpZXMxFjAUBgNV
BAsTDUFUT00gU2VjdXJpdHkxGDAWBgNVBAMTD0FUT00gcm9vdCBDQSB2MTB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABH0eAjxr8/wDSO6EfnE574peDRuGVRr0dTvnwoMl
MilfqJDPe873y3GmzOEj0nTGB/AHPNW1HOKePYoEaK51/66peq6JOxcVIUShQOwI
U1ZdCSIDbRD0kezWXn7P/9El1aNjMGEwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB
/wQFMAMBAf8wHQYDVR0OBBYEFI3x7N/TGB5W9WHtVnpPqyS0jRNXMB8GA1UdIwQY
MBaAFI3x7N/TGB5W9WHtVnpPqyS0jRNXMAoGCCqGSM49BAMDA2kAMGYCMQCZvUp0
2Zo8gDDMyC1gO+TMTNY6nfZ7XXH1SeV0BaVeBGJLhHnTWfpvkN23+/adwiMCMQD1
p6P/cqH4SNa2P/G0nzPn21Z8SblSfGelbA+EkQf9LyNi/v8o08i4oUrB1vhWbIc=
-----END CERTIFICATE-----

Trufo
-----BEGIN CERTIFICATE-----
MIIBmDCCAUqgAwIBAgIUYASaeSSTolrnAdi1g2Fbv7PDxJEwBQYDK2VwMEoxCzAJ
BgNVBAYTAlVTMREwDwYDVQQIDAhOZXcgWW9yazEVMBMGA1UECgwMVHJ1Zm8gKFJv
b3QpMREwDwYDVQQDDAh0cnVmby5haTAeFw0yNDA4MTIyMjE3MDdaFw0yNTA4MTIy
MjE3MDdaMEoxCzAJBgNVBAYTAlVTMREwDwYDVQQIDAhOZXcgWW9yazEVMBMGA1UE
CgwMVHJ1Zm8gKFJvb3QpMREwDwYDVQQDDAh0cnVmby5haTAqMAUGAytlcAMhABFI
CkU3vtCVG4D2VtxqAmQyKZROrBVEnFl8vpmg4CM+o0IwQDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwICBDAdBgNVHQ4EFgQUXa+ujzojES7nhreHkIzbDqeL
OLkwBQYDK2VwA0EALT8wJCiGqgBqVzWf6xvus5PwAhnGx8/U3/+NIl3uFO3fUhUt
2z62xjVd+G2ivv6AZ4VnCjou757WbNqsY3B5Aw==
-----END CERTIFICATE-----

vivo
-----BEGIN CERTIFICATE-----
MIICrjCCAhCgAwIBAgIJEJ5cSOlh/nYsMAoGCCqGSM49BAMEMHYxOTA3BgNVBAMM
MHZpdm8gQ29udGVudCBQcm92ZW5hbmNlIGFuZCBBdXRoZW50aWNpdHkgUm9vdCBD
QTELMAkGA1UEBhMCQ04xLDAqBgNVBAoMI3Zpdm8gTW9iaWxlIENvbW11bmljYXRp
b24gQ28uLCBMdGQuMCAXDTI1MDQxNjAyNTUzOFoYDzIwNTUwNDE2MDI1NTM4WjB2
MTkwNwYDVQQDDDB2aXZvIENvbnRlbnQgUHJvdmVuYW5jZSBhbmQgQXV0aGVudGlj
aXR5IFJvb3QgQ0ExCzAJBgNVBAYTAkNOMSwwKgYDVQQKDCN2aXZvIE1vYmlsZSBD
b21tdW5pY2F0aW9uIENvLiwgTHRkLjCBmzAQBgcqhkjOPQIBBgUrgQQAIwOBhgAE
AadjySUWxUJN7q9UtkC1169XLrnhqEcOfB3AAE+uQkehChJjR8mBcTAKCGpQHxem
0qxe13rlWj8scCWExoUy4j/eAUCU1rhA9nsaNmqZuQetemoaFsxB+uzFTan7eC2K
GGUTWyEEJsVpZRnzhV1HLKHJ+gEaRCeYkEkGcxRm6Yic6HzAo0IwQDAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUZMn3MXRQRGJUI+Jb
ij8quKQc5GEwCgYIKoZIzj0EAwQDgYsAMIGHAkE2v363BCPhkErUyhrBl5KzCrxy
dzCskvifOy2pj0DHPtE1R8iBMJL9L7SqLRiwWFtzKIDjHzrYva/XGZ3vstpcCgJC
ALYmHM4xMXsNqb1hiWIxi1gqm92ddR+PSbVIJygODlJPiDT0xPEro6kTP7GKaxpH
GQdAQ3jeFxZgws/1Fymnxrbq
-----END CERTIFICATE-----

Nikon
-----BEGIN CERTIFICATE-----
MIICIDCCAcagAwIBAgIUIvXHQ3rquXoskDjpVb+2YuMICyEwCgYIKoZIzj0EAwIw
bTELMAkGA1UEBhMCSlAxDjAMBgNVBAgTBVRva3lvMRUwEwYDVQQHEwxTaGluYWdh
d2Eta3UxGjAYBgNVBAoTEU5JS09OIENPUlBPUkFUSU9OMRswGQYDVQQDExJOaWtv
biBDMlBBIFJvb3QgQ0EwIBcNMjUwMzA2MDAyODQzWhgPMjA2NTAzMDUwMDI0MTFa
MG0xCzAJBgNVBAYTAkpQMQ4wDAYDVQQIEwVUb2t5bzEVMBMGA1UEBxMMU2hpbmFn
YXdhLWt1MRowGAYDVQQKExFOSUtPTiBDT1JQT1JBVElPTjEbMBkGA1UEAxMSTmlr
b24gQzJQQSBSb290IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9wzVICOz
P8cseW53DEbdqyO7BG4FWYWilujIo0csh+3uSmSJGYdg0PBa261uIxj4CO5Q2Ks5
AM4j843TRAIRCqNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUgrs99zxZ
Shz1QQTOPfUnnro4LFcwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA0gAMEUC
IQCGT6MDGYwqq1/jM6urTcKH+pIJqOLtoc0+cALTYX+hcwIgI+Iue20LU7DAUf64
lhrU52JWzJ2F0/nHEwxKCR/p92Y=
-----END CERTIFICATE-----

Sony
-----BEGIN CERTIFICATE-----
MIICNTCCAbugAwIBAgIUczN9H4VpMZo+I4l+f4pDY6JMAOcwCgYIKoZIzj0EAwMw
RzELMAkGA1UEBhMCSlAxGTAXBgNVBAoMEFNPTlkgQ29ycG9yYXRpb24xHTAbBgNV
BAMMFFNPTlkgQzJQQSBSb290IENBIEcyMCAXDTI1MDgwNDAzNTMzM1oYDzIwNjUw
NzI1MDM1MzMyWjBHMQswCQYDVQQGEwJKUDEZMBcGA1UECgwQU09OWSBDb3Jwb3Jh
dGlvbjEdMBsGA1UEAwwUU09OWSBDMlBBIFJvb3QgQ0EgRzIwdjAQBgcqhkjOPQIB
BgUrgQQAIgNiAASLHbxrLtoC+469rNSLnkJjSacR0SFSseGs1teFY8gG5cVVy93Z
qoupA5QMR49indgIC3wqXZAP9aJqVCpUyQL2QN9gHndDpH5JRnmJH9zxXjWq21dD
Lfs8rpNEiJT9XkGjZjBkMBIGA1UdEwEB/wQIMAYBAf8CAQIwHwYDVR0jBBgwFoAU
yhnK7M21f7YIRJTDHYremJuCpkwwHQYDVR0OBBYEFMoZyuzNtX+2CESUwx2K3pib
gqZMMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAwNoADBlAjAZKmS4lqMFBW+Q
sJqQTp66xIHP9WwEU34ig6ckz9x/Je3TNbrN90FLaHTxDCQXJuECMQDJ0IO8tfPK
ZerQ8KDvnksbA35Pb2DGcPqtgxqw29DNbJhxu5o4Mna89A991qyPF6g=
-----END CERTIFICATE-----

Digicert Trusted Timestamp Sha256 CA
-----BEGIN CERTIFICATE-----
MIIGrjCCBJagAwIBAgIQBzY3tyRUfNhHrP0oZipeWzANBgkqhkiG9w0BAQsFADBi
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3Qg
RzQwHhcNMjIwMzIzMDAwMDAwWhcNMzcwMzIyMjM1OTU5WjBjMQswCQYDVQQGEwJV
UzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xOzA5BgNVBAMTMkRpZ2lDZXJ0IFRy
dXN0ZWQgRzQgUlNBNDA5NiBTSEEyNTYgVGltZVN0YW1waW5nIENBMIICIjANBgkq
hkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAxoY1BkmzwT1ySVFVxyUDxPKRN6mXUaHW
0oPRnkyibaCwzIP5WvYRoUQVQl+kiPNo+n3znIkLf50fng8zH1ATCyZzlm34V6gC
ff1DtITaEfFzsbPuK4CEiiIY3+vaPcQXf6sZKz5C3GeO6lE98NZW1OcoLevTsbV1
5x8GZY2UKdPZ7Gnf2ZCHRgB720RBidx8ald68Dd5n12sy+iEZLRS8nZH92GDGd1f
tFQLIWhuNyG7QKxfst5Kfc71ORJn7w6lY2zkpsUdzTYNXNXmG6jBZHRAp8ByxbpO
H7G1WE15/tePc5OsLDnipUjW8LAxE6lXKZYnLvWHpo9OdhVVJnCYJn+gGkcgQ+ND
Y4B7dW4nJZCYOjgRs/b2nuY7W+yB3iIU2YIqx5K/oN7jPqJz+ucfWmyU8lKVEStY
dEAoq3NDzt9KoRxrOMUp88qqlnNCaJ+2RrOdOqPVA+C/8KI8ykLcGEh/FDTP0kyr
75s9/g64ZCr6dSgkQe1CvwWcZklSUPRR8zZJTYsg0ixXNXkrqPNFYLwjjVj33GHe
k/45wPmyMKVM1+mYSlg+0wOI/rOP015LdhJRk8mMDDtbiiKowSYI+RQQEgN9XyO7
ZONj4KbhPvbCdLI/Hgl27KtdRnXiYKNYCQEoAA6EVO7O6V3IXjASvUaetdN2udIO
a5kM0jO0zbECAwEAAaOCAV0wggFZMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0O
BBYEFLoW2W1NhS9zKXaaL3WMaiCPnshvMB8GA1UdIwQYMBaAFOzX44LScV1kTN8u
Zz/nupiuHA9PMA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDCDB3
BggrBgEFBQcBAQRrMGkwJAYIKwYBBQUHMAGGGGh0dHA6Ly9vY3NwLmRpZ2ljZXJ0
LmNvbTBBBggrBgEFBQcwAoY1aHR0cDovL2NhY2VydHMuZGlnaWNlcnQuY29tL0Rp
Z2lDZXJ0VHJ1c3RlZFJvb3RHNC5jcnQwQwYDVR0fBDwwOjA4oDagNIYyaHR0cDov
L2NybDMuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0VHJ1c3RlZFJvb3RHNC5jcmwwIAYD
VR0gBBkwFzAIBgZngQwBBAIwCwYJYIZIAYb9bAcBMA0GCSqGSIb3DQEBCwUAA4IC
AQB9WY7Ak7ZvmKlEIgF+ZtbYIULhsBguEE0TzzBTzr8Y+8dQXeJLKftwig2qKWn8
acHPHQfpPmDI2AvlXFvXbYf6hCAlNDFnzbYSlm/EUExiHQwIgqgWvalWzxVzjQEi
Jc6VaT9Hd/tydBTX/6tPiix6q4XNQ1/tYLaqT5Fmniye4Iqs5f2MvGQmh2ySvZ18
0HAKfO+ovHVPulr3qRCyXen/KFSJ8NWKcXZl2szwcqMj+sAngkSumScbqyQeJsG3
3irr9p6xeZmBo1aGqwpFyd/EjaDnmPv7pp1yr8THwcFqcdnGE4AJxLafzYeHJLtP
o0m5d2aR8XKc6UsCUqc3fpNTrDsdCEkPlM05et3/JWOZJyw9P2un8WbDQc1PtkCb
ISFA0LcTJM3cHXg65J6t5TRxktcma+Q4c6umAU+9Pzt4rUyt+8SVe+0KXzM5h0F4
ejjpnOHdI/0dKNPH+ejxmF/7K9h+8kaddSweJywm228Vex4Ziza4k9Tm8heZWcpw
8De/mADfIBZPJ/tgZxahZrrdVcA6KYawmKAr7ZVBtzrVFZgxtGIJDwq9gdkT/r+k
0fNX2bwE+oLeMt8EifAAzV3C+dAjfwAL5HYCJtnwZXZCpimHCUcr5n8apIUP/JiW
9lVUKx+A+sDyDivl1vupL0QVSucTDh3bNzgaoSv27dZ8/A==
-----END CERTIFICATE-----

-----BEGIN CERTIFICATE-----
MIIGtDCCBJygAwIBAgIQDcesVwX/IZkuQEMiDDpJhjANBgkqhkiG9w0BAQsFADBi
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3Qg
RzQwHhcNMjUwNTA3MDAwMDAwWhcNMzgwMTE0MjM1OTU5WjBpMQswCQYDVQQGEwJV
UzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xQTA/BgNVBAMTOERpZ2lDZXJ0IFRy
dXN0ZWQgRzQgVGltZVN0YW1waW5nIFJTQTQwOTYgU0hBMjU2IDIwMjUgQ0ExMIIC
IjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtHgx0wqYQXK+PEbAHKx126NG
aHS0URedTa2NDZS1mZaDLFTtQ2oRjzUXMmxCqvkbsDpz4aH+qbxeLho8I6jY3xL1
IusLopuW2qftJYJaDNs1+JH7Z+QdSKWM06qchUP+AbdJgMQB3h2DZ0Mal5kYp77j
YMVQXSZH++0trj6Ao+xh/AS7sQRuQL37QXbDhAktVJMQbzIBHYJBYgzWIjk8eDrY
hXDEpKk7RdoX0M980EpLtlrNyHw0Xm+nt5pnYJU3Gmq6bNMI1I7Gb5IBZK4ivbVC
iZv7PNBYqHEpNVWC2ZQ8BbfnFRQVESYOszFI2Wv82wnJRfN20VRS3hpLgIR4hjzL
0hpoYGk81coWJ+KdPvMvaB0WkE/2qHxJ0ucS638ZxqU14lDnki7CcoKCz6eum5A1
9WZQHkqUJfdkDjHkccpL6uoG8pbF0LJAQQZxst7VvwDDjAmSFTUms+wV/FbWBqi7
fTJnjq3hj0XbQcd8hjj/q8d6ylgxCZSKi17yVp2NL+cnT6Toy+rN+nM8M7LnLqCr
O2JP3oW//1sfuZDKiDEb1AQ8es9Xr/u6bDTnYCTKIsDq1BtmXUqEG1NqzJKS4kOm
xkYp2WyODi7vQTCBZtVFJfVZ3j7OgWmnhFr4yUozZtqgPrHRVHhGNKlYzyjlroPx
ul+bgIspzOwbtmsgY1MCAwEAAaOCAV0wggFZMBIGA1UdEwEB/wQIMAYBAf8CAQAw
HQYDVR0OBBYEFO9vU0rp5AZ8esrikFb2L9RJ7MtOMB8GA1UdIwQYMBaAFOzX44LS
cV1kTN8uZz/nupiuHA9PMA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEF
BQcDCDB3BggrBgEFBQcBAQRrMGkwJAYIKwYBBQUHMAGGGGh0dHA6Ly9vY3NwLmRp
Z2ljZXJ0LmNvbTBBBggrBgEFBQcwAoY1aHR0cDovL2NhY2VydHMuZGlnaWNlcnQu
Y29tL0RpZ2lDZXJ0VHJ1c3RlZFJvb3RHNC5jcnQwQwYDVR0fBDwwOjA4oDagNIYy
aHR0cDovL2NybDMuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0VHJ1c3RlZFJvb3RHNC5j
cmwwIAYDVR0gBBkwFzAIBgZngQwBBAIwCwYJYIZIAYb9bAcBMA0GCSqGSIb3DQEB
CwUAA4ICAQAXzvsWgBz+Bz0RdnEwvb4LyLU0pn/N0IfFiBowf0/Dm1wGc/Do7oVM
Y2mhXZXjDNJQa8j00DNqhCT3t+s8G0iP5kvN2n7Jd2E4/iEIUBO41P5F448rSYJ5
9Ib61eoalhnd6ywFLerycvZTAz40y8S4F3/a+Z1jEMK/DMm/axFSgoR8n6c3nuZB
9BfBwAQYK9FHaoq2e26MHvVY9gCDA/JYsq7pGdogP8HRtrYfctSLANEBfHU16r3J
05qX3kId+ZOczgj5kjatVB+NdADVZKON/gnZruMvNYY2o1f4MXRJDMdTSlOLh0HC
n2cQLwQCqjFbqrXuvTPSegOOzr4EWj7PtspIHBldNE2K9i697cvaiIo2p61Ed2p8
xMJb82Yosn0z4y25xUbI7GIN/TpVfHIqQ6Ku/qjTY6hc3hsXMrS+U0yy+GWqAXam
4ToWd2UQ1KYT70kZjE4YtL8Pbzg0c1ugMZyZZd/BdHLiRu7hAWE6bTEm4XYRkA6T
l4KSFLFk43esaUeqGkH/wyW4N7OigizwJWeukcyIPbAvjSabnf7+Pu0VrFgoiovR
Diyx3zEdmcif/sYQsfch28bZeUz2rtY/9TCA6TD8dC3JE3rYkrhLULy7Dc90G6e8
BlqmyIjlgp2+VqsS9/wQD7yFylIz0scmbKvFoW2jNrbM1pD2T7m3XA==
-----END CERTIFICATE-----

Cybertrust
-----BEGIN CERTIFICATE-----
MIICjDCCAhGgAwIBAgIUKS9xW5O7D2rrjSeBl+MynP8pF0owCgYIKoZIzj0EAwMw
czELMAkGA1UEBhMCSlAxIzAhBgNVBAoTGkN5YmVydHJ1c3QgSmFwYW4gQ28uLCBM
dGQuMT8wPQYDVQQDEzZDeWJlcnRydXN0IGlUcnVzdCBDMlBBIFJvb3QgQ2VydGlm
aWNhdGlvbiBBdXRob3JpdHkgRzEwHhcNMjUwNzMwMDUxMzQ1WhcNNDAwNzI0MDUx
MzQ1WjBzMQswCQYDVQQGEwJKUDEjMCEGA1UEChMaQ3liZXJ0cnVzdCBKYXBhbiBD
by4sIEx0ZC4xPzA9BgNVBAMTNkN5YmVydHJ1c3QgaVRydXN0IEMyUEEgUm9vdCBD
ZXJ0aWZpY2F0aW9uIEF1dGhvcml0eSBHMTB2MBAGByqGSM49AgEGBSuBBAAiA2IA
BDB8+JiYghpSphkIz5RriMmGcPKuPwY1OizPf+hGz2IahGdyIZWLZc/lFzGpBKUF
ba8rbL9RbYbQIC/3/X1K91v3WrX4aC0X3Uixjr4GRfA+tYBIuPKSITvHiAe++wR6
2KNmMGQwEgYDVR0TAQH/BAgwBgEB/wIBAjAOBgNVHQ8BAf8EBAMCAQYwHwYDVR0j
BBgwFoAU/+TJjy4pArwGGk2IJUY8z/Vq7yQwHQYDVR0OBBYEFP/kyY8uKQK8BhpN
iCVGPM/1au8kMAoGCCqGSM49BAMDA2kAMGYCMQCLfT3mtiiNRkHTpnDgPGjjjuZj
aeyWkVI2COOpC1FnKptXLbrjjIQnq40K4pfZtyECMQDW/GoK9UT+8hsccKPl35IB
0EkJAzKgs8AzqaV0lV2PjfJEo2rXqIsSk7SLcPfNTu0=
-----END CERTIFICATE-----

Bria.ai
-----BEGIN CERTIFICATE-----
MIICnTCCAf6gAwIBAgIRAPvDTK/w7D6vl0WjbhX93q0wCgYIKoZIzj0EAwQwaDEL
MAkGA1UEBhMCSUwxJTAjBgNVBAoMHEJyaWEgQXJ0aWZpY2lhbCBJbnRlbGxpZ2Vu
Y2UxMjAwBgNVBAMMKUJyaWEgQXJ0aWZpY2lhbCBJbnRlbGxpZ2VuY2UgQzJQQSBS
b290IENBMB4XDTI1MDgxMzA5NDQwMFoXDTQ1MDgxMzEwNDQwMFowaDELMAkGA1UE
BhMCSUwxJTAjBgNVBAoMHEJyaWEgQXJ0aWZpY2lhbCBJbnRlbGxpZ2VuY2UxMjAw
BgNVBAMMKUJyaWEgQXJ0aWZpY2lhbCBJbnRlbGxpZ2VuY2UgQzJQQSBSb290IENB
MIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBm4KD4uRHzKuT9K5+60mkCmRZtvOV
oPFxqOgnzeIymEL1gcwMSLilogpDGvlCdp3AxlSu85dRH/J7HvtuYwX9pLIBbo6O
1UqbwSqI4NnC78YQN+OFEY1oQFGYga3GnqHmqGc3zVpFCkEOok0Om0vxIE1mBp7f
hFwBzkWQZjgp15+K2uWjRjBEMBIGA1UdEwEB/wQIMAYBAf8CAQEwHQYDVR0OBBYE
FDeC4ZhoAbBHTfS6DUU4N/8h/rifMA8GA1UdDwEB/wQFAwMHBgAwCgYIKoZIzj0E
AwQDgYwAMIGIAkIBScJ6SavNV7yjqsWuyaLCAQL9jrrD7Yv9aqO5EPf+MmcfT8ZM
4n5rqQluxv4ieJ6Jeo0YsbkWYdRiUUlnFuEdbPkCQgFR42wDXEjulMA7mwMjKyBs
Y8Iz2SQmZKEG5OUOEDlDUoxOworLQ9dywuycjdMDWjfMZHaLMeGGofeAqAOLmreB
Qg==
-----END CERTIFICATE-----

DigiCert Trusted G4 Timestamping RSA4096 SHA256 2025 CAI
-----BEGIN CERTIFICATE-----
MIIGtDCCBJygAwIBAgIQDcesVwX/IZkuQEMiDDpJhjANBgkqhkiG9w0BAQsFADBi
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3Qg
RzQwHhcNMjUwNTA3MDAwMDAwWhcNMzgwMTE0MjM1OTU5WjBpMQswCQYDVQQGEwJV
UzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xQTA/BgNVBAMTOERpZ2lDZXJ0IFRy
dXN0ZWQgRzQgVGltZVN0YW1waW5nIFJTQTQwOTYgU0hBMjU2IDIwMjUgQ0ExMIIC
IjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtHgx0wqYQXK+PEbAHKx126NG
aHS0URedTa2NDZS1mZaDLFTtQ2oRjzUXMmxCqvkbsDpz4aH+qbxeLho8I6jY3xL1
IusLopuW2qftJYJaDNs1+JH7Z+QdSKWM06qchUP+AbdJgMQB3h2DZ0Mal5kYp77j
YMVQXSZH++0trj6Ao+xh/AS7sQRuQL37QXbDhAktVJMQbzIBHYJBYgzWIjk8eDrY
hXDEpKk7RdoX0M980EpLtlrNyHw0Xm+nt5pnYJU3Gmq6bNMI1I7Gb5IBZK4ivbVC
iZv7PNBYqHEpNVWC2ZQ8BbfnFRQVESYOszFI2Wv82wnJRfN20VRS3hpLgIR4hjzL
0hpoYGk81coWJ+KdPvMvaB0WkE/2qHxJ0ucS638ZxqU14lDnki7CcoKCz6eum5A1
9WZQHkqUJfdkDjHkccpL6uoG8pbF0LJAQQZxst7VvwDDjAmSFTUms+wV/FbWBqi7
fTJnjq3hj0XbQcd8hjj/q8d6ylgxCZSKi17yVp2NL+cnT6Toy+rN+nM8M7LnLqCr
O2JP3oW//1sfuZDKiDEb1AQ8es9Xr/u6bDTnYCTKIsDq1BtmXUqEG1NqzJKS4kOm
xkYp2WyODi7vQTCBZtVFJfVZ3j7OgWmnhFr4yUozZtqgPrHRVHhGNKlYzyjlroPx
ul+bgIspzOwbtmsgY1MCAwEAAaOCAV0wggFZMBIGA1UdEwEB/wQIMAYBAf8CAQAw
HQYDVR0OBBYEFO9vU0rp5AZ8esrikFb2L9RJ7MtOMB8GA1UdIwQYMBaAFOzX44LS
cV1kTN8uZz/nupiuHA9PMA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEF
BQcDCDB3BggrBgEFBQcBAQRrMGkwJAYIKwYBBQUHMAGGGGh0dHA6Ly9vY3NwLmRp
Z2ljZXJ0LmNvbTBBBggrBgEFBQcwAoY1aHR0cDovL2NhY2VydHMuZGlnaWNlcnQu
Y29tL0RpZ2lDZXJ0VHJ1c3RlZFJvb3RHNC5jcnQwQwYDVR0fBDwwOjA4oDagNIYy
aHR0cDovL2NybDMuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0VHJ1c3RlZFJvb3RHNC5j
cmwwIAYDVR0gBBkwFzAIBgZngQwBBAIwCwYJYIZIAYb9bAcBMA0GCSqGSIb3DQEB
CwUAA4ICAQAXzvsWgBz+Bz0RdnEwvb4LyLU0pn/N0IfFiBowf0/Dm1wGc/Do7oVM
Y2mhXZXjDNJQa8j00DNqhCT3t+s8G0iP5kvN2n7Jd2E4/iEIUBO41P5F448rSYJ5
9Ib61eoalhnd6ywFLerycvZTAz40y8S4F3/a+Z1jEMK/DMm/axFSgoR8n6c3nuZB
9BfBwAQYK9FHaoq2e26MHvVY9gCDA/JYsq7pGdogP8HRtrYfctSLANEBfHU16r3J
05qX3kId+ZOczgj5kjatVB+NdADVZKON/gnZruMvNYY2o1f4MXRJDMdTSlOLh0HC
n2cQLwQCqjFbqrXuvTPSegOOzr4EWj7PtspIHBldNE2K9i697cvaiIo2p61Ed2p8
xMJb82Yosn0z4y25xUbI7GIN/TpVfHIqQ6Ku/qjTY6hc3hsXMrS+U0yy+GWqAXam
4ToWd2UQ1KYT70kZjE4YtL8Pbzg0c1ugMZyZZd/BdHLiRu7hAWE6bTEm4XYRkA6T
l4KSFLFk43esaUeqGkH/wyW4N7OigizwJWeukcyIPbAvjSabnf7+Pu0VrFgoiovR
Diyx3zEdmcif/sYQsfch28bZeUz2rtY/9TCA6TD8dC3JE3rYkrhLULy7Dc90G6e8
BlqmyIjlgp2+VqsS9/wQD7yFylIz0scmbKvFoW2jNrbM1pD2T7m3XA==
-----END CERTIFICATE-----

GlobalSign R45 AATL TimeStamping Root CA 2021
-----BEGIN CERTIFICATE-----
MIIG3DCCBMSgAwIBAgIQebn/cy+pQ5Sn2ln1CsvVmjANBgkqhkiG9w0BAQwFADBT
MQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2lnbiBudi1zYTEpMCcGA1UE
AxMgR2xvYmFsU2lnbiBUaW1lc3RhbXBpbmcgUm9vdCBSNDUwHhcNMjEwNTE5MDAw
MDAwWhcNMzgwNTE4MjM1OTU5WjBgMQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xv
YmFsU2lnbiBudi1zYTE2MDQGA1UEAxMtR2xvYmFsU2lnbiBSNDUgQUFUTCBUaW1l
U3RhbXBpbmcgUm9vdCBDQSAyMDIxMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIIC
CgKCAgEAych7DZaDMRQPKpfVMEOYILf7NPpYOmm9doM7wLPoj4YrflMiBe+2wh2W
rXj4s5bXRun9jY+tc0bO/wNe4c4RRReWHm0jlGqNVEDWaXqFIS//z741eOR8Ji3D
8dpKJgVtCzV2AA25WecnILMZwe12sDHrxWtsCGmES7MLfXbgycrpT/c3DXb9h7tY
RBS3AMj1uT1yV+hKWgUGyhJPfIP6/lZSVsnjx4iNX3291d5ilZdGJ+6BAErsiKDt
plj3qESUuCY1VN26vTYnU2DUeKvEzLuvB17NjpYfs085dAzUIdIqXPz+TWhEJcDt
2F2M+6cuSRXYgjffqWFTFctybmXqQAUHTL1mHWVCiqxo7hl4oXc+vSOsIgHARa4N
j22YikT7lTnzfKG7/9zGPs9rINvwLGDEaTDc7/cLTu2D8qmKWKRel6vFBXjd/p7e
R61LG8Yy8fpnMirrjein9mF8Fbtf6jcV14ot1W5q0ia6aLmmHekAj1D64EpGaaYm
/xX/690IDYvWLSv6iBWly3bRudxCMEd5lB/aavYzEmng3Rx+YrzLw7FmpMvb6xIo
QuYnFYmajRREBB4/x0lg5ENX/jnFgK1IKP9lWIzgkuLST0zb5HTTb8E4dIGTdFJe
Ji61R/nqde+gruJhcDEOSC+K6Sgkie50JUzKO+dBaPilgmQoHOMCAwEAAaOCAZ0w
ggGZMA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDCDASBgNVHRMB
Af8ECDAGAQH/AgEAMB0GA1UdDgQWBBTI2NPuw6KaC8Z0KTukom3nj+rlxTAfBgNV
HSMEGDAWgBRGshx34XsV8KU5oXDe0cQu6m2y3jCBjgYIKwYBBQUHAQEEgYEwfzA3
BggrBgEFBQcwAYYraHR0cDovL29jc3AuZ2xvYmFsc2lnbi5jb20vdGltZXN0YW1w
cm9vdHI0NTBEBggrBgEFBQcwAoY4aHR0cDovL3NlY3VyZS5nbG9iYWxzaWduLmNv
bS9jYWNlcnQvdGltZXN0YW1wcm9vdHI0NS5jcnQwPwYDVR0fBDgwNjA0oDKgMIYu
aHR0cDovL2NybC5nbG9iYWxzaWduLmNvbS90aW1lc3RhbXByb290cjQ1LmNybDBM
BgNVHSAERTBDMEEGCSsGAQQBoDIBHzA0MDIGCCsGAQUFBwIBFiZodHRwczovL3d3
dy5nbG9iYWxzaWduLmNvbS9yZXBvc2l0b3J5LzANBgkqhkiG9w0BAQwFAAOCAgEA
mA1ofXMAeG3hXva+VK+Rboe556ZETrNki6dZ7zXyklvW1HERbWzsJIHgoQ0E8WVB
JQM1eafsXF+bk70mXHKf6WLTE00WUUHcgIQFxID0E9wNXhfbWzVjjgWiMESVwmK2
U292CUIiS996wkwfHGdnM/Zdyx5gX2diEeAFMBP8Q5tS19AWzWj7QwTwIJ2zfDdt
szdl+d08myBFfTK3RRwLVft8vK6jYgBs8mEq6eN576Vjsyy4e4vk+HWmQJDywnf+
szpCWS1OLcGdsh4jFVbOHgG+BzBcZ6PC73DKNXmjD7Olz4rvuB7SdIRihPkxn6Cw
31Q8oceJ9Hct/+w624fEyOC/IxH4OQH4bkXoio67HNjIP+NcmAUfShFMn6iLeU4d
sPYLPep4JF7R56E9OiLNs9w6I4mrCyz2SA5kDAsmvA78mR38pt9wfz0EtrWpvco1
OM0gVo3ZoW6G9rcfeFvLqTDHv2oXwndJQTM/sqtunZJYG1kYIe1vmqIbzUhXFNiN
Qk02Al7kcQkP04I1iCgKb2WbuTiqFJyEmc+MK3dCHegogA/ghDF6PXOCNhaYGwnz
G0ill4psyi682cWZQAh81M1esRBAN8Tzr322rqfZlZqrFw12XwuF0NY/Bot25sCQ
1VgmfeJHKFHbwB87c6Mld32QUOo0MF7QzshvQOrA4AA=
-----END CERTIFICATE-----

GlobalSign Timestamping CA - SHA384 - G4
-----BEGIN CERTIFICATE-----
MIIGWTCCBEGgAwIBAgINAewckkDe/S5AXXxHdDANBgkqhkiG9w0BAQwFADBMMSAw
HgYDVQQLExdHbG9iYWxTaWduIFJvb3QgQ0EgLSBSNjETMBEGA1UEChMKR2xvYmFs
U2lnbjETMBEGA1UEAxMKR2xvYmFsU2lnbjAeFw0xODA2MjAwMDAwMDBaFw0zNDEy
MTAwMDAwMDBaMFsxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52
LXNhMTEwLwYDVQQDEyhHbG9iYWxTaWduIFRpbWVzdGFtcGluZyBDQSAtIFNIQTM4
NCAtIEc0MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA8ALiMCP64Bvh
mnSzr3WDX6lHUsdhOmN8OSN5bXT8MeR0EhmW+s4nYluuB4on7lejxDXtszTHrMMM
64BmbdEoSsEsu7lw8nKujPeZWl12rr9EqHxBJI6PusVP/zZBq6ct/XhOQ4j+kxkX
2e4xz7yKO25qxIjw7pf23PMYoEuZHA6HpybhiMmg5ZninvScTD9dW+y279Jlz0UL
VD2xVFMHi5luuFSZiqgxkjvyen38DljfgWrhsGweZYIq1CHHlP5CljvxC7F/f0aY
Doc9emXr0VapLr37WD21hfpTmU1bdO1yS6INgjcZDNCr6lrB7w/Vmbk/9E818ZwP
0zcTUtklNO2W7/hn6gi+j0l6/5Cx1PcpFdf5DV3Wh0MedMRwKLSAe70qm7uE4Q6s
bw25tfZtVv6KHQk+JA5nJsf8sg2glLCylMx75mf+pliy1NhBEsFV/W6RxbuxTAhL
ntRCBm8bGNU26mSuzv31BebiZtAOBSGssREGIxnk+wU0ROoIrp1JZxGLguWtWoan
Zv0zAwHemSX5cW7pnF0CTGA8zwKPAf1y7pLxpxLeQhJN7Kkm5XcCrA5XDAnRYZ4m
iPzIsk3bZPBFn7rBP1Sj2HYClWxqjcoiXPYMBOMp+kuwHNM3dITZHWarNHOPHn18
XpbWPRmwl+qMUJFtr1eGfhA3HWsaFN8CAwEAAaOCASkwggElMA4GA1UdDwEB/wQE
AwIBhjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBTqFsZp5+PLV0U5M6Tw
QL7Qw71lljAfBgNVHSMEGDAWgBSubAWjkxPioufi1xzWx/B/yGdToDA+BggrBgEF
BQcBAQQyMDAwLgYIKwYBBQUHMAGGImh0dHA6Ly9vY3NwMi5nbG9iYWxzaWduLmNv
bS9yb290cjYwNgYDVR0fBC8wLTAroCmgJ4YlaHR0cDovL2NybC5nbG9iYWxzaWdu
LmNvbS9yb290LXI2LmNybDBHBgNVHSAEQDA+MDwGBFUdIAAwNDAyBggrBgEFBQcC
ARYmaHR0cHM6Ly93d3cuZ2xvYmFsc2lnbi5jb20vcmVwb3NpdG9yeS8wDQYJKoZI
hvcNAQEMBQADggIBAH/iiNlXZytCX4GnCQu6xLsoGFbWTL/bGwdwxvsLCa0AOmAz
HznGFmsZQEklCB7km/fWpA2PHpbyhqIX3kG/T+G8q83uwCOMxoX+SxUk+RhE7B/C
pKzQss/swlZlHb1/9t6CyLefYdO1RkiYlwJnehaVSttixtCzAsw0SEVV3ezpSp9e
FO1yEHF2cNIPlvPqN1eUkRiv3I2ZOBlYwqmhfqJuFSbqtPl/KufnSGRpL9KaoXL2
9yRLdFp9coY1swJXH4uc/LusTN763lNMg/0SsbZJVU91naxvSsguarnKiMMSME6y
CHOfXqHWmc7pfUuWLMwWaxjN5Fk3hgks4kXWss1ugnWl2o0et1sviC49ffHykTAF
nM57fKDFrK9RBvARxx0wxVFWYOh8lT0i49UKJFMnl4D6SIknLHniPOWbHuOqhIKJ
PsBK9SH+YhDtHTD89szqSCd8i3VCf2vL86VrlR8EWDQKie2CUOTRe6jJ5r5IqitV
2Y23JSAOG1Gg1GOqg+pscmFKyfpDxMZXxZ22PLCLsLkcMe+97xTYFEBsIB3CLegL
xo1tjLZx7VIh/j72n585Gq6s0i96ILH0rKod4i0UnfqWah3GPMrz2Ry/U02kR1l8
lcRDQfkl4iwQfoH5DZSnffK1CfXYYHJAUJUg1ENEvvqglecgWbZ4xqRqqiKb
-----END CERTIFICATE-----

SSL.com Timestamping Issuing RSA CA R1
-----BEGIN CERTIFICATE-----
MIIG/DCCBOSgAwIBAgIQbVIYcIfoI02FYADQgI+TVjANBgkqhkiG9w0BAQsFADB8
MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0b24x
GDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNvbSBSb290
IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTAeFw0xOTExMTMxODUwMDVaFw0z
NDExMTIxODUwMDVaMHMxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4G
A1UEBwwHSG91c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLzAtBgNVBAMMJlNTTC5j
b20gVGltZXN0YW1waW5nIElzc3VpbmcgUlNBIENBIFIxMIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEArlEQE9L5PCCgIIXeyVAcZMnh/cXpNP8KfzFI6HJa
xV6oYf3xh/dRXPu35tDBwhOwPsJjoqgY/Tg6yQGBqt65t94wpx0rAgTVgEGMqGri
6vCI6rEtSZVy9vagzTDHcGfFDc0Eu71mTAyeNCUhjaYTBkyANqp9m6IRrYEXOKdd
/eREsqVDmhryd7dBTS9wbipm+mHLTHEFBdrKqKDM3fPYdBOro3bwQ6OmcDZ1qMY+
2Jn1o0l4N9wORrmPcpuEGTOThFYKPHm8/wfoMocgizTYYeDG/+MbwkwjFZjWKwb4
hoHT2WK8pvGW/OE0Apkrl9CZSy2ulitWjuqpcCEm2/W1RofOunpCm5Qv10T9tIAL
tQo73GHIlIDU6xhYPH/ACYEDzgnNfwgnWiUmMISaUnYXijp0IBEoDZmGT4RTguiC
mjAFF5OVNbY03BQoBb7wK17SuGswFlDjtWN33ZXSAS+i45My1AmCTZBV6obAVXDz
LgdJ1A1ryyXz4prLYyfJReEuhAsVp5VouzhJVcE57dRrUanmPcnb7xi57VPhXnCu
w26hw1Hd+ulK3jJEgbc3rwHPWqqGT541TI7xaldaWDo85k4lR2bQHPNGwHxXuSy3
yczyOg57TcqqG6cE3r0KR6jwzfaqjTvN695GsPAPY/h2YksNgF+XBnUD9JBtL4c3
4AcCAwEAAaOCAYEwggF9MBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAU
3QQJB6L1en1SUxKSle44gCUNplkwgYMGCCsGAQUFBwEBBHcwdTBRBggrBgEFBQcw
AoZFaHR0cDovL3d3dy5zc2wuY29tL3JlcG9zaXRvcnkvU1NMY29tUm9vdENlcnRp
ZmljYXRpb25BdXRob3JpdHlSU0EuY3J0MCAGCCsGAQUFBzABhhRodHRwOi8vb2Nz
cHMuc3NsLmNvbTA/BgNVHSAEODA2MDQGBFUdIAAwLDAqBggrBgEFBQcCARYeaHR0
cHM6Ly93d3cuc3NsLmNvbS9yZXBvc2l0b3J5MBMGA1UdJQQMMAoGCCsGAQUFBwMI
MDsGA1UdHwQ0MDIwMKAuoCyGKmh0dHA6Ly9jcmxzLnNzbC5jb20vc3NsLmNvbS1y
c2EtUm9vdENBLmNybDAdBgNVHQ4EFgQUDJ0QJY6apxuZh0PPCH7hvYGQ9M8wDgYD
VR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBCwUAA4ICAQCSGXUNplpCzxkH2fL8lPrA
m/AV6USWWi9xM91Q5RN7mZN3D8T7cm1Xy7qmnItFukgdtiUzLbQokDJyFTrF1pyL
gGw/2hU3FJEywSN8crPsBGo812lyWFgAg0uOwUYw7WJQ1teICycX/Fug0KB94xwx
hsvJBiRTpQyhu/2Kyu1Bnx7QQBA1XupcmfhbQrK5O3Q/yIi//kN0OkhQEiS0NlyP
PYoRboHWC++wogzV6yNjBbKUBrMFxABqR7mkA0x1Kfy3Ud08qyLC5Z86C7JFBrMB
fyhfPpKVlIiiTQuKz1rTa8ZW12ERoHRHcfEjI1EwwpZXXK5J5RcW6h7FZq/cZE9k
LRZhvnRKtb+X7CCtLx2h61ozDJmifYvuKhiUg9LLWH0Or9D3XU+xKRsRnfOuwHWu
hWch8G7kEmnTG9CtD9Dgtq+68KgVHtAWjKk2ui1s1iLYAYxnDm13jMZm0KpRM9mL
QHBK5Gb4dFgAQwxOFPBslf99hXWgLyYE33vTIi9p0gYqGHv4OZh1ElgGsvyKdUUJ
kAr5hfbDX6pYScJI8v9VNYm1JEyFAV9x4MpskL6kE2Sy8rOqS9rQnVnIyPWLi8N9
K4GZvPit/Oy+8nFL6q5kN2SZbox5d69YYFe+rN1sDD4CpNWwBBTI/q0V4pkgvhL9
9IV2XasjHZf4peSrHdL4Rg==
-----END CERTIFICATE-----

Microsoft C2PA AL2 Root CA 2025
-----BEGIN CERTIFICATE-----
MIIFjzCCA3egAwIBAgIQEnO0shHK6IxLTfxxgTIJkDANBgkqhkiG9w0BAQwFADBX
MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSgw
JgYDVQQDEx9NaWNyb3NvZnQgQzJQQSBBTDIgUm9vdCBDQSAyMDI1MB4XDTI1MTIx
NjIwNTEzM1oXDTQ1MTIxNjIwNTg1MFowVzELMAkGA1UEBhMCVVMxHjAcBgNVBAoT
FU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEoMCYGA1UEAxMfTWljcm9zb2Z0IEMyUEEg
QUwyIFJvb3QgQ0EgMjAyNTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIB
AMzpMnj7KOLhCDiNkbhHRY28nt+dapImPvfBbI6CVpGh/sCSydJX6ZDI8hCQ184t
88fXwvTOMwrNO5vFRv8x2DuoAMlFm0CuT1rwb4cQcDNkFc/MltC0LX8yy3WjauyL
gS4DsQNy4SYrFW5vyQd7mnqKn3hUoV4tRPSrHtM2/aGIDtw3kFUgeMdHwIP68gn0
r2nmmNazoUs3hSF+lulEpKX6m0aIbWuNZQHIM+OuvELZD/Mi4VKI0awfa0c57une
KLNV3s1R1wev3D5ZeUYVChkpgiYOpjIaGzpMzLXqiE/L5q0sVJrzO+Ada2yX2MAy
AmCGPa+u2gsSqwFnFSNPpi9u6KYjmJuOCyPaXTE/MNlPK/pvpbkoSQG+GI2j1ST5
i9xqw39bAvZzWrlZWv+tNrvDaKMc/1uUOJuIpmqtMfzdJfkaf6djItEJi+vGhwMp
fD2WOjxoaPMjP0Fp+GuSDwHgz9q2E8qtTbnKGd9ZbewhjPIu9voiQSGP9I2nMiyS
uVbJ2IuYW6X2KjMU6+fxkjK/1c2rfY7W3od67IVGSzKVkP/aiZAX1iqikD7W+fMP
cgPF7qCPO2mL7TbfVv3C/Yz5BItgw5KM3iVFV6wjOoYHWRdwXI4bMFwbgJxagvso
RGA8kVP5ZPrx04FW+qKBMidVfQkJNZSz6mH+j4bw9H4dAgMBAAGjVzBVMA4GA1Ud
DwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgECMB0GA1UdDgQWBBRlk7SgJPWG
qFZLi0w+GI13Cfjq4TAQBgkrBgEEAYI3FQEEAwIBADANBgkqhkiG9w0BAQwFAAOC
AgEAfqfoE/Rpe02glLPpuy0gvBIxi7YKlur5hOB8CCsYAA8EatP54GqBEfAXOaSJ
1x2H7dYkbn6lK9hpY8+cEtXPqiEafLCMoe2FvD9YI16fS0EVn5+qvnNSvKIULQpO
xeObJCnemwudMPcKBIjZhRgysZucQJcvGRD7ECpatzugUKx8JmC8xQv4YMrCBXdY
R19S5REYzfh3S/koUUd2AkEkkNtEPzzC+LjWL9zY3RderiD536TYl7Ej3HQ8QlVW
3CwMFwqC6I8Nfmb+hmSsvJxGwd45P9IOrnQGNUlBvnXapYFl4h9H46DgJ9ViAruM
MTSSKGUmLygBu8tj7aIHtSjBzt5MDWWHBy9w+tEjNY35eEpMNaLpG7R00/zNNXT5
vfqatpFxtLIKkesY4vCv8FJpZAoBMKGodAtTsrt+7lspQlnC8eNZNu/s/QDK/Li7
hwXFmpP4Jlp+Af7tL+ZF9+4UMfEEts6H6xbREYS+5XJRLlWDZkrxThU4D4Iz7V6A
edg2W+70uokQWuqqwACzQvQMlrC1ccUd7/2Ld5DpVcy8vXd+GqQqgWC3zlVUZf+1
f2qnVH+ewkpo6VmeVXOdiCgfQJIS8rkEMJfjmQkEYZj0qOD4Oof+BxnrUGaSGrBr
dbTpTnNA8vv2MUw5th3vRbfKMlAOXtgaJligciyEyqo/ObE=
-----END CERTIFICATE-----

Microsoft C2PA Claims AL2 PCA 2025
-----BEGIN CERTIFICATE-----
MIIHWzCCBUOgAwIBAgITMwAAAAKdUKaYIhWE3gAAAAAAAjANBgkqhkiG9w0BAQwF
ADBXMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MSgwJgYDVQQDEx9NaWNyb3NvZnQgQzJQQSBBTDIgUm9vdCBDQSAyMDI1MB4XDTI1
MTIxNzAwMjQwMloXDTQwMTIxNzAwMzQwMlowWjELMAkGA1UEBhMCVVMxHjAcBgNV
BAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjErMCkGA1UEAxMiTWljcm9zb2Z0IEMy
UEEgQ2xhaW1zIEFMMiBQQ0EgMjAyNTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCC
AgoCggIBAJvoCfGqERkDSz54E9egXnLSobAm8S/1THQLshhQ5rKzmP2yZQyGU6F+
l81NUvS9rOoeQ11qj+kYfCgoBXA6mCl4984Fvf2HTW3DsmmgcU+r1ej2ARg2k4Ab
wW6pZtINDxl4Z227VRCh6BaESef6CXJ2Gj1k0tPlimUTG2GIAmt2J4oNcS6e4J1L
5ky1E2661DBd97BGiC+hxxTr0SlWySVm9Y4Cqdv6LV8+rLB6weyeub2iI2VC7SbI
JC9RjgnDEjy7iH+R1xX55TTfNUl32WWR8TmzCH5vIoIv8LHrcPh4JgM1IGEIoop1
Fg9YLRIw6O8HNuV7GdMd9NTqFuUemgAL6hzKPL8ZjWwJAyZtviFfY7yxzyIR1uYg
fa0finBxX2EueyJKqgB1PrdVRDXo0aCda8Y9n++G+3ZOyiR0Y7t4Hh4Qhbhxn9YI
br+5kDlgCbBzPhvWQWvG9tAwabJ/v1DfTj9WD3AtnLVhwQGnF7grFf0PpG5jzDSk
k5Qq0e8K57d3hfBqUym3DN7L9Ft7jaqx8FN4qdbDLq2RYCqtYGUCZFAqG2OlFXwZ
5ZYB+mEp73z8rynatISCe5iecVj1wWifHeqO4V2y2G4ak/3kjRmUfdH38/Lid4kA
3IOrmHKoRsyv39tRMh5HdiZl3WfhNINnaKEe30DXCyVS7Uw4eC8PAgMBAAGjggIb
MIICFzAOBgNVHQ8BAf8EBAMCAQYwEAYJKwYBBAGCNxUBBAMCAQAwHQYDVR0OBBYE
FGOg44wa0jSIJI2CVgCZvQU8TIywMFwGA1UdIARVMFMwUQYMKwYBBAGCN0yDfQED
MEEwPwYIKwYBBQUHAgEWM2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMv
ZG9jcy9yZXBvc2l0b3J5Lmh0bTAfBgNVHSUEGDAWBgorBgEEAYPoXgIBBggrBgEF
BQcDJDAZBgkrBgEEAYI3FAIEDB4KAFMAdQBiAEMAQTASBgNVHRMBAf8ECDAGAQH/
AgEBMB8GA1UdIwQYMBaAFGWTtKAk9YaoVkuLTD4YjXcJ+OrhMGIGA1UdHwRbMFkw
V6BVoFOGUWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY3JsL01pY3Jv
c29mdCUyMEMyUEElMjBBTDIlMjBSb290JTIwQ0ElMjAyMDI1LmNybDCBoAYIKwYB
BQUHAQEEgZMwgZAwXwYIKwYBBQUHMAKGU2h0dHA6Ly93d3cubWljcm9zb2Z0LmNv
bS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIwQzJQQSUyMEFMMiUyMFJvb3QlMjBD
QSUyMDIwMjUuY3J0MC0GCCsGAQUFBzABhiFodHRwOi8vb25lb2NzcC5taWNyb3Nv
ZnQuY29tL29jc3AwDQYJKoZIhvcNAQEMBQADggIBAIYyo6vn0nxk7OCmf7Ue0v+a
FAgdsai7V/3hZsZ6lvxKnirsbS+uaZPQNsThDWhr/umBSCF/jtFA+dgzTTuQuarl
MDP7uUwVYdUguImIwNXxbeSzn8iYA7Q9/p6XWPoeHavhRrZ5ujV/IuIed8IU+cUx
pNudZnKTFvDuAs5Pi9V6ruAA4zMmN7rJKsQj720aynTGycnb15QxY6H7qmDnZbZL
eyCR7o08El1oQiFhqTTx0Ev0PkcB9IbhqgH3g60Jrtmgdni7IydaHOV4eaZPzdfD
ZSK8MUmGyMY8s6H2uE4gMzRGt6kk8cq0UDU31XfPFaCPLymbolCofPZsgIprJ+FI
VPzLtI0yYO8gCk/axInATP8JaMX+MhTioII/eQsMgHuxKuJhHqbkdi2BcBKrSGT/
n7ap1PDh54EY6niT5fcdTyv0liXE95WqTDDIHM4qpTLM6MCJGXY85h0h0x11vnq5
C4t8tlTAGBPU5h9RSwxVG8OsLqwRN3Yq+LrHvI7U3uPDUIeh0qfJJ8KCCjyWRx/o
7T3ctIX31Bso8GGEmkoMLNhFdUCR09uEzmCARmzSJcNgeMoifMDnm5t+jEIloRoa
QEqADZ+wDIanhs9siV2ITjEO5WJgWvbNuCm7W5QWYdyE+O/AIQeaQcL+sYeieBTW
Dp7rRMfzLp0Q/u3Ap8x2
-----END CERTIFICATE-----

Microsoft C2PA Time Stamp Authority PCA 2025
-----BEGIN CERTIFICATE-----
MIIHWTCCBUGgAwIBAgITMwAAAAOscVbt3sExSQAAAAAAAzANBgkqhkiG9w0BAQwF
ADBXMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MSgwJgYDVQQDEx9NaWNyb3NvZnQgQzJQQSBBTDIgUm9vdCBDQSAyMDI1MB4XDTI1
MTIxNzAxMDg1OVoXDTQwMTIxNzAxMTg1OVowZDELMAkGA1UEBhMCVVMxHjAcBgNV
BAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjE1MDMGA1UEAxMsTWljcm9zb2Z0IEMy
UEEgVGltZSBTdGFtcCBBdXRob3JpdHkgUENBIDIwMjUwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCl/OdW45/qglcIWBMZU8UZPW/IYRoT/FtW/lADBAVe
XO7x9qALK1i4GN59hjjGC7TQ0xq++4iCu4Yr59Nq/TrroHwtGSaKFvD17op4itkY
R0D3HpXh4KN3QLk1tPUNLFssX6vpJK9PzA1k0C8b3lzc6D0eqppc71fetcx4szDe
Qdr+4+6sdG+a4YDufxPpCxFJcLAuN5ZJifw1vsUojrqk3qvNQ7S6ncNg2yMoNnKj
HUMydV+clkmL14sv72idLla4Ui7mlhJPwR71XO8Nmbprp8UatnAEM7vYzciSaj5/
pzlEsc7CU2XnX2zDY5aCmK5nuf1pZMg8twVZNuCocQeKainA6fUTL3GjmHQE65aJ
nJMwFeydrhuw0PhW2yUyGi39k62bWUoQ0FTc+wiOHZSdSlfmA6077uFYLqrN46Ah
dAE3j/B8gXfDF6SH5yf371uMLXN8v+bhlMecd4CITf7RcRaKR3CwehisyCAa6Cof
vdeoQn6OrtafEtIJygtbvXDqB9s4oi/jhEgslZrEc28HTGYVSmJhF51iM6Y7+9Jy
L5+SrpIDP1sT+py28Nsih0nFSrKIhjDr1KZvEt6cIVVkIQ+YKaBq8t+v3ICggD3r
/tl9fH2gi8SCNdTPtVzgpIBTr+CqkcTz49rFJMitwCqQrsQ0wZdDticPFzVefrN7
PQIDAQABo4ICDzCCAgswDgYDVR0PAQH/BAQDAgEGMBAGCSsGAQQBgjcVAQQDAgEA
MB0GA1UdDgQWBBTDnJKxCj6dN91rCyuBpb7tE8RfGTBcBgNVHSAEVTBTMFEGDCsG
AQQBgjdMg30BAzBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29mdC5j
b20vcGtpb3BzL2RvY3MvcmVwb3NpdG9yeS5odG0wEwYDVR0lBAwwCgYIKwYBBQUH
AwgwGQYJKwYBBAGCNxQCBAweCgBTAHUAYgBDAEEwEgYDVR0TAQH/BAgwBgEB/wIB
ADAfBgNVHSMEGDAWgBRlk7SgJPWGqFZLi0w+GI13Cfjq4TBiBgNVHR8EWzBZMFeg
VaBThlFodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNyb3Nv
ZnQlMjBDMlBBJTIwQUwyJTIwUm9vdCUyMENBJTIwMjAyNS5jcmwwgaAGCCsGAQUF
BwEBBIGTMIGQMF8GCCsGAQUFBzAChlNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20v
cGtpb3BzL2NlcnRzL01pY3Jvc29mdCUyMEMyUEElMjBBTDIlMjBSb290JTIwQ0El
MjAyMDI1LmNydDAtBggrBgEFBQcwAYYhaHR0cDovL29uZW9jc3AubWljcm9zb2Z0
LmNvbS9vY3NwMA0GCSqGSIb3DQEBDAUAA4ICAQAgW1VWrhRwRwvGYwLA6226MUps
bP99X0i8vA1b9HXwT2BttePPOTmFdcrJgbxZqx/F54iUzxanpr3BCg72B0dAekUN
/+Iu2LgFx1VtAdNXdw9DwuHzU2t9aR/qn7tCZZmXtAqfUy3dXyR3qaOZBjcJQIi1
ZOdYDJJ3WL4YqsvliWRo+fWcCcix54b+vea4nrIfXx56zhP+vQ7N+3wKyQNe6kz+
AekrMuzPWgMdgQKLKbL2XKeR4eiGe4UMQqyGYxJXZk8pvVpk5wEh8sSIoVwb6t54
AssWB04L+bl/vQ7die5zMqn69iPc2F32FfpbrkvtsfZRKpijQ+jEuReUsUa4USBG
Wyu4NWrkNi3BJ8hvgki4HMkRmlXJ2YKgUsaK0W8IVIpSvoTs2MYaK9oKOhlNMtRj
az9H8sMmnZ1F14nJpABGzW9dJz0abCu7zwoUDvArb9Tu4UiEgAtI/hmzAT4iidNY
qzgfkrkYkKD7ht1YNHxOreixwtosuF/ykc6MQoVti+8YTle7Hl8SDlp/JE4U2mnM
EvyaEC2i5g5DGBH9bkq7+ZR4wJ9rEA8eMjjZoC6yrUbjfv2N+gUwqrtPENsas2z4
x3sizPOefAIye4i1uTYYdbiXHBTuetSuMmuWtRld1howmo5dLeOE5PUoyToTqwyL
6vbyMW1uoSaUAH+mKw==
-----END CERTIFICATE-----
`,en=`Subject	CN=Google C2PA Media Services 1P ICA G3, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIIC3DCCAmOgAwIBAgIUQfqlIUd2IVjaf5ss/439Fgke7j4wCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwHhcNMjUwNTA4MjIzNjI2WhcNMzAwNTA4MjIz
NjI2WjBRMQswCQYDVQQGEwJVUzETMBEGA1UECgwKR29vZ2xlIExMQzEtMCsGA1UE
AwwkR29vZ2xlIEMyUEEgTWVkaWEgU2VydmljZXMgMVAgSUNBIEczMHYwEAYHKoZI
zj0CAQYFK4EEACIDYgAEuCPlUxSiltqnB2lx2ES7FK+TVZWmAxRzzDjTzKZ8umoq
yvCqSLOkZBrOieaLqrp+rnzt0EADWWH3X62NqzEXRewW6rb/lS7VXkVCM02gC0Zg
JW7+PCsZgLoUBUQ+nkN5o4IBCDCCAQQwFwYDVR0gBBAwDjAMBgorBgEEAYPoXgEB
MA4GA1UdDwEB/wQEAwIBBjAfBgNVHSUEGDAWBggrBgEFBQcDBAYKKwYBBAGD6F4C
ATASBgNVHRMBAf8ECDAGAQH/AgEAMGQGCCsGAQUFBwEBBFgwVjAsBggrBgEFBQcw
AoYgaHR0cDovL3BraS5nb29nL2MycGEvcm9vdC1nMy5jcnQwJgYIKwYBBQUHMAGG
Gmh0dHA6Ly9jMnBhLW9jc3AucGtpLmdvb2cvMB8GA1UdIwQYMBaAFJxc2IlTQ+da
1YHbA94ZfwQqKi2qMB0GA1UdDgQWBBTae+G9tCyKheAQ1muax0rx+t/2NzAKBggq
hkjOPQQDAwNnADBkAjACxtEE3NW13bwN1u/51ericNF6rkEhYVESDO6Jqb5cX37H
wg0X9S2rH+vXaoFZIHsCMC03wCKKomDHgqV47UtyyHpZlo5IZACW72Xdc4gipdWM
EmhvPk88dvxbYtn+LVd9zA==
-----END CERTIFICATE-----

Subject	CN=Google C2PA Mobile A 1P ICA G3 L1, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIIC2TCCAmCgAwIBAgIUdEQo46dHfO396b1NFkYHqblfVzAwCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwHhcNMjUwNTA4MjIzNjI3WhcNMzAwNTA4MjIz
NjI3WjBOMQswCQYDVQQGEwJVUzETMBEGA1UECgwKR29vZ2xlIExMQzEqMCgGA1UE
AwwhR29vZ2xlIEMyUEEgTW9iaWxlIEEgMVAgSUNBIEczIEwxMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAEiso7FbPFqaTmLWL6vJq0Q0FTLVILWVg1nyG1kR2JkEc5E9WW
k62YSJreXbX6axJqDGecSk5kvqcb9EVJ+wymonRaqy7Gk9c6fi9Hr1mK2mfJZRlX
CIXeMXeneVG8NMJ8o4IBCDCCAQQwFwYDVR0gBBAwDjAMBgorBgEEAYPoXgEBMA4G
A1UdDwEB/wQEAwIBBjAfBgNVHSUEGDAWBggrBgEFBQcDBAYKKwYBBAGD6F4CATAS
BgNVHRMBAf8ECDAGAQH/AgEAMGQGCCsGAQUFBwEBBFgwVjAsBggrBgEFBQcwAoYg
aHR0cDovL3BraS5nb29nL2MycGEvcm9vdC1nMy5jcnQwJgYIKwYBBQUHMAGGGmh0
dHA6Ly9jMnBhLW9jc3AucGtpLmdvb2cvMB8GA1UdIwQYMBaAFJxc2IlTQ+da1YHb
A94ZfwQqKi2qMB0GA1UdDgQWBBSu91pCmLI7HftmLBUUmRZ631vvlDAKBggqhkjO
PQQDAwNnADBkAjA6bs5IFiYOZjmln6Bii/ShnzrqTn4GxKdCZhP79ul9iPz+mQyn
pORTyTY84SsxzicCMCI2tAB6n8FQ5BkN1apEUG5gcJlrrNd1rdqtBNXJZHXqYG1m
7T4gYBB4PHNYYFBGfA==
-----END CERTIFICATE-----

Subject	CN=Google C2PA Mobile A 1P ICA G3, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIIC1jCCAl2gAwIBAgIUXKoTHSLJjkXHIxvKY29YmxgOzoowCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwHhcNMjUwNTA4MjIzNjI4WhcNMzAwNTA4MjIz
NjI4WjBLMQswCQYDVQQGEwJVUzETMBEGA1UECgwKR29vZ2xlIExMQzEnMCUGA1UE
AwweR29vZ2xlIEMyUEEgTW9iaWxlIEEgMVAgSUNBIEczMHYwEAYHKoZIzj0CAQYF
K4EEACIDYgAEx5s4bjuNRDlYKtdj4Dd14esDWyBAk+fNPHFGlDcWX2lTdxgeeKYF
caw7ZdhD5fWAqUZ++M5wdXXUoGHDFAwfPmTaRKzZupUu7uMFZtolBzAuT2I51meH
EfMHU95kRkTIo4IBCDCCAQQwDgYDVR0PAQH/BAQDAgEGMB8GA1UdJQQYMBYGCCsG
AQUFBwMEBgorBgEEAYPoXgIBMBIGA1UdEwEB/wQIMAYBAf8CAQAwFwYDVR0gBBAw
DjAMBgorBgEEAYPoXgEBMGQGCCsGAQUFBwEBBFgwVjAsBggrBgEFBQcwAoYgaHR0
cDovL3BraS5nb29nL2MycGEvcm9vdC1nMy5jcnQwJgYIKwYBBQUHMAGGGmh0dHA6
Ly9jMnBhLW9jc3AucGtpLmdvb2cvMB8GA1UdIwQYMBaAFJxc2IlTQ+da1YHbA94Z
fwQqKi2qMB0GA1UdDgQWBBQOccStRBCOVzAFalyyAs6XkvF+IDAKBggqhkjOPQQD
AwNnADBkAjBjAj22bX3vKs/3Q4K0qE7jPwY3BljcaGyhTg9Gk6ni0+3TxuluLCq+
zITXauG0qy0CMFfS4bUxKdwCjWOnamLCA9xiaO82my0UN0kvxNMFflLsmeO4PL+N
I/u3EJ347o+4jA==
-----END CERTIFICATE-----

Subject	CN=Google C2PA Mobile B 1P ICA G3 L1, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIIC2zCCAmCgAwIBAgIUBpMF/2hh9GWQEhKn4uebRk7j2PcwCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwHhcNMjUwNTA4MjIzNjI3WhcNMzAwNTA4MjIz
NjI3WjBOMQswCQYDVQQGEwJVUzETMBEGA1UECgwKR29vZ2xlIExMQzEqMCgGA1UE
AwwhR29vZ2xlIEMyUEEgTW9iaWxlIEIgMVAgSUNBIEczIEwxMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAEKGv3Fd3J1vOPfrR744lpYlGc05lZ57UyVDKGHTPj71PuwW19
oHO932WXXf+K4jBkotgXeBChrhrTiUGxBdrmYRB1m6MyAJ/wT3xw06YRcGxoiW0b
IhbMN4YNIAMW76Noo4IBCDCCAQQwFwYDVR0gBBAwDjAMBgorBgEEAYPoXgEBMA4G
A1UdDwEB/wQEAwIBBjAfBgNVHSUEGDAWBggrBgEFBQcDBAYKKwYBBAGD6F4CATAS
BgNVHRMBAf8ECDAGAQH/AgEAMGQGCCsGAQUFBwEBBFgwVjAsBggrBgEFBQcwAoYg
aHR0cDovL3BraS5nb29nL2MycGEvcm9vdC1nMy5jcnQwJgYIKwYBBQUHMAGGGmh0
dHA6Ly9jMnBhLW9jc3AucGtpLmdvb2cvMB8GA1UdIwQYMBaAFJxc2IlTQ+da1YHb
A94ZfwQqKi2qMB0GA1UdDgQWBBRLBf7gDA1hOViJqHtuE8btC3KB8TAKBggqhkjO
PQQDAwNpADBmAjEAhfcU5E3IKMRw/Wxd9YfUdxTpi5HM99JiHG0KmFxcPGd8tDBA
XkoxEV/OYIEeyVl4AjEA1QH3goidp0++w4rQ6P8wbdw3BtlkSJpGsQ4WQc0i5bWz
KyN/WtDOZj/RG3+bqaw+
-----END CERTIFICATE-----

Subject	CN=Google C2PA Mobile B 1P ICA G3, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIIC1zCCAl2gAwIBAgIUac3GAHq5vTwO71pE75SNo8wcJVcwCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwHhcNMjUwNTA4MjIzNjI3WhcNMzAwNTA4MjIz
NjI3WjBLMQswCQYDVQQGEwJVUzETMBEGA1UECgwKR29vZ2xlIExMQzEnMCUGA1UE
AwweR29vZ2xlIEMyUEEgTW9iaWxlIEIgMVAgSUNBIEczMHYwEAYHKoZIzj0CAQYF
K4EEACIDYgAEbns1saor1bu/tYfe1ozY2yZwBgkcmIcmr552foAPn5v4zmS61OEs
C5VwKHBgi9uTuXZ8SSV1KSPyysqrgm542XLPWsMlkuWRfneQBANeLAk6aEBqDASo
DJ7Aoube5tuao4IBCDCCAQQwDgYDVR0PAQH/BAQDAgEGMB8GA1UdJQQYMBYGCCsG
AQUFBwMEBgorBgEEAYPoXgIBMBIGA1UdEwEB/wQIMAYBAf8CAQAwFwYDVR0gBBAw
DjAMBgorBgEEAYPoXgEBMGQGCCsGAQUFBwEBBFgwVjAsBggrBgEFBQcwAoYgaHR0
cDovL3BraS5nb29nL2MycGEvcm9vdC1nMy5jcnQwJgYIKwYBBQUHMAGGGmh0dHA6
Ly9jMnBhLW9jc3AucGtpLmdvb2cvMB8GA1UdIwQYMBaAFJxc2IlTQ+da1YHbA94Z
fwQqKi2qMB0GA1UdDgQWBBT4N2ZAjPoDJR1+UgU4KwafcJT5mDAKBggqhkjOPQQD
AwNoADBlAjEAg2SjBAAmAOvOLd1kKYZQzkiD6KSXe4+3zALTs5SQCK3xmmkxsFzJ
bBCIiuTbxsrIAjAhQm+LpSxSwkIZiwWI7rGiJMv7BCj38HhiQpmR5lr+anbBOQty
UsWhYsCGlDmiWzA=
-----END CERTIFICATE-----

Subject	CN=Google C2PA Root CA G3, O=Google LLC, C=US
-----BEGIN CERTIFICATE-----
MIICLjCCAbOgAwIBAgIUUZK4AROFKiXQZ1UG7FG6qPGc1g8wCgYIKoZIzj0EAwMw
QzELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkdvb2dsZSBMTEMxHzAdBgNVBAMMFkdv
b2dsZSBDMlBBIFJvb3QgQ0EgRzMwIBcNMjUwNTA4MjIzMjIxWhgPMjA1MDA1MDgy
MjMyMjFaMEMxCzAJBgNVBAYTAlVTMRMwEQYDVQQKDApHb29nbGUgTExDMR8wHQYD
VQQDDBZHb29nbGUgQzJQQSBSb290IENBIEczMHYwEAYHKoZIzj0CAQYFK4EEACID
YgAEhv9f/juKcPpe3Fm7eAISMuSyS+tBxn0aYHC83J+qAsFWREGN9p6PN/OBoouP
zpOFRxvrlWoWmAI3p1lXyPg4E3eg7SNChgopUIpihGu6qlhP8rLXf3p8bhI5FTQ2
MaF2o2YwZDASBgNVHRMBAf8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBBjAfBgNV
HSMEGDAWgBScXNiJU0PnWtWB2wPeGX8EKiotqjAdBgNVHQ4EFgQUnFzYiVND51rV
gdsD3hl/BCoqLaowCgYIKoZIzj0EAwMDaQAwZgIxAIyVEe5bdUMkk6BthEWy9QSE
Mb74BOyK8/8pgMX0NPwLlo1ikLNY78ov+k21vZrEZQIxANQ91muDXgPjAMAkzAlK
i32Z9VBB37ynTveKVC7ofTW0ZFfIIYYpWUR1+C4m2yRkOQ==
-----END CERTIFICATE-----

Subject	CN=SSL.com C2PA RSA Root CA 2025, O=SSL Corporation, C=US
-----BEGIN CERTIFICATE-----
MIIFlDCCA3ygAwIBAgIUExeshkq/ESresWEq3YWcEUTmxvowDQYJKoZIhvcNAQEL
BQAwTzEmMCQGA1UEAwwdU1NMLmNvbSBDMlBBIFJTQSBSb290IENBIDIwMjUxGDAW
BgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjELMAkGA1UEBhMCVVMwIBcNMjUxMTA3MTYy
NzEzWhgPMjA1MDExMDExNjI3MTNaME8xJjAkBgNVBAMMHVNTTC5jb20gQzJQQSBS
U0EgUm9vdCBDQSAyMDI1MRgwFgYDVQQKDA9TU0wgQ29ycG9yYXRpb24xCzAJBgNV
BAYTAlVTMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA07LXx05AgfZn
F6CPMzpPwA+vGxfqi2Pw3/gvhAe4UdzmasSutCRK9sK66DZYta4AbYPS0/2IToqo
1n33f9/XrmQ62uM3XAyKXfg8UWUaj2WsyA3dIxY5l80B0S0EX0V1HpP6ygw1IDfJ
/KKkknn/0o14zmNkRzLpqQDOMoL4s+kli8NtkEOG8M8NrH5QJCNRL7lN0DG8TvRa
10Zfwyxnd4yw9DT2HWJInjC+Hww9QZua/u6bTy0pFHV0vVCgKQuPtbX8b60998t4
b56trGesWapUefIEu6GH1CkQu7nhsk1Rf59+uPv1NQLOm7wbyghHtQQ00baR/687
r7/qXxRLV1CFNH3nAgFfHkD8N07GWS5C1OOmkUPrc2f9tdKWOJ6USDJCOX1DkTee
o9RgwSJfLueDtAOp19dlBo2UW79A2MGN6VI119DoW04VUjxmPHLIWtt08ZRTHzvN
2I2DA3ic5Wt4pgSLXDZ6ztlFX4Y6nXwVFdWae9zwLpm9ttsF4fepLyPAUTuT9m0j
/oeQt3KmyxIukYD8I1PiSQ6YDLIiWFZcYC8LMyiYmQEX6spsE+IF37lx2nZ1OF+D
AOSCYYamZx6HYShgN4zN1QYTMJdxbz5JgRTIIioVdJTqeF/5GsSGP6f9Eym8ND9j
LQzm8MBEMfvlAgw0q1ieN2Q9INSN3qMCAwEAAaNmMGQwEgYDVR0TAQH/BAgwBgEB
/wIBAjAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFPwqSnU6gPqZY5Pwc1fsvpOw
fcN7MB8GA1UdIwQYMBaAFPwqSnU6gPqZY5Pwc1fsvpOwfcN7MA0GCSqGSIb3DQEB
CwUAA4ICAQBAqkR9j5wKs0T7e9gHTUWlLAnkWLyZI7AuEoXimyJ7Ocy1EwZyu3TD
Z2jCecLNXENnUwjuKaEm/8sCwzrVqpxzIgkS1jVLuVURlrj2+apT/7wBw8LCKMZ6
cDhQJV3A1+9hyCc5ozkE1LgcJfWELrBWeBuj8rWLAf0DDgtwaED7nS9c9P8UgrxH
YTMe2AHWEfczXBirx5ubpNaokR0W01aSdXa97ohoS+ZmK0bxvmWCugI4tfsypsVl
lV2iD9v/BPLCVHP+7ot520mE21WdQKD69M54V8KAqfmNoG6I3TB2EcKJ0NpKI0zW
niSX05NDrv70INu+vAI8Sso/mRMHpuo03/0iTm3z8J4ACjwP071U0R3wCjTxN8z2
95EwOf1/JQH5h0njkarxFsWsnHJtWwE3kGEibO3ivB2U3FyS1osN0bEA4X5CSeMF
GDJFCXVB0l4/KeHHNRk3DEVjr5dzcwt/C2DLj9VuaeWEWuVbA3/PDR/MnZzDtPj1
TVLswGkWKwG+AyJaHkLysZD0IKwL4SZGGCRvyKw+G5Go0vvHVyUMPHqVTBApxY9l
pt6absyMPdRnf+w0tdFlhCd2rauRA0HX7JZ5xqnYjkfk0m7MpoauCsQR9udJvv5H
pMv7wvJRchf62/pPnjLKhN/dx9LR/EVqBPbPMhqdzO6ObQdqUJzXPQ==
-----END CERTIFICATE-----

Subject	CN=SSL.com C2PA ECC Root CA 2025, O=SSL Corporation, C=US
-----BEGIN CERTIFICATE-----
MIICRTCCAcugAwIBAgIUHTAeXakkTyAFDkZfyu8YyCO9ubgwCgYIKoZIzj0EAwIw
TzEmMCQGA1UEAwwdU1NMLmNvbSBDMlBBIEVDQyBSb290IENBIDIwMjUxGDAWBgNV
BAoMD1NTTCBDb3Jwb3JhdGlvbjELMAkGA1UEBhMCVVMwIBcNMjUwNzE4MTU1MTQ5
WhgPMjA1MDA3MTIxNTUxNDlaME8xJjAkBgNVBAMMHVNTTC5jb20gQzJQQSBFQ0Mg
Um9vdCBDQSAyMDI1MRgwFgYDVQQKDA9TU0wgQ29ycG9yYXRpb24xCzAJBgNVBAYT
AlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEo3WOe9pIesN2XWe6KQdiUO+cU1mr
+Bs8opia0I+IA5m8oYhBJmJWPxLea7PH6tlW6f5wqkIOaeJkJ7X1pz3IHPjO8qkX
imKjiUwt/B7IoEj6rhoqkAV4AMO2BMxbS1MUo2YwZDASBgNVHRMBAf8ECDAGAQH/
AgECMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUU50WGoV8zfcRPowvdPbBkJ1O
g6swHwYDVR0jBBgwFoAUU50WGoV8zfcRPowvdPbBkJ1Og6swCgYIKoZIzj0EAwID
aAAwZQIxALxN0Q+F+9KXOnYUKcW70UuxgitT8iwjTBGCIXJbJw4XaMtVdVGf4HwY
NITBgr+rWwIwczO4trazVV27OTCl8xNR0IH4UuyFgBVuzMsIj8IPkQw5mVhtvhY7
nNgp3Dyy2LeE
-----END CERTIFICATE-----

Subject	emailAddress=ca@trufo.ai, CN=Trufo C2PA Root CA (2025, ECC P384), OU=CA Division, O=Trufo Inc., L=New York, ST=New York, C=US
-----BEGIN CERTIFICATE-----
MIIDOTCCAr6gAwIBAgIUbXqcPd1r9yQm/fznG9RlSWyXiwswCgYIKoZIzj0EAwMw
gagxCzAJBgNVBAYTAlVTMREwDwYDVQQIDAhOZXcgWW9yazERMA8GA1UEBwwITmV3
IFlvcmsxEzARBgNVBAoMClRydWZvIEluYy4xFDASBgNVBAsMC0NBIERpdmlzaW9u
MRowGAYJKoZIhvcNAQkBFgtjYUB0cnVmby5haTEsMCoGA1UEAwwjVHJ1Zm8gQzJQ
QSBSb290IENBICgyMDI1LCBFQ0MgUDM4NCkwHhcNMjUxMjMwMTkwNTAzWhcNNDUx
MjI1MTkwNTAzWjCBqDELMAkGA1UEBhMCVVMxETAPBgNVBAgMCE5ldyBZb3JrMREw
DwYDVQQHDAhOZXcgWW9yazETMBEGA1UECgwKVHJ1Zm8gSW5jLjEUMBIGA1UECwwL
Q0EgRGl2aXNpb24xGjAYBgkqhkiG9w0BCQEWC2NhQHRydWZvLmFpMSwwKgYDVQQD
DCNUcnVmbyBDMlBBIFJvb3QgQ0EgKDIwMjUsIEVDQyBQMzg0KTB2MBAGByqGSM49
AgEGBSuBBAAiA2IABAp0qnhIwMtN6LeGdBVtHLPn85ecetr/lqcXFk8ypK9ukJzU
8LLv55Kh/MYTgEnuIKEOPhDxLDRdahc0mAjRnql4kLk395abw9WZjrBPek3qjv0q
ITR8VPYFABuZ5FRKx6OBpjCBozAdBgNVHQ4EFgQUA9Vfr36D5QQdWYAnSjT/Rf3r
SXgwHwYDVR0jBBgwFoAUA9Vfr36D5QQdWYAnSjT/Rf3rSXgwEgYDVR0TAQH/BAgw
BgEB/wIBAjAOBgNVHQ8BAf8EBAMCAQYwPQYDVR0gBDYwNDAyBgorBgEEAYPoPAEB
MCQwIgYIKwYBBQUHAgEWFmh0dHBzOi8vdHJ1Zm8uYWkvY3BjcHMwCgYIKoZIzj0E
AwMDaQAwZgIxAMUeYWZyxS2maiVkNETL29RAuLn/gHYTkt97l6evXwHLN46v28mI
39BIf6slyWnrCwIxAPRs/FJ+DoA0d/PCkrF946S+pG7vRqLnjB9OhMdmrMPvzaqx
KQYOBVx7SE4Kz48W8A==
-----END CERTIFICATE-----

Subject	CN=vivo Content Provenance and Authenticity Root CA, O=vivo Mobile Communication Co., Ltd., C=CN
-----BEGIN CERTIFICATE-----
MIIC0zCCAjSgAwIBAgIJAMIN3t2/xTDAMAoGCCqGSM49BAMEMHYxOTA3BgNVBAMM
MHZpdm8gQ29udGVudCBQcm92ZW5hbmNlIGFuZCBBdXRoZW50aWNpdHkgUm9vdCBD
QTEsMCoGA1UECgwjdml2byBNb2JpbGUgQ29tbXVuaWNhdGlvbiBDby4sIEx0ZC4x
CzAJBgNVBAYTAkNOMCAXDTI1MDkxODA5MDkxM1oYDzIwNTUwOTExMDkwOTEzWjB2
MTkwNwYDVQQDDDB2aXZvIENvbnRlbnQgUHJvdmVuYW5jZSBhbmQgQXV0aGVudGlj
aXR5IFJvb3QgQ0ExLDAqBgNVBAoMI3Zpdm8gTW9iaWxlIENvbW11bmljYXRpb24g
Q28uLCBMdGQuMQswCQYDVQQGEwJDTjCBmzAQBgcqhkjOPQIBBgUrgQQAIwOBhgAE
ANQigNuQ6RnYFSK2BWkaksR3fRFFytX4nzX3E4hLV/N/7m/XttNHxNDase0cAXwR
9pO23p6fb/9NbifILv2wzPn2ASMr306Y2frv/UjJ5J6WgHet2OFywRaPjFjJWRuk
4JCy0qoSxyyx230g8GYdacZzIqSzVTW7/Xz4mjnWDTOB/Db+o2YwZDASBgNVHRMB
Af8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUgB0dwwUcpK4u
7az42vKC2y+nnY8wHwYDVR0jBBgwFoAUgB0dwwUcpK4u7az42vKC2y+nnY8wCgYI
KoZIzj0EAwQDgYwAMIGIAkIB9cjlRbw8I0+0VAIOENCEzKOfp2risHuo3KVqyaSV
K/T6KzMNvpq3ihA6ZjnuH9i5y5XWV//awWbFJDSuT0Bq+pwCQgHuthBjGmDl/nyc
r3MxJErDVYZBh4b140LQBU60MtiPERVYwme03ukGImPW/OKbEWYmnhHyMAf1ym/3
UK/lOv3G2w==
-----END CERTIFICATE-----

Subject	CN=Xiaomi Root CA(EC-P384), O=Xiaomi Inc., L=Beijing, ST=Beijing, C=CN
-----BEGIN CERTIFICATE-----
MIICeDCCAf6gAwIBAgITAJQBmyrWaBV3JOroB8uDgC0MxDAKBggqhkjOPQQDAzBp
MQswCQYDVQQGEwJDTjEQMA4GA1UECBMHQmVpamluZzEQMA4GA1UEBxMHQmVpamlu
ZzEUMBIGA1UEChMLWGlhb21pIEluYy4xIDAeBgNVBAMTF1hpYW9taSBSb290IENB
KEVDLVAzODQpMCAXDTI1MDkyNTAxMjI0MFoYDzIwNTAwOTE5MDEyMjQwWjBpMQsw
CQYDVQQGEwJDTjEQMA4GA1UECBMHQmVpamluZzEQMA4GA1UEBxMHQmVpamluZzEU
MBIGA1UEChMLWGlhb21pIEluYy4xIDAeBgNVBAMTF1hpYW9taSBSb290IENBKEVD
LVAzODQpMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEDOfbCvQLZmlcAW7uOnEiCJ3K
pVxu+qYxrwBDbSIRsDc2xg9o94+8pX+mveme5SsSsKM/0ouu5+ECwhkxRof/1BDQ
21cK+n4HBY0G7P3RltI6moeDv4bdVvC4ni+yJpFvo2YwZDAdBgNVHQ4EFgQUm8DQ
DCIUeaz1o+Cc286YCgebcc4wHwYDVR0jBBgwFoAUm8DQDCIUeaz1o+Cc286YCgeb
cc4wEgYDVR0TAQH/BAgwBgEB/wIBAjAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0E
AwMDaAAwZQIwUfj3heoA8iZfAMqHrZwarUM71v3Y1gqlltdgOzv9mix5O/EDxHcQ
m26a9NrrMTXmAjEAgwjR42dkym44QlV+QXR05vuMf1o/bdAXmJKvhjDgPTK9VYRa
gFLaTqFtjuZfDg3L
-----END CERTIFICATE-----

Subject	CN=DigiCert RSA4096 Root for C2PA G1, O=DigiCert, Inc., C=US
-----BEGIN CERTIFICATE-----
MIIFljCCA36gAwIBAgIQL2uv995UIpTpN6WRLwYnHDANBgkqhkiG9w0BAQwFADBS
MQswCQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xKjAoBgNVBAMT
IURpZ2lDZXJ0IFJTQTQwOTYgUm9vdCBmb3IgQzJQQSBHMTAgFw0yNTA4MjcwMDAw
MDBaGA8yMDUwMDgyNjIzNTk1OVowUjELMAkGA1UEBhMCVVMxFzAVBgNVBAoTDkRp
Z2lDZXJ0LCBJbmMuMSowKAYDVQQDEyFEaWdpQ2VydCBSU0E0MDk2IFJvb3QgZm9y
IEMyUEEgRzEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDTX44Mw12/
in3jeV80FcoutZhxtvhZQHAdiFtiYd9Y+quavnHRqtcexRZQ0n1XtGXeiusE72M6
G4dwdTsHXoXVNXjwrO9a/fA/46u+/T5ZU6FyRQdahwQNIXL5PVfqrjwX2Ta2Gby2
z4tbhfzxtgJSosJGJsCGq5mGiBXIqBkbua0YOvuX1WifAuDQun84bw+qwCCWxSty
QuUcZMm6xl24ye5RZnz8xkctz/p68kgNa9IhJlHrZ3CAe1zEu3PrNS7Oq/uzN06t
Ji6rkpXCV6GlhN0RlEPmUb3pg8kYqQ9uca7u4UTyl/F9QqG2xMDgAtNDrfNbWpyO
fnoYGNQvQyD5M7slsz9j9sUcKwspaz8zmuu31UXPqmvME+UalDvFeknQZP+ft9Uv
8eICovCQxvy1Iwg3sjc2hO0lbYYn/JqGARg+5jP/SlkY4dSypdYBtBaAfVxTd+iQ
m4k1oAEIP7ujyQ+1U0F9gygQPwQrMOcyYINgkcsp36rb1znuxlIF6LIcfO1bkVSx
vHqd0CVP8vwrYXKJOr4dES1s4k12kxv+csvZWiuSqY0uhFUSMSE5id5zWW7H6ZCX
3J3Ati2MjyRjyyejDbTQdTS3wlF4f4bLaWidMWSZ3JCyZABXpj46RtdbhZgV7I7B
ZTXCI6FIBuUaiZzW9RHhVzR+qrfBOx40mwIDAQABo2YwZDASBgNVHRMBAf8ECDAG
AQH/AgECMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUVusnOJo+SNZygIWbesMH
UVoE8+UwHwYDVR0jBBgwFoAUVusnOJo+SNZygIWbesMHUVoE8+UwDQYJKoZIhvcN
AQEMBQADggIBAIjcpKt4FeVibq6zP1m2RUagL6PEW+8o5CC5kv0mDMcCgqNTsyNJ
lr/1yYzzpEC82QaCZ34g4eMXnOwq+5jF5xQ5b7RV7X9nFuPXh7r2CittMkBLPKp/
jSApyfEI2qgNtPWc5voKRgPrkSuHu+wB5gTg7AkN9CCZeaauMesIIn7/8lWOSho9
a5DVCJekYh+WcfnSP6l0ilRw1WhnAtPwadhcQ9zJxKe6LSdsH3yNJhViIQNrBhlA
O3BNZF1q2JfOM6TCiY/I+M8AfzuvxF/xyxeDlcRNo6QbfAvUybDOsleg9NxO+EK3
VXTInzaWidoX9TRdEx0iiERj9OB7ehZBwTUllBH6UtxFy3X7YRSnO8ZdjtEERJmk
BNZztgd4KWBnaFMERI0ObiqN1az0uqe8sRULEJ1Ay79sTsJtiemNChMxmYb83XU1
1wSX/W54tD6vPQPCwn84AeLgYSfA10QwRyAo99pwmjZzrCx5uBH7jCVYBkP7iQ6h
o3yHror7znE8LJrrWytOuumEFzxQ0NSaXjrDRKCLKTKnr8niIj+lB/SJsBua52a6
HHRckrpDokgPSPOYI4A+ZGC//Ron9i3S8ce2dQHAWNCqB2ADtnu4Yf36OfmHdrCL
hzIxlPKKDPXwgxv7NTRFs1d7KcIpjYuZp71eZA74ZqxDgVa7CMkhdgML
-----END CERTIFICATE-----

Subject	CN=DigiCert ECC P384 Root for C2PA G1, O=DigiCert, Inc., C=US
-----BEGIN CERTIFICATE-----
MIICSTCCAc+gAwIBAgIQCZ2yarc/T5eBQYVHCJTdyjAKBggqhkjOPQQDAzBTMQsw
CQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xKzApBgNVBAMTIkRp
Z2lDZXJ0IEVDQyBQMzg0IFJvb3QgZm9yIEMyUEEgRzEwIBcNMjUwODI3MDAwMDAw
WhgPMjA1MDA4MjYyMzU5NTlaMFMxCzAJBgNVBAYTAlVTMRcwFQYDVQQKEw5EaWdp
Q2VydCwgSW5jLjErMCkGA1UEAxMiRGlnaUNlcnQgRUNDIFAzODQgUm9vdCBmb3Ig
QzJQQSBHMTB2MBAGByqGSM49AgEGBSuBBAAiA2IABNHiy4U9/SpPSnQ3ogU+q3mn
M/f9zmLuqF8krS0LNUC0T81Nu57WCGSb6149CVpkRRC6BYlfGcBWVYXar4aX10oX
ggSiFPi93ovkAfUN9wikKqVu6amI7tRQPKXJ95UsFaNmMGQwEgYDVR0TAQH/BAgw
BgEB/wIBAjAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFPQYEa4JgolO/Ju0M/b0
370CTpQ2MB8GA1UdIwQYMBaAFPQYEa4JgolO/Ju0M/b0370CTpQ2MAoGCCqGSM49
BAMDA2gAMGUCMQCg31cyC7If2VPMUvqEr08WB6QhRVpAa+GNRlKUOJlSMq/y2tm+
80RTxpV2RsYC9UsCMGkKQ0Yx4FIs1RhYtXVIgTyHrSxGne4/457DlIS+IMIJN5Yd
gMNj6G6tzM47QDGl2w==
-----END CERTIFICATE-----

Subject	CN=DigiCert RSA4096 L1 Claim Signing ICA for C2PA G1, O=DigiCert, Inc., C=US
-----BEGIN CERTIFICATE-----
MIIGxDCCBKygAwIBAgIQJ4BVBbBmDXnyAtI0JLlo5TANBgkqhkiG9w0BAQwFADBS
MQswCQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xKjAoBgNVBAMT
IURpZ2lDZXJ0IFJTQTQwOTYgUm9vdCBmb3IgQzJQQSBHMTAeFw0yNTA4MjcwMDAw
MDBaFw0zMDA4MjYyMzU5NTlaMGIxCzAJBgNVBAYTAlVTMRcwFQYDVQQKEw5EaWdp
Q2VydCwgSW5jLjE6MDgGA1UEAxMxRGlnaUNlcnQgUlNBNDA5NiBMMSBDbGFpbSBT
aWduaW5nIElDQSBmb3IgQzJQQSBHMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCC
AgoCggIBAKiOlc644cuaOoCElG+yGHBmAtfXRw3fSBfRTCf/9yaMQiyEGCxP8HKT
fxtdqD8zmXqePLCLzGM2ccGJx3w5RzpFdOhopwGIKsTm+C1wHmZc5Lws5wst7rFQ
stF8nIN9TBP5H6elZcoNaUhqCJ0bxmeXp6J0iiRKiuLF2j0Grfv4cBL8+XlLRE3g
Of1yqEsEZktfK9qeCUuugltxXwL1WP8IKgtkMeLo0QZQSAg4R+gyX6C1j64nlAtV
RewqSrug+Rkquz94doEscaq3w+ypp8pJ9ovpn9Zdx6PArh4uK90YB/ThB92Voi2x
K8T9D8xnzpONwBfKPiUS502160mZuF09Xgm6zBNRPFKmAdhN73QV4i5Hn2rv5104
AR4QGvz5Egh/bZ5RElIutD/CvVrOS1fykm6ZIVuxqHUx0pxWkAsjRyCE+fuhczhW
QfVy2EUst98kNjUZC/OFF4TxfcWt7xu7CKNZb3rE7nrbMAbPLKPZjAlT7GlmEhaa
dw/Y3ap0sPnO3BtsBP3kOSed3lP3zEfokBLSYsQtwDWzdWanGE3nB2HvBmcviYdi
P48gXP/5uybnVlKUHXb0gBtdYzNTBx3ynoUrWtbNwvMuTKv6mmnuLxhGiEWEK+BY
StlfOiPvUdpyr+TMsaujPpWq9IUX6qmsOcl1gfujK/lJ3kuvSUm3AgMBAAGjggGE
MIIBgDASBgNVHRMBAf8ECDAGAQH/AgEAMBcGA1UdIAQQMA4wDAYKKwYBBAGD6F4B
ATAOBgNVHQ8BAf8EBAMCAQYwgYYGCCsGAQUFBwEBBHoweDAoBggrBgEFBQcwAYYc
aHR0cDovL29jc3Aub25lLmRpZ2ljZXJ0LmNvbTBMBggrBgEFBQcwAoZAaHR0cDov
L2NhY2VydHMub25lLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydFJTQTQwOTZSb290Zm9y
QzJQQUcxLmNydDBNBgNVHR8ERjBEMEKgQKA+hjxodHRwOi8vY3JsLm9uZS5kaWdp
Y2VydC5jb20vRGlnaUNlcnRSU0E0MDk2Um9vdGZvckMyUEFHMS5jcmwwKQYDVR0l
BCIwIAYKKwYBBAGD6F4CAQYIKwYBBQUHAwQGCCsGAQUFBwMkMB0GA1UdDgQWBBTC
mxzaIdNwH6lU5HUf8IFpzcgbRTAfBgNVHSMEGDAWgBRW6yc4mj5I1nKAhZt6wwdR
WgTz5TANBgkqhkiG9w0BAQwFAAOCAgEAt8Kn2LQMxbL10BAx5ebm1G/TMTrgQN9y
f18ZE5qNk3ipoFFtijZzRT5zidKi+/956V11nPMgm90W/CMtapHImj3Da4eoShzl
7N6hPjGYuHJUFfCYaJFxgz0r2sdFYc0drpOlfLa+WVUmgXM8QhbWiHcyk37z8Ega
6p1fjFVH6QqKWwXhSuR5aH0QflBHJKdWRkRZSTNBU2Hj1FOqhZBPPM+jvLGWgkQg
hpQTrO9pTILZ0nb3rTkvClimBewUwTkjoB8M4UHifHcXJ7/RnFzj+KHR5kWdzVTz
uCLcIlTNeACYQZaAj/eT9vzI1n6IUoU04R/9STijYHr05VbH1jM94rDJzjE8Hjf+
f8YV9X/38Rc3gcH1hLzAKqwIyF/XieaquJLXY90O1Ads/WTrNRlf5A4109FKnELd
w8R9vOneDvslbrHxu/MmoanzJlqxW1Sw6tlU0G2kMfyIH9y0RLmTiJndW9UXyzMU
tGID1N2lhdO0BmwBuzCbZWRHCD0NcP9l5Kc8fCL95OgdpRbivEFeGynZZiCjvrJ9
tT+uGWQiBbTlEgR57e1KsEPFKxb0M81ewNEo+vhxaSoWvXv84ZM/Zc9a0ZqPMEPr
3073hQvLguizQTWJQstDjzlmOWF7K6hnI70rTNLhZBEFC3XJlBYxbUMlGdH4ebLc
9IUUXRE00ws=
-----END CERTIFICATE-----

Subject	CN=DigiCert ECC P384 L1 Claim Signing ICA for C2PA G1, O=DigiCert, Inc., C=US
-----BEGIN CERTIFICATE-----
MIIDdzCCAv2gAwIBAgIQUhYZxg4djFjAWbZwab2qqTAKBggqhkjOPQQDAzBTMQsw
CQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xKzApBgNVBAMTIkRp
Z2lDZXJ0IEVDQyBQMzg0IFJvb3QgZm9yIEMyUEEgRzEwHhcNMjUwODI3MDAwMDAw
WhcNMzAwODI2MjM1OTU5WjBjMQswCQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNl
cnQsIEluYy4xOzA5BgNVBAMTMkRpZ2lDZXJ0IEVDQyBQMzg0IEwxIENsYWltIFNp
Z25pbmcgSUNBIGZvciBDMlBBIEcxMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEJ2hi
wBWq/Dldnu/FxGwfHDAmRxezmmKQtIWSd/HYfiJW2T9wNJmSPywB5Kl7WBJXyaxy
Uwhn8tpDqBypcT0hlN8Mi8Cql9yj9t2MJXN3KshCyBiQWjcKnZoOFhW83E1oo4IB
hDCCAYAwEgYDVR0TAQH/BAgwBgEB/wIBADAXBgNVHSAEEDAOMAwGCisGAQQBg+he
AQEwTQYDVR0fBEYwRDBCoECgPoY8aHR0cDovL2NybC5vbmUuZGlnaWNlcnQuY29t
L0RpZ2lDZXJ0RUNDUDM4NFJvb3Rmb3JDMlBBRzEuY3JsMA4GA1UdDwEB/wQEAwIB
BjCBhgYIKwYBBQUHAQEEejB4MCgGCCsGAQUFBzABhhxodHRwOi8vb2NzcC5vbmUu
ZGlnaWNlcnQuY29tMEwGCCsGAQUFBzAChkBodHRwOi8vY2FjZXJ0cy5vbmUuZGln
aWNlcnQuY29tL0RpZ2lDZXJ0RUNDUDM4NFJvb3Rmb3JDMlBBRzEuY3J0MCkGA1Ud
JQQiMCAGCisGAQQBg+heAgEGCCsGAQUFBwMEBggrBgEFBQcDJDAdBgNVHQ4EFgQU
JqGs/hW9GFhOR/R0fNP8EaPxlocwHwYDVR0jBBgwFoAU9BgRrgmCiU78m7Qz9vTf
vQJOlDYwCgYIKoZIzj0EAwMDaAAwZQIwa6ohDos9g13+HZlgKR45C5K3qug4QUi3
tHu79IL601lgQSDgpnclOmJOuWxZFxfGAjEA3kAU5JV6no1hQpZdtb11g+B5wCHW
bUVPYZLXZ1Ie2RaND1QmLeYYKbuqsC58ZtSw
-----END CERTIFICATE-----

Subject	CN=Adobe Product Issuing CA vault-a-or2.adobe.net cai, O=Adobe Inc, L=San Jose, ST=California, C=US
-----BEGIN CERTIFICATE-----
MIIDhDCCAwugAwIBAgIUTNz+Jl3kNFEJK5md8Tp/Cwsm/B4wCgYIKoZIzj0EAwMw
bzELMAkGA1UEBhMCVVMxETAPBgNVBAcTCFNhbiBKb3NlMRMwEQYDVQQKEwpBZG9i
ZSBJbmMuMRAwDgYDVQQLEwdQcm9kdWN0MSYwJAYDVQQDEx1BZG9iZSBQcm9kdWN0
IEludGVybWVkaWF0ZSBDQTAeFw0yNTExMTkxODI5NDRaFw0zMDExMjAwMDMwMTRa
MIGGMTswOQYDVQQDEzJBZG9iZSBQcm9kdWN0IElzc3VpbmcgQ0EgdmF1bHQtYS1v
cjIuYWRvYmUubmV0IGNhaTESMBAGA1UEChMJQWRvYmUgSW5jMQswCQYDVQQGEwJV
UzERMA8GA1UEBxMIU2FuIEpvc2UxEzARBgNVBAgTCkNhbGlmb3JuaWEwdjAQBgcq
hkjOPQIBBgUrgQQAIgNiAASArJB/ZRkabuyoSoGy/6JS124LqMOeKRTruZ4GIxZ3
Rg2UKXeWDINVsgXVewJalg98T0HgeXyXM8Ia0y0dLQUhxT++kVaascgJBuevPs8z
5Z+n+grN03x6ttUORdJ4O9qjggFOMIIBSjASBgNVHRMBAf8ECDAGAQH/AgEAMB8G
A1UdIwQYMBaAFBldp+77+M3A85KlrD7gVNgW7D8UMFsGCCsGAQUFBwEBBE8wTTBL
BggrBgEFBQcwAoY/aHR0cDovL3BraS1jZG4uYWRvYmUubmV0L2NhL2Fkb2JlX2lu
dGVybmFsX2ludGVybWVkaWF0ZV9wcm9kdWN0ME0GA1UdHwRGMEQwQqBAoD6GPGh0
dHA6Ly9wa2ktY2RuLmFkb2JlLm5ldC9hZG9iZV9pbnRlcm5hbF9pbnRlcm1lZGlh
dGVfcHJvZHVjdDAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFC76762PJu/wKMyE
92MRuG8aw1sIMBcGA1UdIAQQMA4wDAYKKwYBBAGD6F4BATAfBgNVHSUEGDAWBgor
BgEEAYPoXgIBBggrBgEFBQcDBDAKBggqhkjOPQQDAwNnADBkAjAfjQ+ZR+qrZcyW
iOVr07JrjClkluOhKPreYGCIQjRXvZPiFPDorO1df9tEIPmJ2Q4CMAIfpEWAmTsA
ggP/MIJIBoTabnBjhwmUcaqRdjK/LuT3KvwkZzZ6R7iPDkQs0d+dQA==
-----END CERTIFICATE-----

Subject	CN=Irdeto C2PA Root CA G1, O=Irdeto BV, C=NL
-----BEGIN CERTIFICATE-----
MIICLDCCAbGgAwIBAgIUL8JDbqsQllkL9gozEdKhKc9GFAcwCgYIKoZIzj0EAwMw
QjELMAkGA1UEBhMCTkwxEjAQBgNVBAoMCUlyZGV0byBCVjEfMB0GA1UEAwwWSXJk
ZXRvIEMyUEEgUm9vdCBDQSBHMTAgFw0yNTEyMDUxMjQ0NDBaGA8yMDUwMTIwNTEy
NDQ0MFowQjELMAkGA1UEBhMCTkwxEjAQBgNVBAoMCUlyZGV0byBCVjEfMB0GA1UE
AwwWSXJkZXRvIEMyUEEgUm9vdCBDQSBHMTB2MBAGByqGSM49AgEGBSuBBAAiA2IA
BEOtgkWt4t4r3Fvn2vDshY1KcZ63/VTaZN7K2uiAcCeztiH+ZSFf4hA5cSCABRJ+
VkWZYLvnhNLsCVbtEij6mDN5hf4VIUdUNgUonGZ6tkL1Djs3CUIkjD+nH/HXbCSj
pqNmMGQwEgYDVR0TAQH/BAgwBgEB/wIBAjAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0O
BBYEFGs1MrTyCBABc00WKVK0njUakyplMB8GA1UdIwQYMBaAFGs1MrTyCBABc00W
KVK0njUakyplMAoGCCqGSM49BAMDA2kAMGYCMQCB1h+esIhAsddoGkZI1aXwwCFM
wL/cHskaM8JZsvUfcecGQmG08ZVesfUeCzei0SECMQCLjWbR4LY1mgfF+PzlieDZ
9DTcd5qOpJaSf90/8AnQA/UWGtRGqJsrmERInDoXEOA=
-----END CERTIFICATE-----

Subject	emailAddress=ca@tauth.io, CN=Tauth Root CA, OU=CA Division, O=Tauth Labs Inc., L=New York, ST=New York, C=US
-----BEGIN CERTIFICATE-----
MIIDjzCCAxWgAwIBAgIUW6zwDse+LBk8Yvy/u3p7lSjnaA4wCgYIKoZIzj0EAwMw
gZcxCzAJBgNVBAYTAlVTMREwDwYDVQQIDAhOZXcgWW9yazERMA8GA1UEBwwITmV3
IFlvcmsxGDAWBgNVBAoMD1RhdXRoIExhYnMgSW5jLjEUMBIGA1UECwwLQ0EgRGl2
aXNpb24xFjAUBgNVBAMMDVRhdXRoIFJvb3QgQ0ExGjAYBgkqhkiG9w0BCQEWC2Nh
QHRhdXRoLmlvMB4XDTI2MDEwNTE2MDgzMVoXDTQ1MTIzMTE2MDgzMVowgZcxCzAJ
BgNVBAYTAlVTMREwDwYDVQQIDAhOZXcgWW9yazERMA8GA1UEBwwITmV3IFlvcmsx
GDAWBgNVBAoMD1RhdXRoIExhYnMgSW5jLjEUMBIGA1UECwwLQ0EgRGl2aXNpb24x
FjAUBgNVBAMMDVRhdXRoIFJvb3QgQ0ExGjAYBgkqhkiG9w0BCQEWC2NhQHRhdXRo
LmlvMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAETgpV7Q9tsMzXFPduTyVt71IRRfU0
yeZGVuXmVO6zyUXxqGCg07jafnMyv24pRwJ9Bk+ROhslNWFS0NhXjIINDuk4h5Ji
KcEEGBJIlGl7jOB/MPLF/HU7CfURT2ayXKXmo4IBHjCCARowHQYDVR0OBBYEFB3R
AQfd1ulUQKBf+J34TnS1CxI+MIHXBgNVHSMEgc8wgcyAFB3RAQfd1ulUQKBf+J34
TnS1CxI+oYGdpIGaMIGXMQswCQYDVQQGEwJVUzERMA8GA1UECAwITmV3IFlvcmsx
ETAPBgNVBAcMCE5ldyBZb3JrMRgwFgYDVQQKDA9UYXV0aCBMYWJzIEluYy4xFDAS
BgNVBAsMC0NBIERpdmlzaW9uMRYwFAYDVQQDDA1UYXV0aCBSb290IENBMRowGAYJ
KoZIhvcNAQkBFgtjYUB0YXV0aC5pb4IUW6zwDse+LBk8Yvy/u3p7lSjnaA4wDwYD
VR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwCgYIKoZIzj0EAwMDaAAwZQIx
AJzhLaivtrjOMyEAuoHQRIhN2u7kw2iWZZyAT6FJH4+GBYudax0dfewXeIvC0MH5
SwIwAKojdigAO86Xvk6++B875ZpTjQIysPX0bGumbmAwcAmsqum9JLLIRCDz+7Kt
WrRP
-----END CERTIFICATE-----

Subject	CN=HUAWEI C2PA ECC384 Root CA E346, O=Huawei Technologies Co., Ltd., C=CN
-----BEGIN CERTIFICATE-----
MIICoDCCAiagAwIBAgIIKsblXSNLwF8wCgYIKoZIzj0EAwMwXzELMAkGA1UEBhMC
Q04xJjAkBgNVBAoMHUh1YXdlaSBUZWNobm9sb2dpZXMgQ28uLCBMdGQuMSgwJgYD
VQQDDB9IVUFXRUkgQzJQQSBFQ0MzODQgUm9vdCBDQSBFMzQ2MB4XDTI2MDQxMzAx
NTQxMFoXDTQ2MDQwODAxNTQxMFowXzELMAkGA1UEBhMCQ04xJjAkBgNVBAoMHUh1
YXdlaSBUZWNobm9sb2dpZXMgQ28uLCBMdGQuMSgwJgYDVQQDDB9IVUFXRUkgQzJQ
QSBFQ0MzODQgUm9vdCBDQSBFMzQ2MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEOrBo
SivfM2LRlG3B4r52hE0vDjQR2iWv9sKTZXzkscQIasoH+uYBDDie9VcosH4Mfq/U
xN8ojhW7BZW38LT38SmYpJPZirtzKTyCD4ha4dU8tLcHoJsOn3p+kBw09Bvoo4Gu
MIGrMB8GA1UdIwQYMBaAFM/OyEcEDscO78w/okatAmz35ypMMB0GA1UdDgQWBBTP
zshHBA7HDu/MP6JGrQJs9+cqTDASBgNVHRMBAf8ECDAGAQH/AgECMEUGCCsGAQUF
BwELBDkwNzA1BggrBgEFBQcwBYYpaHR0cDovL2NhLmh1YXdlaWNsb3VkLmNvbS9y
ZXBvc2l0b3J5Lmh0bWwwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUC
MDCsqpRvJIPw6OAQi2Rj0CWnwJgK75YK5gj+K9xomIDu8ai/2ExrifL8JgROQOeZ
egIxAL3tT3Dp84wP18ohYU83gkRcA8j9B3T4BRpxY1Ew9IJMYJ2zqz0weFjAEGNC
9Z36XQ==
-----END CERTIFICATE-----

Subject	CN=Huanyu Trust C2PA EC-384 Root CA, O=Huanyu Trust Ltd, C=CN
-----BEGIN CERTIFICATE-----
MIICTTCCAdOgAwIBAgIUCqsLOXYNHdz0EBDsWKcrsiBcF10wCgYIKoZIzj0EAwMw
UzELMAkGA1UEBhMCQ04xGTAXBgNVBAoTEEh1YW55dSBUcnVzdCBMdGQxKTAnBgNV
BAMTIEh1YW55dSBUcnVzdCBDMlBBIEVDLTM4NCBSb290IENBMCAXDTI2MDQxMzA2
MDUwOVoYDzIwNTEwNDEzMDYwNTA5WjBTMQswCQYDVQQGEwJDTjEZMBcGA1UEChMQ
SHVhbnl1IFRydXN0IEx0ZDEpMCcGA1UEAxMgSHVhbnl1IFRydXN0IEMyUEEgRUMt
Mzg0IFJvb3QgQ0EwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARDnAlELrIETK81oB6E
/ZfbkGSH9YPhGdFpXTzDCHD3IsKPQdPPv/mF319XjdrZMECxpH9rbmWGuWrhq6K8
zIGO27H2MUE658XNu6aO5xcZV/YdAMkG/YWPYo9CmCT4/SujZjBkMBIGA1UdEwEB
/wQIMAYBAf8CAQIwHwYDVR0jBBgwFoAUYc0ZfGc1yTPouBQYj81mEEdaefswHQYD
VR0OBBYEFGHNGXxnNckz6LgUGI/NZhBHWnn7MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAwNoADBlAjEAqfQxNSnmGxtt1QBKJbaY8AyUiaJxzX5MnH0l/ielnc6D
qBhIcALvKKc3a8MizR01AjB85bwUFBgs6WlIWZ6sFDDbCQzrWpPU11YQnj/mGom7
yXjL/2axHPWPY2Do/ldP5mc=
-----END CERTIFICATE-----

Subject	CN=Verimago Root CA, O=Verimago LLC, ST=Washington, C=US
-----BEGIN CERTIFICATE-----
MIICTjCCAdSgAwIBAgIVAOFSVdVKiaIUGZlbNzPTi5bS/Gy+MAoGCCqGSM49BAMD
MFQxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRUwEwYDVQQKEwxW
ZXJpbWFnbyBMTEMxGTAXBgNVBAMTEFZlcmltYWdvIFJvb3QgQ0EwHhcNMjYwNTE1
MDE0NjUwWhcNNDYwNTE1MDE0NjUwWjBUMQswCQYDVQQGEwJVUzETMBEGA1UECBMK
V2FzaGluZ3RvbjEVMBMGA1UEChMMVmVyaW1hZ28gTExDMRkwFwYDVQQDExBWZXJp
bWFnbyBSb290IENBMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAExn74thYXg89OFcXC
obav4kqQAt0YDK4h28ovPP5RJWs77BBRwUhbdb0C6SMVFJ+MuyUK/cBoua+cSIOh
N6prHNqeHbZMi3nzlbVfEbDDWm9hy+OxXtOLlJQYL5zjUgkco2YwZDASBgNVHRMB
Af8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUAkmvpVkpKvS1
2ZHgaoysoshW7XowHwYDVR0jBBgwFoAUAkmvpVkpKvS12ZHgaoysoshW7XowCgYI
KoZIzj0EAwMDaAAwZQIwDqzc2oVzZezm4GeER3jPUDWNj4zsqdXciOoGO0JkAHmC
vyUBt8FH9vZK9d6bZ9DEAjEA5eFk9oFV8cm8pyJ2+hKo5ji/iip8A0T5U2GwHQyN
W4GXdTaTwkzPD7X6whoLKKB/
-----END CERTIFICATE-----

Subject	CN=Verimago Claim Signing Issuing CA, O=Verimago LLC, ST=Washington, C=US
-----BEGIN CERTIFICATE-----
MIIDTDCCAtOgAwIBAgIUNcPH/7deevUcZvKM0EQGUJN99PMwCgYIKoZIzj0EAwMw
VDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xFTATBgNVBAoTDFZl
cmltYWdvIExMQzEZMBcGA1UEAxMQVmVyaW1hZ28gUm9vdCBDQTAeFw0yNjA1MTUw
MTQ2NTBaFw0zMTA1MTUwNzQ2NTBaMGUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpX
YXNoaW5ndG9uMRUwEwYDVQQKEwxWZXJpbWFnbyBMTEMxKjAoBgNVBAMTIVZlcmlt
YWdvIENsYWltIFNpZ25pbmcgSXNzdWluZyBDQTB2MBAGByqGSM49AgEGBSuBBAAi
A2IABPB0fzGODSoLVNkTQWekSBkL6rD2h2//WP+4f1pdl9K8K0Z8Bt0SrlOXNtrp
I/ytOybRwV7nH3TDAWkZV833jc8Gjgqs7P0Q4ZZc4+4WIey3eD9084B8rLXs3/K/
q7NyHaOCAVMwggFPMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEG
MCkGA1UdJQQiMCAGCisGAQQBg+heAgEGCCsGAQUFBwMEBggrBgEFBQcDJDAXBgNV
HSAEEDAOMAwGCisGAQQBg+heAQEwHQYDVR0OBBYEFCM0wx5MWMCrBF5eYt8J9b41
TMwcMB8GA1UdIwQYMBaAFAJJr6VZKSr0tdmR4GqMrKLIVu16MDsGA1UdHwQ0MDIw
MKAuoCyGKmh0dHA6Ly9jYS52ZXJpbWFnby5pby9jcmwvaW50ZXJtZWRpYXRlLmNy
bDBoBggrBgEFBQcBAQRcMFowJgYIKwYBBQUHMAGGGmh0dHA6Ly9jYS52ZXJpbWFn
by5pby9vY3NwMDAGCCsGAQUFBzAChiRodHRwOi8vY2EudmVyaW1hZ28uaW8vY2Vy
dHMvcm9vdC5wZW0wCgYIKoZIzj0EAwMDZwAwZAIwDq2qaR9as+lyVFcwsUTlMIm/
OGxgW4dqVg7jlsBST+3xvS0nIpZUS7lcF44FVcFdAjA5abgOYS/ie7NXxp3smYtu
FoKzc/V7TAaL0VS/HGB3x7sTa+D6HIY3/ls33Dy/4Gk=
-----END CERTIFICATE-----

Subject	CN=Snowball ECC P384 Root CA for C2PA G1, O=Snowball Technology Co., Ltd., C=CN
-----BEGIN CERTIFICATE-----
MIICiTCCAg6gAwIBAgIUVlsRGj1G9vJ4ws2jMYyFlFcKUokwCgYIKoZIzj0EAwMw
ZTELMAkGA1UEBhMCQ04xJjAkBgNVBAoMHVNub3diYWxsIFRlY2hub2xvZ3kgQ28u
LCBMdGQuMS4wLAYDVQQDDCVTbm93YmFsbCBFQ0MgUDM4NCBSb290IENBIGZvciBD
MlBBIEcxMB4XDTI2MDYxODA5MzkxOVoXDTQ2MDYxMzA5MzkxOVowZTELMAkGA1UE
BhMCQ04xJjAkBgNVBAoMHVNub3diYWxsIFRlY2hub2xvZ3kgQ28uLCBMdGQuMS4w
LAYDVQQDDCVTbm93YmFsbCBFQ0MgUDM4NCBSb290IENBIGZvciBDMlBBIEcxMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAELJUrcxeVmmYrb8Kl/YVAYYFiyuiqiIa6z/1n
FoCpB2JV/Qkwjdns7rOvLheWBi1s880NcwqD/KD9t9/SOgWTfD+WOAhtPioAql2Y
YUl0toOUzoXaAOB3+HIQRiKsL2RIo38wfTASBgNVHRMBAf8ECDAGAQH/AgECMA4G
A1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU6R4F1vboIaKQly8jCAQX2lQhWPQwHwYD
VR0jBBgwFoAU6R4F1vboIaKQly8jCAQX2lQhWPQwFwYDVR0gBBAwDjAMBgorBgEE
AYPoXgEBMAoGCCqGSM49BAMDA2kAMGYCMQD6/xszsnZoYt+gYIsgYKTMFARxRpB5
N16s2u2hgkuFs4zyLco1z7gOk0mv6EbBkm0CMQCcsqIQnr45MVjDUdn9L//VdGDO
6H+P67vBdmvb3LiLTB+Ey/JYYfnHHIKzJrRG4ls=
-----END CERTIFICATE-----

Subject	CN=Snowball ECC P384 Claim Signing ICA for C2PA G1, O=Snowball Technology Co., Ltd., C=CN
-----BEGIN CERTIFICATE-----
MIIDrjCCAzSgAwIBAgIUMPJ1KkDp+fvHaZOBsdKSnPm/hdowCgYIKoZIzj0EAwMw
ZTELMAkGA1UEBhMCQ04xJjAkBgNVBAoMHVNub3diYWxsIFRlY2hub2xvZ3kgQ28u
LCBMdGQuMS4wLAYDVQQDDCVTbm93YmFsbCBFQ0MgUDM4NCBSb290IENBIGZvciBD
MlBBIEcxMB4XDTI2MDYxODA5NDQ1OVoXDTMxMDYxOTA5NDQ1OVowbzELMAkGA1UE
BhMCQ04xJjAkBgNVBAoMHVNub3diYWxsIFRlY2hub2xvZ3kgQ28uLCBMdGQuMTgw
NgYDVQQDDC9Tbm93YmFsbCBFQ0MgUDM4NCBDbGFpbSBTaWduaW5nIElDQSBmb3Ig
QzJQQSBHMTB2MBAGByqGSM49AgEGBSuBBAAiA2IABJvqMpOfFPJuwAV3s2YGMbe7
mRj48rsUZsJrMSOWU3SnssFtPEWTFh8QyM88zaFuprKC8nm53vnEMkGG+YtmZdBf
zsmayZqs9Rq6EQchDSF2vVNvE9wxAqhKJIawhYSTe6OCAZkwggGVMBIGA1UdEwEB
/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMCkGA1UdJQQiMCAGCisGAQQBg+he
AgEGCCsGAQUFBwMEBggrBgEFBQcDJDAdBgNVHQ4EFgQUt0FFkasBa70GGSB6Ntn5
2UCzqwYwHwYDVR0jBBgwFoAU6R4F1vboIaKQly8jCAQX2lQhWPQwFwYDVR0gBBAw
DjAMBgorBgEEAYPoXgEBMIGUBggrBgEFBQcBAQSBhzCBhDAtBggrBgEFBQcwAYYh
aHR0cDovL29jc3AuYzJwYS5zbm93YmFsbHRlY2guY29tMFMGCCsGAQUFBzAChkdo
dHRwOi8vY2FjZXJ0cy5jMnBhLnNub3diYWxsdGVjaC5jb20vU25vd2JhbGxFQ0NQ
Mzg0Um9vdENBZm9yQzJQQUcxLmNydDBUBgNVHR8ETTBLMEmgR6BFhkNodHRwOi8v
Y3JsLmMycGEuc25vd2JhbGx0ZWNoLmNvbS9Tbm93YmFsbEVDQ1AzODRSb290Q0Fm
b3JDMlBBRzEuY3JsMAoGCCqGSM49BAMDA2gAMGUCMQCp0U69fhqepzep6uvRFmGg
e+mgVJX1a2JsC3m+W6GAA62UruIAskoTmrEC0iZXMwYCMAcKDRNtDSwk9balyQ/8
RUPGGwGS2AvOsUC0H84jMBNCL+DlPg7dJz1gc32QCv9sWA==
-----END CERTIFICATE-----

Subject	CN=Encypher C2PA Root CA 2026, OU=CA Division, O=Encypher Corp., L=San Francisco, ST=California, C=US
-----BEGIN CERTIFICATE-----
MIIDFDCCApqgAwIBAgIUS2zOIYRKaa59snU3NcNFadfTtoAwCgYIKoZIzj0EAwMw
gY4xCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1T
YW4gRnJhbmNpc2NvMRcwFQYDVQQKDA5FbmN5cGhlciBDb3JwLjEUMBIGA1UECwwL
Q0EgRGl2aXNpb24xIzAhBgNVBAMMGkVuY3lwaGVyIEMyUEEgUm9vdCBDQSAyMDI2
MB4XDTI2MDUyMjEzNDk1NloXDTQ2MDUxNzEzNDk1NlowgY4xCzAJBgNVBAYTAlVT
MRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4gRnJhbmNpc2NvMRcw
FQYDVQQKDA5FbmN5cGhlciBDb3JwLjEUMBIGA1UECwwLQ0EgRGl2aXNpb24xIzAh
BgNVBAMMGkVuY3lwaGVyIEMyUEEgUm9vdCBDQSAyMDI2MHYwEAYHKoZIzj0CAQYF
K4EEACIDYgAE27XmRBc4mE0dYfUhLiuPiAnY3tRDMke9evylB+VgyMspT1svR9h3
KXxr8tml+1oM82US+pw2jJenfUxoUJGVDY/lvwl+4Q+7vawXFd26yPv/CQSnhI+w
05+yiSiwshIOo4G2MIGzMBIGA1UdEwEB/wQIMAYBAf8CAQEwDgYDVR0PAQH/BAQD
AgEGMB0GA1UdDgQWBBS3gC7ps3/HLQbb3uuqL4U8gDnKEDAfBgNVHSMEGDAWgBS3
gC7ps3/HLQbb3uuqL4U8gDnKEDBNBgNVHSAERjBEMEIGCisGAQQBg+heAQEwNDAy
BggrBgEFBQcCARYmaHR0cHM6Ly9jYS5lbmN5cGhlci5jb20vcmVwb3NpdG9yeS9j
cHMwCgYIKoZIzj0EAwMDaAAwZQIwYeb83YEb/Oh9uELuvO9jpb85orRWWQiceqf0
sCwxtJw07/giyy/hI1BFvbQZcfkLAjEAj8jfwuJSJ9LjeeYL/VXStQWDHewxbIou
IKdYpS9ZBidpsi+01tpQY1j7apLAXMHO
-----END CERTIFICATE-----

Subject	CN=Encypher C2PA Issuing CA 2026, OU=CA Division, O=Encypher Corp., L=San Francisco, ST=California, C=US
-----BEGIN CERTIFICATE-----
MIID6zCCA3GgAwIBAgIUXzMIOXOrlyOjfKthGAPSSBM5n3UwCgYIKoZIzj0EAwMw
gY4xCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1T
YW4gRnJhbmNpc2NvMRcwFQYDVQQKDA5FbmN5cGhlciBDb3JwLjEUMBIGA1UECwwL
Q0EgRGl2aXNpb24xIzAhBgNVBAMMGkVuY3lwaGVyIEMyUEEgUm9vdCBDQSAyMDI2
MB4XDTI2MDUyMjEzNDk1NloXDTMxMDUyMzEzNDk1NlowgZExCzAJBgNVBAYTAlVT
MRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4gRnJhbmNpc2NvMRcw
FQYDVQQKDA5FbmN5cGhlciBDb3JwLjEUMBIGA1UECwwLQ0EgRGl2aXNpb24xJjAk
BgNVBAMMHUVuY3lwaGVyIEMyUEEgSXNzdWluZyBDQSAyMDI2MHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAEINEuEOHZL9o8vKynpXV9O+04syCIj+WeydlgTMJBMhiZ8MhE
yig+4R0kmGpX/RZjgSSQh/aQ4NYpv9SHx1r1t3agJEpfYv/jZB4AfeGC47OiEREe
wKHBWD1cVg6qrFtVo4IBiTCCAYUwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8B
Af8EBAMCAQYwIAYDVR0lBBkwFwYKKwYBBAGD6F4CAQYJKoZIhvcvAQEFMB0GA1Ud
DgQWBBT5K7GC8GHRLCg4CpI6Owg8ubeZ8DAfBgNVHSMEGDAWgBS3gC7ps3/HLQbb
3uuqL4U8gDnKEDA3BgNVHR8EMDAuMCygKqAohiZodHRwOi8vY2EuZW5jeXBoZXIu
Y29tL2NybC9yb290LWNhLmNybDB1BggrBgEFBQcBAQRpMGcwJwYIKwYBBQUHMAGG
G2h0dHA6Ly9jYS5lbmN5cGhlci5jb20vb2NzcDA8BggrBgEFBQcwAoYwaHR0cDov
L2NhLmVuY3lwaGVyLmNvbS9yZXBvc2l0b3J5L2lzc3VpbmctY2EuY3J0ME0GA1Ud
IARGMEQwQgYKKwYBBAGD6F4BATA0MDIGCCsGAQUFBwIBFiZodHRwczovL2NhLmVu
Y3lwaGVyLmNvbS9yZXBvc2l0b3J5L2NwczAKBggqhkjOPQQDAwNoADBlAjABzhlt
QpFyat0q5DZPJh+XvWnRAUej/4yrnPkQgtZZufnTVg9csupYAtdD8EVvkJ8CMQDK
aReb1d/xaGyypi9HwEqVRaEClhopAogb+8VtoUbBD/3mKv0rGlYOUa9heE2DRkw=
-----END CERTIFICATE-----

Subject	CN=TrustAsia C2PA RSA Root CA, O=TrustAsia Technologies, Inc., C=CN
-----BEGIN CERTIFICATE-----
MIIFqDCCA5CgAwIBAgIUNqYa1cdsY+cp091HGRPKXzrE4kwwDQYJKoZIhvcNAQEM
BQAwWTELMAkGA1UEBhMCQ04xJTAjBgNVBAoMHFRydXN0QXNpYSBUZWNobm9sb2dp
ZXMsIEluYy4xIzAhBgNVBAMMGlRydXN0QXNpYSBDMlBBIFJTQSBSb290IENBMCAX
DTI2MDYwNTAzNTMwMFoYDzIwNTEwNjA1MDM1MjU5WjBZMQswCQYDVQQGEwJDTjEl
MCMGA1UECgwcVHJ1c3RBc2lhIFRlY2hub2xvZ2llcywgSW5jLjEjMCEGA1UEAwwa
VHJ1c3RBc2lhIEMyUEEgUlNBIFJvb3QgQ0EwggIiMA0GCSqGSIb3DQEBAQUAA4IC
DwAwggIKAoICAQCvgJqlqXZ+SYbtl9dLK4SQ5Gt9KrPbOmWEeMYnh8UdB3+KzkrG
6PSZ1/s6KDIiEPNH1Sno7UOnTWzZ50Ce3Qq4PKFJBb9iJ0cbtw4qGOjHDhgXhozv
nPQhXy6uiEODKgsKRaZwxT7xer3ZOAbX/30tQDwyAavoEtb+F+o2faYxHwjojUnK
zO0Aaz68h7U5zMHgdMUvkqc0B5NIpoTixCj7Om2X0XROWAFx7ELrVxMmyL4PCWOj
caRXoP5QlDHiIc5Ck9/HD6VYr2jJG/8BFZqk9l+mgNlxjaIbp0D/B3D7WvxcGOFR
qiRJRni3LAsdVAMGPs/msUVBsYnTIEWb1o8qvkKpPOE0OtseEhWIQX4EDTA3Kim1
xVqcS3+9irfDf7Jda2vOX1mamZa+Y89xCZcG7ce4u0fpE/NOs46dymoG/zU0uUvd
KOtzvddNuDOWymROa6SVG6uETSdVFRsQfR/Dp8MQegVLB6ITAfnXHc3Pn67B1ncs
L359DcwlZkqYGegsz//8ToRAlSSA/9C9vzlXfbGIg2HHtToHcwa6BjDkRpfdm6nk
egfCvoaWT4k/9vDQNXvg8Wee1vpUDKhB7y1SSaSkm+7wr8fV4ovFGSrbygpr0BuG
m+ShU3Vh+8UXAICPntscPAgNXidB9A8Zgib5rJjiVi0sxizPYueAchPQDwIDAQAB
o2YwZDASBgNVHRMBAf8ECDAGAQH/AgECMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4E
FgQUCdViRLQz3hH0IboHIKjSrMMHRYAwHwYDVR0jBBgwFoAUCdViRLQz3hH0IboH
IKjSrMMHRYAwDQYJKoZIhvcNAQEMBQADggIBAHInmN938SAQOkERvIrZDi14uVmZ
P5GgqQ6ZH4BF77RFcQcDl7Id+3WBf1WqSl0zyuq6HulYyM6pWikh0W5K/NBBLlt+
zXtEHbW71jhAhCKALdbclT+KuqRRQbrzATXPyYB5Jb/7xlUIofilo70+lqNwahsy
Y5F+6XlOZ4JuA84RdfxGdyn/IJlOJ9mc2RbI6aAxMuFcsot483gOYtkU4Og0g9M7
XsdLT2VXwuVk3hXwc7UWlZUm1Vn6dGmrcSj41wGlw9JGMU87OfzYFseGBDGDc2Xv
njFCY+SBAEWGk4m6ugNGat8OKBVNpnYGp0iNODMtQXJ0aUCvOziFPJY9li08sUDe
HI9ZwLB+yADsaC1gaX4eloRFsIyyl7YRQEY1/EfVw3wnN+XBJYyBw9v1RtpXDh/v
O2ezzXc1sdH/WgXMGGrRdiCAZb5mFkjTEoKXVnkGMn7bnJKuFgDQPWerA24Jck1J
QTuQBXJOAt8FVaYMjL6wPSIv84UjVXIRkOP4ZOydpYgykEl5LfOWcQtA4U6h+obS
35aB8YE1KC9rIeEE8q5onGo6tRYJzh+mB/XSUP35fNbwe4FkI3I6ZpNSS6wt9HY0
DCYCNhAz7KP8RwexR/stlYyeUxbj3+jxK4AOGTZQEKBBWkoqfrPCDpybwpXCxxP5
qtj6+iKCvpx9jmvr
-----END CERTIFICATE-----

Subject	CN=TrustAsia C2PA ECC Root CA, O=TrustAsia Technologies, Inc., C=CN
-----BEGIN CERTIFICATE-----
MIICWjCCAd+gAwIBAgIUdUWMu3G69tNb9bwz/0KTupxLm1kwCgYIKoZIzj0EAwMw
WTELMAkGA1UEBhMCQ04xJTAjBgNVBAoMHFRydXN0QXNpYSBUZWNobm9sb2dpZXMs
IEluYy4xIzAhBgNVBAMMGlRydXN0QXNpYSBDMlBBIEVDQyBSb290IENBMCAXDTI2
MDYwNTAzNTAwMFoYDzIwNTEwNjA1MDM0OTU5WjBZMQswCQYDVQQGEwJDTjElMCMG
A1UECgwcVHJ1c3RBc2lhIFRlY2hub2xvZ2llcywgSW5jLjEjMCEGA1UEAwwaVHJ1
c3RBc2lhIEMyUEEgRUNDIFJvb3QgQ0EwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQL
ERY0d7ug9MiCqmXnDjDs2med9zfTqTWOcG3OD5Q6FSEgNUcjT5Qy7xzKn1MfqaY4
Ye3sf+Do7cCDR6AiFW6SqLQobfJ70jMDsSQYlrCCjMLvb+NdNPhED43s8fgehxyj
ZjBkMBIGA1UdEwEB/wQIMAYBAf8CAQIwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQW
BBT13DKCd7Jlz2rEe0vBlwo/CoR2mDAfBgNVHSMEGDAWgBT13DKCd7Jlz2rEe0vB
lwo/CoR2mDAKBggqhkjOPQQDAwNpADBmAjEAwp2Jie8k6/haTc/df3QsX+Ttg7Wp
ARtYTwJSP4Z+ggpf39sZ+7QPOE50BqBj9Q6zAjEAjZ+5glED9tav6r3jWuMOmKTB
kobBXzvjqTDLGG570BbSQfNmS3HRC6u5YTIpElpb
-----END CERTIFICATE-----
`,Ue=null;function be(){if(Ue)return Ue;let t=($t+`
`+en).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[],n=[],r=new Set;for(let o of t){let a=o.replace(/[^A-Za-z0-9+/]/g,"");if(!r.has(a)){r.add(a);try{n.push(le(o))}catch{}}}return Ue=n,n}var I={credentialUnreadable:"credential.unreadable",assertionHashedUriMatch:"assertion.hashedURI.match",assertionHashedUriMismatch:"assertion.hashedURI.mismatch",assertionMissing:"assertion.missing",claimSignatureValidated:"claimSignature.validated",claimSignatureMismatch:"claimSignature.mismatch",claimSignatureInsideValidity:"claimSignature.insideValidity",signingCredentialExpired:"signingCredential.expired",signingCredentialTrusted:"signingCredential.trusted",signingCredentialUntrusted:"signingCredential.untrusted",assertionDataHashMatch:"assertion.dataHash.match",assertionDataHashMismatch:"assertion.dataHash.mismatch",assertionBmffHashMatch:"assertion.bmffHash.match",assertionBmffHashMismatch:"assertion.bmffHash.mismatch"};function nt(e){let t=e.checks.filter(n=>!n.ok&&n.code!==I.signingCredentialUntrusted);return t.length===1&&t[0].code===I.signingCredentialExpired}function xe(e){let t=nt(e),n=e.trusted&&e.state==="valid",r=e.madeWithLolly?"lolly":n&&e.delivered?"delivered":n?"trusted":e.state==="invalid"&&e.likelyMadeWithLolly?"likelyLolly":e.state==="invalid"&&t?"expired":e.state==="valid"||e.state==="invalid"||e.state==="none"?e.state:"none";return{state:r,tone:r==="invalid"?"bad":r==="expired"||r==="likelyLolly"?"warn":r==="none"?"none":"good",trusted:n,expiredOnly:t,madeWithLolly:e.madeWithLolly,likelyMadeWithLolly:e.likelyMadeWithLolly,partsMadeWithLolly:e.partsMadeWithLolly,delivered:e.delivered,identity:e.signer?.identity??null}}var Ge=new TextDecoder,tn=new TextEncoder,Ie=Symbol("cbor break"),nn=64;function ie(e,t,n=0){if(t>=e.length)throw new Error("cbor: truncated");if(n>nn)throw new Error("cbor: nesting too deep");let r=e[t++],o=r>>5,a=r&31,i=a===31,A=s=>{if(t+s>e.length)throw new Error("cbor: truncated length head")};if(i){if(o<2||o===6)throw new Error("cbor: reserved indefinite head");if(o===7)return[Ie,t]}else if(a===24)A(1),a=e[t],t+=1;else if(a===25)A(2),a=e[t]<<8|e[t+1],t+=2;else if(a===26)A(4),a=e[t]*16777216+(e[t+1]<<16|e[t+2]<<8|e[t+3]),t+=4;else if(a===27)A(8),a=Number(new DataView(e.buffer,e.byteOffset+t,8).getBigUint64(0)),t+=8;else if(a>27)throw new Error("cbor: reserved length head");switch(o){case 0:return[a,t];case 1:return[-1-a,t];case 2:case 3:{if(i){let s=[];for(;;){let[l,g]=ie(e,t,n+1);if(t=g,l===Ie)break;s.push(o===2?l:tn.encode(l))}let c=M(s);return[o===2?c:Ge.decode(c),t]}if(t+a>e.length)throw new Error("cbor: truncated string");return[o===2?e.slice(t,t+a):Ge.decode(e.slice(t,t+a)),t+a]}case 4:{let s=[];for(let c=0;i||c<a;c++){let[l,g]=ie(e,t,n+1);if(t=g,l===Ie)break;s.push(l)}return[s,t]}case 5:{let s=new Map;for(let c=0;i||c<a;c++){let[l,g]=ie(e,t,n+1);if(l===Ie){t=g;break}let[d,f]=ie(e,g,n+1);s.set(l,d),t=f}return[s,t]}case 6:{let[s,c]=ie(e,t,n+1);return[{tag:a,value:s},c]}default:{if(a===20)return[!1,t];if(a===21)return[!0,t];if(a===22||a===23)return[null,t];let s=r&31;if(s===25){let c=e[t-2]<<8|e[t-1],l=c&32768?-1:1,g=c>>10&31,d=c&1023;return[g===0?l*d*2**-24:g===31?d?NaN:l*(1/0):l*(1+d/1024)*2**(g-15),t]}if(s===26)return[new DataView(e.buffer,e.byteOffset+t-4,4).getFloat32(0),t];if(s===27)return[new DataView(e.buffer,e.byteOffset+t-8,8).getFloat64(0),t];throw new Error("cbor: unsupported simple value")}}}function H(e){let[t,n]=ie(e,0);if(n!==e.length)throw new Error("cbor: trailing bytes after item");return t}function Se(e,t,n){let r=[],o=t;for(;o<n;){if(o+8>n)throw new Error("jumbf: truncated box header");let a=new DataView(e.buffer,e.byteOffset).getUint32(o),i=String.fromCharCode(e[o+4],e[o+5],e[o+6],e[o+7]);if(a<8||o+a>n)throw new Error(`jumbf: box ${i} overruns its container`);r.push({type:i,start:o,payloadStart:o+8,end:o+a}),o+=a}return r}function O(e,t){if(t.type!=="jumb")throw new Error(`jumbf: expected superbox, got ${t.type}`);let n=Se(e,t.payloadStart,t.end),r=n[0];if(!n.length||!r||r.type!=="jumd")throw new Error("jumbf: superbox missing description box");let o=b(e.slice(r.payloadStart,r.payloadStart+16)),a=e.slice(r.payloadStart+17,r.end),i=a.indexOf(0);return{uuid:o,label:i>=0?Ge.decode(a.slice(0,i)):"",children:n.slice(1),box:t}}var se=(e,t)=>e.slice(t.children[0].payloadStart,t.children[0].end);function ot(e){let t=Se(e,0,e.length);if(!t.length)throw new Error("empty manifest store");let n=O(e,t[0]);if(n.label!=="c2pa")throw new Error(`store label is '${n.label}', expected 'c2pa'`);if(!n.children.length)throw new Error("store has no manifest");let r=O(e,n.children[n.children.length-1]),o={manifestLabel:r.label,assertions:[],claimVersion:1};for(let a of r.children){let i=O(e,a);if(i.label==="c2pa.assertions")for(let A of i.children){let s=O(e,A);o.assertions.push({label:s.label,content:se(e,s),payload:e.slice(s.box.start+8,s.box.end)})}else i.label==="c2pa.claim"?(o.claimBytes=se(e,i),o.claimVersion=1):i.label==="c2pa.claim.v2"?(o.claimBytes=se(e,i),o.claimVersion=2):i.label==="c2pa.signature"&&(o.signatureBytes=se(e,i))}if(!o.claimBytes)throw new Error("manifest has no claim");if(!o.signatureBytes)throw new Error("manifest has no claim signature");return o}function Ye(e){let t=W(e);if(!t.startsWith("%PDF-"))throw new Error("not a PDF file");let n=-1;for(let m,E=/\/AFRelationship\s*\/C2PA_Manifest\b/g;m=E.exec(t);)n=m.index;if(n<0)return null;let r=null;for(let m,E=/(\d+)\s+(\d+)\s+obj\b/g;(m=E.exec(t))&&m.index<n;)r=m;let o=t.indexOf("endobj",n);if(!r||o<0)throw new Error("malformed C2PA filespec object");let a=t.slice(r.index,o),i=/\/EF\s*<<([^>]*)>>/.exec(a),A=i&&/\/(?:F|UF)\s+(\d+)\s+(\d+)\s+R/.exec(i[1]);if(!A)throw new Error("C2PA filespec has no readable /EF stream reference");let s=-1;for(let m,E=new RegExp(`(?:^|[^0-9])(${A[1]}\\s+${A[2]}\\s+obj)\\b`,"g");m=E.exec(t);)s=m.index+m[0].length-m[1].length;if(s<0)throw new Error("C2PA manifest stream object not found");let c=t.indexOf("stream",s);if(c<0)throw new Error("C2PA manifest object has no stream");let l=t.slice(s,c);if(/\/Filter\b/.test(l))throw new Error("C2PA manifest stream is compressed; cannot read");if(/\/Length\s+\d+\s+\d+\s+R/.test(l))throw new Error("C2PA manifest stream has an indirect /Length; cannot read");let g=/\/Length\s+(\d+)/.exec(l);if(!g)throw new Error("C2PA manifest stream has no /Length");let d=c+6;t[d]==="\r"&&d++,t[d]===`
`&&d++;let f=+g[1];if(d+f>e.length)throw new Error("C2PA manifest stream overruns the file");return{manifest:e.slice(d,d+f),start:d}}var T=(e,t,n)=>String.fromCharCode(...e.subarray(t,t+n));function at(e){if(e.length<12)return null;if(e[0]===137&&T(e,1,3)==="PNG")return"png";if(e[0]===255&&e[1]===216&&e[2]===255)return"jpeg";if(T(e,0,3)==="GIF")return"gif";if(T(e,0,4)==="%PDF")return"pdf";if(T(e,0,4)==="RIFF"&&T(e,8,4)==="WEBP")return"webp";if(e[0]===73&&e[1]===73&&e[2]===42||e[0]===77&&e[1]===77&&e[3]===42)return"tiff";if(T(e,4,4)==="ftyp"){let n=T(e,8,4);return["avif","avis","heic","heix","hevc","heim","heis","hevm","hevs","mif1","mif2","msf1"].includes(n)?null:"mp4"}if(e[0]===26&&e[1]===69&&e[2]===223&&e[3]===163)return W(e.subarray(0,64)).includes("matroska")?"mkv":"webm";let t=W(e.subarray(0,4096));return/<svg[\s>]/.test(t)?"svg":null}function rn(e){let t=new DataView(e.buffer,e.byteOffset),n=[];for(let r=8;r+8<=e.length;){let o=t.getUint32(r),a=T(e,r+4,4),i=r+o+12;if(i>e.length)throw new Error("malformed PNG chunk");if(a==="caBX"&&n.push(e.slice(r+8,r+8+o)),a==="IEND")break;r=i}if(n.length>1)throw new Error("PNG has more than one caBX chunk");return n.length?{manifest:n[0]}:null}function on(e){let t=new Map;for(let r=2;r+4<=e.length&&e[r]===255;){let o=e[r+1];if(o>=208&&o<=217){r+=2;continue}let a=e[r+2]<<8|e[r+3],i=r+2+a;if(i>e.length)throw new Error("malformed JPEG segment");if(o===235&&a>18){let A=e.subarray(r+4,i);if(A[0]===74&&A[1]===80){let s=A[2]<<8|A[3],c=(A[4]<<24|A[5]<<16|A[6]<<8|A[7])>>>0,l=t.get(s);l||(l=[],t.set(s,l)),l.push({z:c,body:A})}}if(o===218)break;r=i}let n=[];for(let r of t.values()){r.sort((s,c)=>s.z-c.z);let o=r[0].body;if(!(o.length>28&&T(o,24,4)==="c2pa"))continue;let a=r.map((s,c)=>c===0?s.body.subarray(8):s.body.subarray(16)),i=new Uint8Array(a.reduce((s,c)=>s+c.length,0)),A=0;for(let s of a)i.set(s,A),A+=s.length;n.push(i)}if(n.length>1)throw new Error("JPEG has more than one manifest store");return n.length?{manifest:n[0]}:null}function an(e){if(T(e,0,3)!=="GIF")throw new Error("not a GIF");let t=e[10],n=13;for(t&128&&(n+=3*(1<<(t&7)+1));n<e.length;){let r=e[n];if(r===44||r===59)break;if(r!==33)throw new Error("malformed GIF block");let o=e[n+1],a=n+2;if(a>=e.length)throw new Error("truncated GIF block");(o===255||o===1||o===249)&&(a+=1+e[a]);let i=o===255&&T(e,n+3,8)==="C2PA_GIF"&&e[n+11]===1&&e[n+12]===0&&e[n+13]===0,A=[];for(;a<e.length&&e[a]!==0;){let s=e[a];if(a+1+s>e.length)throw new Error("malformed GIF sub-blocks");i&&A.push(e.subarray(a+1,a+1+s)),a+=1+s}if(a>=e.length)throw new Error("truncated GIF sub-blocks");if(a+=1,i)return{manifest:M(A)};n=a}return null}function sn(e){let t=W(e),n=/<c2pa:manifest[^>]*>([^<]*)<\/c2pa:manifest>/.exec(t);if(!n)return null;let r=n[1].trim();if(!r)return null;if(!/^[A-Za-z0-9+/]+={0,2}$/.test(r))throw new Error("SVG manifest is not valid base64");return{manifest:we(r)}}function An(e){let t=e[0]===73,n=new DataView(e.buffer,e.byteOffset);if(n.getUint16(2,t)!==42)throw new Error("BigTIFF is not supported");let r=c=>{let l=n.getUint16(c,t);if(c+2+l*12+4>e.length)throw new Error("malformed TIFF IFD");let g=[];for(let d=0;d<l;d++){let f=c+2+d*12;g.push({tag:n.getUint16(f,t),type:n.getUint16(f+2,t),count:n.getUint32(f+4,t),valueOffset:n.getUint32(f+8,t)})}return{entries:g,next:n.getUint32(c+2+l*12,t)}},o=new Set,a=n.getUint32(4,t),i=null,A=null;for(;a&&!o.has(a);){o.add(a);let c=r(a);i||(i=c),A=c,a=c.next}if(!A)return null;let s=A.entries.find(c=>c.tag===52545)||i.entries.find(c=>c.tag===52545);if(!s)return null;if(s.type!==7)throw new Error("TIFF C2PA entry must be type UNDEFINED(7)");if(s.valueOffset+s.count>e.length)throw new Error("TIFF C2PA value overruns the file");return{manifest:e.slice(s.valueOffset,s.valueOffset+s.count)}}function cn(e){let t=new DataView(e.buffer,e.byteOffset);for(let n=12;n+8<=e.length;){let r=t.getUint32(n+4,!0);if(n+8+r>e.length)throw new Error("malformed WebP chunk");if(T(e,n,4)==="C2PA")return{manifest:e.slice(n+8,n+8+r)};n+=8+r+(r&1)}return null}var Te=(e,t)=>(e[t]<<24|e[t+1]<<16|e[t+2]<<8|e[t+3])>>>0;function Re(e){let t=[],n=0;for(;n<e.length;){if(n+8>e.length)throw new Error("truncated MP4 box header");let r=Te(e,n),o=8;if(r===1){if(n+16>e.length)throw new Error("truncated MP4 box header");if(r=Te(e,n+8)*2**32+Te(e,n+12),o=16,!Number.isSafeInteger(r))throw new Error("malformed MP4 box size")}else r===0&&(r=e.length-n);if(r<o||n+r>e.length)throw new Error("malformed MP4 box");t.push({off:n,size:r,hdr:o,type:T(e,n+4,4)}),n+=r}return t}var ln=(e,t)=>t.type==="uuid"&&t.size>=t.hdr+16&&Be.every((n,r)=>e[t.off+t.hdr+r]===n);function gn(e){let t=Re(e),n=[];for(let r of t.filter(o=>ln(e,o))){let o=r.off+r.size,a=r.off+r.hdr+16+4;if(a>o)throw new Error("malformed C2PA box");let i=a;for(;i<o&&e[i]!==0;)i++;if(i>=o)throw new Error("malformed C2PA box purpose");if(T(e,a,i-a)==="manifest"){if(i+=9,i>o)throw new Error("malformed C2PA box");n.push(e.slice(i,o))}}if(n.length>1)throw new Error("MP4 has more than one C2PA manifest box");return n.length?{manifest:n[0]}:null}var Bn=423732329,En=24999,dn=18016,fn=18012;function Ne(e,t,n){let r=[],o=t;for(;o<n;){let a=Me(e,o),i=a&&F(e,o+a.width);if(!a||!i)throw new Error("malformed Matroska element");if(i.unknown)break;let A=o+a.width+i.width,s=A+i.value;if(s>n||s<=o)throw new Error("malformed Matroska element");r.push({id:a.value,off:o,dataOff:A,dataEnd:s}),o=s}return r}function rt(e){if(!$(e,0,X))throw new Error("not an EBML file");let t=F(e,X.length);if(!t||t.unknown)throw new Error("malformed EBML header");let n=X.length+t.width+t.value;if(!$(e,n,L))throw new Error("no Matroska Segment");let r=F(e,n+L.length);if(!r)throw new Error("malformed Matroska Segment");let o=n+L.length+r.width,a=r.unknown?e.length:o+r.value;if(a>e.length)throw new Error("truncated Matroska Segment");let i=[];for(let A of Ne(e,o,a))if(A.id===Bn)for(let s of Ne(e,A.dataOff,A.dataEnd)){if(s.id!==En)continue;let c=null,l=null;for(let g of Ne(e,s.dataOff,s.dataEnd))g.id===dn&&(c=T(e,g.dataOff,g.dataEnd-g.dataOff)),g.id===fn&&(l=e.slice(g.dataOff,g.dataEnd));if(c===Ee){if(!l||!l.length)throw new Error("Matroska C2PA attachment has no data");i.push(l)}}if(i.length>1)throw new Error("Matroska file has more than one C2PA attachment");return i.length?{manifest:i[0]}:null}var it={pdf:Ye,png:rn,jpeg:on,gif:an,svg:sn,tiff:An,webp:cn,mp4:gn,webm:rt,mkv:rt},wn={trainedAlgorithmicMedia:"generated",compositeWithTrainedAlgorithmicMedia:"composite"},st=e=>wn[(typeof e=="string"?e:"").split("/").pop()??""];function At(e){let t=[],n;try{let o=Se(e,0,e.length);if(!o.length)return t;n=O(e,o[0])}catch{return t}if(n.label!=="c2pa")return t;for(let o of n.children){let a;try{a=O(e,o)}catch{continue}let i;for(let A of a.children){let s;try{s=O(e,A)}catch{continue}if(!(s.label!=="c2pa.claim"&&s.label!=="c2pa.claim.v2")){try{let c=H(se(e,s));if(c instanceof Map){let l=c.get("claim_generator_info");i=l instanceof Map?l.get("name"):Array.isArray(l)&&l[0]instanceof Map?l[0].get("name"):c.get("claim_generator")}}catch{}break}}for(let A of a.children){let s;try{s=O(e,A)}catch{continue}if(s.label==="c2pa.assertions")for(let c of s.children){let l;try{l=O(e,c)}catch{continue}if(!(l.label!=="c2pa.actions"&&l.label!=="c2pa.actions.v2"))try{let g=H(se(e,l)).get("actions");if(!Array.isArray(g))continue;for(let d of g){let f=d.get?.("softwareAgent");t.push({action:d.get?.("action"),when:d.get?.("when"),softwareAgent:f instanceof Map?f.get("name"):f,digitalSourceType:d.get?.("digitalSourceType"),description:d.get?.("description"),generator:i})}}catch{}}}}let r=new Set;return t.filter(o=>{let a=JSON.stringify([o.action,o.when,o.softwareAgent,o.digitalSourceType,o.description]);return r.has(a)?!1:(r.add(a),!0)})}var de=new TextDecoder,pr=new TextEncoder,S=globalThis.crypto.subtle;function dt(e,t){let n=e.slice(t.contentStart,t.end),r=[Math.floor(n[0]/40),n[0]%40],o=0;for(let a=1;a<n.length;a++)o=o*128+(n[a]&127),n[a]&128||(r.push(o),o=0);return r.join(".")}function ct(e,t){let n=de.decode(e.slice(t.contentStart,t.end)),r=t.tag===24,o=r?+n.slice(0,4):+n.slice(0,2)<50?2e3+ +n.slice(0,2):1900+ +n.slice(0,2),a=r?2:0;return new Date(Date.UTC(o,+n.slice(2+a,4+a)-1,+n.slice(4+a,6+a),+n.slice(6+a,8+a),+n.slice(8+a,10+a),+n.slice(10+a,12+a)))}function lt(e,t){let n={};for(let r of U(e,t))for(let o of U(e,r)){let[a,i]=U(e,o);if(!a||!i||a.tag!==6)continue;let A=dt(e,a),s=de.decode(e.slice(i.contentStart,i.end));A==="2.5.4.3"&&n.commonName==null&&(n.commonName=s),A==="2.5.4.10"&&n.organization==null&&(n.organization=s)}return n}function mn(e,t,n){let r={sanEmails:[],isCa:!1};try{let o=t.slice(n+6).find(i=>i.tag===163);if(!o)return r;let[a]=U(e,o);if(!a||a.tag!==48)return r;for(let i of U(e,a)){if(i.tag!==48)continue;let A=U(e,i),s=A[A.length-1];if(!A[0]||A[0].tag!==6||!s||s.tag!==4)continue;let c=dt(e,A[0]);if(c==="2.5.29.17"){let l=Z(e,s.contentStart);if(l.tag!==48||l.end>s.end)continue;for(let g of U(e,l))g.tag===129&&r.sanEmails.push(de.decode(e.slice(g.contentStart,g.end)))}else if(c==="2.5.29.19"){let l=Z(e,s.contentStart);if(l.tag!==48||l.end>s.end)continue;let[g]=U(e,l);r.isCa=!!g&&g.tag===1&&g.end>g.contentStart&&e[g.contentStart]!==0}}}catch{}return r}var In={"2a8648ce3d040302":{scheme:"ecdsa",hash:"SHA-256"},"2a8648ce3d040303":{scheme:"ecdsa",hash:"SHA-384"},"2a8648ce3d040304":{scheme:"ecdsa",hash:"SHA-512"},"2a864886f70d01010b":{scheme:"rsa",hash:"SHA-256"},"2a864886f70d01010c":{scheme:"rsa",hash:"SHA-384"},"2a864886f70d01010d":{scheme:"rsa",hash:"SHA-512"}},hn="2a864886f70d01010a",pn="2b6570",Dn={"608648016503040201":"SHA-256","608648016503040202":"SHA-384","608648016503040203":"SHA-512","2b0e03021a":"SHA-1"};function Qn(e,t){try{let n=U(e,t),r=n[0];if(!r||r.tag!==6)return null;let o=b(e.slice(r.contentStart,r.end)),a=In[o];if(a)return{...a};if(o===pn)return{scheme:"ed25519"};if(o===hn){let i="SHA-1",A=20,s=n[1];if(s&&s.tag===48){for(let c of U(e,s))if(c.tag===160){let l=U(e,c)[0];l&&l.tag===6&&(i=Dn[b(e.slice(l.contentStart,l.end))]||i)}else if(c.tag===162){let l=U(e,c)[0];if(l&&l.tag===2){let g=0;for(let d of e.slice(l.contentStart,l.end))g=g*256+d;A=g}}}return{scheme:"rsa-pss",hash:i,saltLength:A}}return null}catch{return null}}function Ve(e){let t=Z(e,0),n=U(e,t),r=n[0],o=n[1],a=n[2],i=U(e,r),A=i[0].tag===160?1:0,s=i[A+2],c=U(e,i[A+3]),l=i[A+4],g=i[A+5],d=e.slice(s.start,s.end),f=e.slice(l.start,l.end),m=mn(e,i,A);return{subject:lt(e,l),issuer:lt(e,s),notBefore:ct(e,c[0]),notAfter:ct(e,c[1]),selfSigned:b(d)===b(f),spki:e.slice(g.start,g.end),tbsBytes:e.slice(r.start,r.end),signatureRaw:a&&a.tag===3&&a.end>a.contentStart+1?e.slice(a.contentStart+1,a.end):null,sigAlg:o?Qn(e,o):null,issuerBytes:d,subjectBytes:f,sanEmails:m.sanEmails,isCa:m.isCa}}function yn(e){try{let t=U(e,Z(e,0))[0],n=U(e,t)[1];return!n||n.tag!==6?null:ze[b(e.slice(n.contentStart,n.end))]??null}catch{return null}}async function gt(e,t){if(!e.signatureRaw||!e.sigAlg||b(e.issuerBytes)!==b(t.subjectBytes))return!1;let n=e.sigAlg;try{if(n.scheme==="ecdsa"){let o=yn(t.spki);if(!o)return!1;let a=await S.importKey("spki",D(t.spki),{name:"ECDSA",namedCurve:o.curve},!1,["verify"]);return await S.verify({name:"ECDSA",hash:n.hash},a,D(He(e.signatureRaw,o.size)),D(e.tbsBytes))}if(n.scheme==="rsa"){let o=await S.importKey("spki",D(Fe(t.spki)),{name:"RSASSA-PKCS1-v1_5",hash:n.hash},!1,["verify"]);return await S.verify({name:"RSASSA-PKCS1-v1_5"},o,D(e.signatureRaw),D(e.tbsBytes))}if(n.scheme==="rsa-pss"){let o=await S.importKey("spki",D(Fe(t.spki)),{name:"RSA-PSS",hash:n.hash},!1,["verify"]);return await S.verify({name:"RSA-PSS",saltLength:n.saltLength},o,D(e.signatureRaw),D(e.tbsBytes))}let r=await S.importKey("spki",D(t.spki),{name:"Ed25519"},!1,["verify"]);return await S.verify({name:"Ed25519"},r,D(e.signatureRaw),D(e.tbsBytes))}catch{return!1}}var Un=8;async function bn(e,t,n){let r=[];for(let A of n)try{r.push(Ve(A))}catch{}let o=[];for(let A of t.slice(1,1+Un))if(A instanceof Uint8Array)try{let s=Ve(A);s.isCa&&o.push(s)}catch{}let a=e,i=new Set;for(let A=0;A<=o.length;A++){for(let c of r)try{if(await gt(a,c))return c}catch{}let s=null;for(let c of o)if(!(i.has(c)||b(c.subjectBytes)!==b(a.issuerBytes)))try{if(await gt(a,c)){s=c;break}}catch{}if(!s)break;i.add(s),a=s}return null}var xn={"-7":{kind:"ecdsa",curve:"P-256",hash:"SHA-256",name:"ES256"},"-35":{kind:"ecdsa",curve:"P-384",hash:"SHA-384",name:"ES384"},"-36":{kind:"ecdsa",curve:"P-521",hash:"SHA-512",name:"ES512"},"-37":{kind:"rsa-pss",hash:"SHA-256",saltLength:32,name:"PS256"},"-38":{kind:"rsa-pss",hash:"SHA-384",saltLength:48,name:"PS384"},"-39":{kind:"rsa-pss",hash:"SHA-512",saltLength:64,name:"PS512"},"-8":{kind:"ed25519",name:"Ed25519"}},Bt=Uint8Array.of(6,9,42,134,72,134,247,13,1,1,10),Tn=Uint8Array.of(48,13,6,9,42,134,72,134,247,13,1,1,1,5,0);function Nn(e,t){let n;return t.length<128?n=Uint8Array.of(e,t.length):t.length<256?n=Uint8Array.of(e,129,t.length):n=Uint8Array.of(e,130,t.length>>>8,t.length&255),M([n,t])}function Fe(e){let t=Z(e,0),[n,r]=U(e,t),o=Z(e,n.contentStart),a=e.slice(o.start,o.end);return a.length!==Bt.length||!a.every((i,A)=>i===Bt[A])?e:Nn(48,M([Tn,e.slice(r.start,r.end)]))}async function Gn(e,t,n,r){if(e.kind==="ecdsa"){let a=await S.importKey("spki",D(t),{name:"ECDSA",namedCurve:e.curve},!1,["verify"]);return S.verify({name:"ECDSA",hash:e.hash},a,D(n),D(r))}if(e.kind==="rsa-pss"){let a=await S.importKey("spki",D(Fe(t)),{name:"RSA-PSS",hash:e.hash},!1,["verify"]);return S.verify({name:"RSA-PSS",saltLength:e.saltLength},a,D(n),D(r))}let o=await S.importKey("spki",D(t),{name:"Ed25519"},!1,["verify"]);return S.verify({name:"Ed25519"},o,D(n),D(r))}var Et="self#jumbf=c2pa.assertions/";async function je(e,{trustAnchors:t}={}){if(!(e instanceof Uint8Array))throw new Error("verifyC2pa: bytes must be a Uint8Array");let n=[],r=(B,u)=>{n.push({code:B,ok:!1,explanation:u})},o=(B,u)=>{n.push({code:B,ok:!0,explanation:u})},a=at(e),i={found:!1,state:"none",trusted:!1,madeWithLolly:!1,likelyMadeWithLolly:!1,partsMadeWithLolly:!1,delivered:!1,format:a,checks:n},A=e;if(!a)return i.reason="no Content Credentials \u2014 these are embedded only in pdf, png, jpg, gif, svg, tiff, webp, mp4 and webm files",i;let s;try{s=it[a](e)}catch(B){let u=B.message;return i.reason=u,/not a PDF/.test(u)||(i.found=!0,i.state="invalid",r(I.credentialUnreadable,u)),i}if(!s)return i.reason="no Content Credentials found",i;i.found=!0;let c,l;try{c=ot(s.manifest);let B=H(c.claimBytes);if(!(B instanceof Map))throw new Error("claim is not a CBOR map");l=B}catch(B){return i.state="invalid",i.reason=`credential is malformed: ${B.message}`,r(I.credentialUnreadable,B.message),i}let g=c.assertions.find(B=>B.label==="c2pa.actions"||B.label==="c2pa.actions.v2"),d=[];try{let B=g&&H(g.content).get("actions");Array.isArray(B)&&(d=B.map(u=>{let Q=u.get?.("softwareAgent");return{action:u.get?.("action"),when:u.get?.("when"),softwareAgent:Q instanceof Map?Q.get("name"):Q,digitalSourceType:u.get?.("digitalSourceType"),description:u.get?.("description")}}))}catch{}let f=B=>{if(!(B instanceof Map))return null;let u={};for(let[Q,y]of B)typeof Q=="string"&&(typeof y=="string"||typeof y=="number"||typeof y=="boolean")&&(u[Q]=y);return u},m=l.get("claim_generator_info");i.claim={title:l.get("dc:title"),format:l.get("dc:format"),claimGenerator:l.get("claim_generator"),generatorInfo:f(Array.isArray(m)?m[0]:m),instanceId:l.get("instanceID"),manifestLabel:c.manifestLabel,actions:d};let E=At(s.manifest);E.length&&(i.history=E);for(let B of E){let u=st(B.digitalSourceType);if(u&&(!i.aiGenerated||u==="generated")&&(i.aiGenerated={kind:u,sourceType:B.digitalSourceType},u==="generated"))break}let x=c.assertions.find(B=>B.label===tt);if(x)try{let B=H(x.content),u=f(B);if(u){let Q=B instanceof Map?B.get("inputs"):void 0;if(Q instanceof Map){let y={};for(let[h,C]of Q)typeof h=="string"&&typeof C=="string"&&(y[h]=C);Object.keys(y).length&&(u.inputs=y)}i.environment=u}}catch{}let Y=c.assertions.find(B=>B.label==="cawg.metadata"||B.label==="c2pa.metadata");if(Y)try{let B=JSON.parse(de.decode(Y.content))?.["dc:creator"],u=Array.isArray(B)?B[0]:B;u&&(i.author={name:String(u)})}catch{}let w=c.assertions.find(B=>B.label==="stds.schema-org.CreativeWork");if(!i.author&&w)try{let B=JSON.parse(de.decode(w.content))?.author?.[0];B?.name&&(i.author={name:String(B.name),...B.email?{email:String(B.email)}:{}})}catch{}let p=c.claimVersion===2?[...Array.isArray(l.get("created_assertions"))?l.get("created_assertions"):[],...Array.isArray(l.get("gathered_assertions"))?l.get("gathered_assertions"):[]]:l.get("assertions");for(let B of Array.isArray(p)?p:[]){let u=B instanceof Map?B.get("url"):null,Q=B instanceof Map?B.get("hash"):null;if(typeof u!="string"||!(Q instanceof Uint8Array)){r(I.assertionHashedUriMismatch,"malformed assertion reference in the claim");continue}let y=u.startsWith(Et)?u.slice(Et.length):null,h=y&&c.assertions.find(C=>C.label===y);if(!h){r(I.assertionMissing,`claim references ${u} but the store has no such assertion`);continue}b(await re(h.payload))===b(Q)?o(I.assertionHashedUriMatch,`hashed uri matched: ${u}`):r(I.assertionHashedUriMismatch,`hash does not match assertion data: ${u}`)}let J=null,R=null,N=null,Ae=!1,ce=null;try{let B=H(c.signatureBytes);if(B?.tag!==18)throw new Error("claim signature is not COSE_Sign1_Tagged");let[u,Q,,y]=B.value,h=H(u),C=xn[String(h.get(1))],j=Q,v=h.get(33)??h.get("x5chain")??j?.get(33)??j?.get("x5chain"),P=Array.isArray(v)?v:[v],ne=P[0];if(!(ne instanceof Uint8Array))throw new Error("no x5chain certificate in signature headers");let V=Ve(ne);if(J=C?.name||`COSE alg ${String(h.get(1))}`,i.signer={commonName:V.subject.commonName,organization:V.subject.organization,notBefore:V.notBefore.toISOString(),notAfter:V.notAfter.toISOString(),selfSigned:V.selfSigned,alg:J},!C)r(I.claimSignatureMismatch,`unsupported signing algorithm (${J}) \u2014 cannot verify on-device`);else{let ut=et(["Signature1",u,new Uint8Array(0),c.claimBytes]);try{R=await Gn(C,V.spki,y,ut)}catch{r(I.claimSignatureMismatch,`${C.name} signatures cannot be verified on this device`),R=null}R===!0?o(I.claimSignatureValidated,"claim signature valid"):R===!1&&r(I.claimSignatureMismatch,"claim signature is not valid")}let fe=Date.now();Ae=fe>=V.notBefore.getTime()&&fe<=V.notAfter.getTime(),Ae?o(I.claimSignatureInsideValidity,"signing certificate within its validity window"):r(I.signingCredentialExpired,"signing certificate expired (or not yet valid)"),ce=V.sanEmails[0]??null,Array.isArray(t)&&t.length&&(N=await bn(V,P,t))}catch(B){r(I.claimSignatureMismatch,`claim signature could not be verified: ${B.message}`)}let K=c.assertions.find(B=>B.label==="c2pa.hash.data"),_=c.assertions.find(B=>/^c2pa\.hash\.bmff(\.v\d+)?$/.test(B.label));if(!K&&_)try{let B=H(_.content);if((B.get("alg")||"sha256")!=="sha256")throw new Error(`unsupported hash alg ${String(B.get("alg"))}`);if(B.get("merkle"))throw new Error("fragmented (Merkle) BMFF bindings are not supported on this device");let u=_.label==="c2pa.hash.bmff"?1:Number(_.label.slice(16));if(u>3)throw new Error(`BMFF hash version v${u} is newer than this device's verifier`);let Q=(B.get("exclusions")||[]).map(C=>({xpath:C.get("xpath"),data:C.get("data"),length:C.get("length"),subset:C.get("subset"),version:C.get("version"),flags:C.get("flags")}));for(let C of Q)if(typeof C.xpath!="string"||!/^\/[a-zA-Z0-9 ]{4}$/.test(C.xpath)||C.subset!=null||C.version!=null||C.flags!=null)throw new Error("this BMFF exclusion form is not supported on this device");let y=C=>Q.some(j=>j.xpath===`/${C.type}`&&(j.length==null||j.length===C.size)&&(j.data||[]).every(v=>{let P=C.off+v.get("offset"),ne=v.get("value");return ne instanceof Uint8Array&&P+ne.length<=C.off+C.size&&ne.every((V,fe)=>e[P+fe]===V)})),h=[];for(let C of Re(e))if(!y(C)){if(u>=2){let j=new Uint8Array(8);for(let v=7,P=C.off;v>=0;v--)j[v]=P%256,P=Math.floor(P/256);h.push(j)}h.push(e.subarray(C.off,C.off+C.size))}b(await re(M(h)))===b(B.get("hash"))?o(I.assertionBmffHashMatch,"BMFF hash valid"):r(I.assertionBmffHashMismatch,"the file bytes do not match the credential \u2014 the file changed after signing")}catch(B){r(I.assertionBmffHashMismatch,`hard binding could not be checked: ${B.message}`)}else if(!K)r(I.assertionDataHashMismatch,"no hard binding (c2pa.hash.data or c2pa.hash.bmff) in the manifest");else try{let B=H(K.content);if((B.get("alg")||"sha256")!=="sha256")throw new Error(`unsupported hash alg ${String(B.get("alg"))}`);let u=(B.get("exclusions")||[]).map(h=>({start:h.get("start"),length:h.get("length")})).sort((h,C)=>h.start-C.start),Q=[],y=0;for(let h of u){if(!(Number.isInteger(h.start)&&Number.isInteger(h.length))||h.start<y||h.start+h.length>A.length)throw new Error("exclusion ranges are out of order or out of range");Q.push(A.subarray(y,h.start)),y=h.start+h.length}Q.push(A.subarray(y)),b(await re(M(Q)))===b(B.get("hash"))?o(I.assertionDataHashMatch,"data hash valid"):r(I.assertionDataHashMismatch,"the file bytes do not match the credential \u2014 the file changed after signing")}catch(B){r(I.assertionDataHashMismatch,`hard binding could not be checked: ${B.message}`)}if(N&&R===!0&&(n.some(u=>!u.ok&&u.code!==I.signingCredentialExpired)||(i.signer.identity={email:ce,issuer:N.subject.commonName||N.subject.organization},i.trusted=Ae)),i.signer?.identity){let B=i.signer.identity.email||i.signer.commonName;o(I.signingCredentialTrusted,i.trusted?`signing certificate chains to a pinned CA root \u2014 verified identity: ${B}`:`signing certificate chains to a pinned CA root \u2014 verified identity: ${B} (certificate has since expired; signing time cannot be proven \u2014 no timestamp authority yet)`)}else r(I.signingCredentialUntrusted,"signing certificate untrusted \u2014 an ephemeral on-device key, not a CA-issued identity");i.state=n.every(B=>B.ok||B.code===I.signingCredentialUntrusted)?"valid":"invalid";let G=i.claim.actions||[],ve=G.some(B=>B.action==="c2pa.created"),ft=[i.claim.claimGenerator,i.claim.generatorInfo?.name].filter(Boolean).join(" "),ke=ve&&/\blolly\b/i.test(ft);i.madeWithLolly=i.state==="valid"&&ke;let wt=n.every(B=>B.ok||B.code===I.signingCredentialUntrusted||B.code===I.assertionDataHashMismatch||B.code===I.assertionBmffHashMismatch);return i.likelyMadeWithLolly=!i.madeWithLolly&&wt&&ke,i.partsMadeWithLolly=i.state==="valid"&&!i.madeWithLolly&&!i.likelyMadeWithLolly&&(i.history??[]).some(B=>/\blolly\b/i.test(`${typeof B.softwareAgent=="string"?B.softwareAgent:""} ${typeof B.generator=="string"?B.generator:""}`)),i.delivered=i.state==="valid"&&!ve&&G.some(B=>B.action==="c2pa.published"),i}globalThis.__lollyVerify={verifyC2pa:je,resolveVerdict:xe,c2paTrustAnchors:be,pemToDer:le};})();
