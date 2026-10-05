// SPDX-License-Identifier: MPL-2.0
/** Served as a same-origin script; browser credentials never leave this RP. */
export const PASSKEY_CLIENT = String.raw`
(() => {
  const status = document.querySelector('[data-passkey-status]');
  const supported = window.isSecureContext && window.PublicKeyCredential && navigator.credentials;
  document.querySelectorAll('[data-passkey-action]').forEach(button => { button.hidden = !supported; });
  if (!supported) { status.textContent = 'Passkeys are unavailable in this browser. Use another sign-in method.'; return; }
  const decode = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-value.length%4)%4)), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const parse = (options, create) => {
    if (create && PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(options);
    if (!create && PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(options);
    const o = { ...options, challenge:decode(options.challenge) };
    if (create) o.user = { ...options.user,id:decode(options.user.id) };
    for (const k of ['excludeCredentials','allowCredentials']) if (options[k]) o[k] = options[k].map(c => ({...c,id:decode(c.id)}));
    return o;
  };
  const serialise = credential => {
    if (credential.toJSON) return credential.toJSON();
    const r = credential.response;
    const response = { clientDataJSON:encode(r.clientDataJSON) };
    if (r.attestationObject) { response.attestationObject=encode(r.attestationObject);response.transports=r.getTransports ? r.getTransports() : []; }
    else { response.authenticatorData=encode(r.authenticatorData);response.signature=encode(r.signature);response.userHandle=r.userHandle ? encode(r.userHandle) : null; }
    return {id:credential.id,rawId:encode(credential.rawId),type:credential.type,response,clientExtensionResults:credential.getClientExtensionResults(),authenticatorAttachment:credential.authenticatorAttachment};
  };
  const post = async (path, data={}) => {
    const r = await fetch('/api/auth/passkeys/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),credentials:'same-origin'});
    const b = await r.json(); if (!r.ok) throw new Error(b.error?.message || 'The request could not finish. Try again.'); return b;
  };
  let working = false;
  document.addEventListener('click',async event => {
    const button = event.target.closest('[data-passkey-action]'); if (!button || working) return;
    working=true;button.disabled=true;status.textContent='Waiting for your passkey…';
    try {
      const action=button.dataset.passkeyAction;
      if (action==='remove') {
        if (!confirm('Remove this passkey? You can still use your other sign-in methods.')) {status.textContent='Passkey kept.';return;}
        await post(encodeURIComponent(button.dataset.passkeyId)+'/remove');location.reload();return;
      }
      const create=action==='register',returnTo=document.querySelector('[data-passkey-return]')?.dataset.passkeyReturn || '/';
      const {options}=await post(action+'/options',{returnTo});
      const credential = create ? await navigator.credentials.create({publicKey:parse(options,true)}) : await navigator.credentials.get({publicKey:parse(options,false)});
      if (!credential) throw new Error('No passkey was selected. Try again or use another sign-in method.');
      const result=await post(action+'/verify',{response:serialise(credential),...(create?{label:document.querySelector('#passkey-label').value}:{})});
      location.assign(create?'/api/auth/security':result.returnTo);
    } catch(error) { status.textContent=error.name==='NotAllowedError' || error.name==='AbortError' ? 'Passkey cancelled. Try again or use another sign-in method.' : error.message; }
    finally { working=false;button.disabled=false; }
  });
})();`;
