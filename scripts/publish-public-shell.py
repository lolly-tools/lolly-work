#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Promote a genuinely retired public overlay once; observe separately read-only.

check never contacts a target. dryrun/apply consume the maintained offline public
contract, exact storage and retired-Pod custody. Every mutation ends its guards
with the caller's hash-pinned target preflight. Failed or uncertain phases retain
original API bytes and may only be reconciled read-only, never replayed.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('public_promotion_stage', Path(__file__).with_name('stage-public-shell.py'))
stage = importlib.util.module_from_spec(spec); spec.loader.exec_module(stage)
public, cohort, updater, private = stage.public, stage.cohort, stage.updater, stage.private
require, exact, Refusal = stage.require, stage.exact, stage.Refusal
INPUT_KEYS = {'version','status','stageInput','stage','preflight','staticProbes','outputDirectory','sourceFiles'}


def manifest_files(manifest):
    exact(manifest, {'version','files','totalBytes'})
    require(type(manifest['version']) is int and manifest['version'] == 1 and isinstance(manifest['files'], list), 'Complete public static manifest required')
    rows = {}
    for row in manifest['files']:
        exact(row, {'path','size','sha256'}); path = cohort.safe_path(row['path']); cohort.sha(row['sha256'])
        require(path not in rows and type(row['size']) is int and row['size'] >= 0 and not path.startswith('models/'), 'Duplicate or model static path')
        rows[path] = row
    require(list(rows) == sorted(rows) and type(manifest['totalBytes']) is int and sum(r['size'] for r in rows.values()) == manifest['totalBytes'], 'Manifest ordering/total differs')
    return rows


def review_retirement(proof, guard):
    require(proof.get('version') == 1 and proof.get('status') == 'ISOLATED_PUBLIC_SHELL_ACCEPTED_AND_RETIRED'
            and proof.get('preparedSha256') == guard.value['prepared']['sha256'] and proof.get('image') == guard.prepared['image']
            and proof.get('sources') == guard.prepared['sources'] and proof.get('stageInput') == {'path':str(guard.input_path),'sha256':guard.input_sha}
            and proof.get('overlayManifestSha256') == guard.new.manifest_sha and proof.get('staticManifestSha256') == guard.producer['shell']['manifest']['sha256'], 'Original public stage custody differs')
    runtime = proof.get('runtime', {})
    require(runtime.get('status') == 'PHASE_ACCEPTED' and runtime.get('runtimeStatus') == 'ISOLATED_PUBLIC_SHELL_RUNTIME_VERIFIED'
            and runtime.get('inputSha256') == guard.input_sha and runtime.get('operatorSha256') == guard.operator_sha
            and runtime.get('pod') == proof.get('qualifier') and runtime.get('image') == guard.prepared['image'] and runtime.get('sources') == guard.prepared['sources']
            and runtime.get('overlayManifestSha256') == guard.new.manifest_sha and runtime.get('staticManifestSha256') == guard.producer['shell']['manifest']['sha256']
            and all(runtime.get(k) is True for k in ('fullStaticHashesVerified','publicCatalogSignatureVerified','nginxLoopbackIndexVerified')) and runtime.get('modelsMounted') is False,
            'Complete genuine same-image qualifier proof required')
    roots = runtime.get('rootMetadata'); exact(roots, {'before','after'})
    claim, pv = proof['claim'], proof['pv']
    before_root, after_root = [stage.root_proof(roots[k],guard,claim,pv) for k in ('before','after')]
    stage.same_root(before_root,after_root)
    for role in ('writer','qualifier'):
        stage.validate_public_pod(proof[role],guard.desired[role],True)
        require(proof[role]['metadata']['name'] == guard.value['names'][role] and proof.get(role+'Absent') is True, 'Retired Pod identity differs')
        mount = proof[role+'MountProof']
        require(mount.get('podUid') == proof[role]['metadata']['uid'] and mount.get('nodeUID') == guard.target['node']['uid']
                and mount.get('unmounted') is True and mount.get('mountsReleased') is True, 'Both actual retired Pod mount releases required')
    require(proof['writer']['metadata']['uid'] != proof['qualifier']['metadata']['uid'] and proof.get('policyAbsent') is True and proof.get('mountsReleased') is True, 'Distinct retired writer/qualifier and deny policy required')
    private.validate_create(proof['policy'],guard.desired['policy']); private.validate_claim(proof['claim'],guard.desired['shellClaim'])
    selected = stage.resources.bound_claim(proof['claim'], {proof['pv']['metadata']['name']:proof['pv']}, guard.namespace)
    require(selected == proof['pv'], 'Actual retired stage claim/backing tuple differs')
    actual = guard.inputs.file(runtime['static']); require(actual.get('htmlRoot') == public.ROOT[1:] and isinstance(actual.get('files'),dict), 'Original qualifier static inventory required')
    files = {p:{'path':p,'size':r['size'],'sha256':r['sha256']} for p,r in actual['files'].items()}
    require(files == guard.effective.files, 'Actual full qualifier inventory differs')
    checksum = guard.inputs.file(runtime['hashes'],False).read_bytes()
    require(checksum == ''.join(r['sha256']+'  '+public.ROOT+'/'+p+'\n' for p,r in sorted(files.items())).encode(), 'Qualifier checksum-list differs from original full inventory')
    catalog = guard.inputs.file(runtime['catalog']); require(catalog.get('catalog') == guard.prepared['catalog'] and catalog.get('verified') is True
            and catalog.get('actualIndexSha256') == guard.prepared['catalog']['indexSha256'] and catalog.get('actualEnvelopeSha256') == guard.prepared['catalog']['envelopeSha256']
            and catalog.get('signedMapBoundToActualFullInventory') is True, 'Original actual qualifier catalog bytes not bound')
    commands = runtime.get('originalCommands'); require(isinstance(commands,list) and commands, 'Original qualifier command custody required')
    for ref in commands:
        command = guard.inputs.file(ref)
        require(type(command.get('timedOut')) is bool and (type(command.get('exitCode')) is int or command.get('exitCode') is None)
                and set(command.get('originals',{})) == {'stdout','stderr'}, 'Qualifier command outcome unknown')
        if command.get('exitCode') != 0 or command['timedOut']:
            prefix = [sys.executable,'-B',str(guard.host_probe),'mounts','--target',str(cohort.local_path(guard.value['target']['path'],guard.input_path.parent)),'--pod-uid']
            argv = command.get('argv',[])
            require(command.get('readOnlyMountProbe') is True and len(argv) == 8 and argv[:7] == prefix
                    and argv[7] in {proof['writer']['metadata']['uid'],proof['qualifier']['metadata']['uid']}, 'Only retained read-only mount-release observations may fail before genuine final qualification')
        for original in command['originals'].values():
            require(original.get('complete') is True and type(original.get('observedBytes')) is int, 'Truncated qualifier command')
            guard.inputs.file({'path':original['path'],'sha256':original['sha256']},False)
    return proof


def patch_for(prepared, current):
    require(cohort.digest(current['spec']) == prepared['beforeSpecSha256'] and not current['metadata'].get('deletionTimestamp'), 'Fresh public spec changed')
    patch = copy.deepcopy(prepared['guardedPatchTemplate'])
    require(patch == [{'op':'test','path':'/metadata/uid','value':current['metadata']['uid']},
                      {'op':'test','path':'/metadata/resourceVersion','value':patch[1]['value']},
                      {'op':'test','path':'/spec','value':current['spec']},{'op':'replace','path':'/spec','value':prepared['desiredSpec']}], 'Exact atomic UID/RV/full-spec patch required')
    patch[1]['value'] = current['metadata']['resourceVersion']; return patch


def expected_owner_spec(guard):
    """Preserve accepted API defaults; apply only the independently planned overlay.

    A Deployment template is not the full admitted Pod spec. Derive from the
    hash-bound original owner rather than adding guessed defaults to the new
    observation, which would otherwise refuse enableServiceLinks:true after
    the patch has already succeeded.
    """
    before = guard.accepted_deployment['spec']['template']['spec']
    after = guard.prepared['desiredSpec']['template']['spec']
    accepted = guard.owner['spec']; expected = copy.deepcopy(accepted)
    selected = guard.prepared['selection']; volume = selected['shellVolume']
    require(len(accepted.get('containers',[])) == 1 and accepted['containers'][0]['name'] == selected['container']
            and accepted.get('nodeName') == guard.target['node']['name'], 'Exact accepted public owner required for default-preserving derivation')
    before_security, after_security = before.get('securityContext',{}), after.get('securityContext',{})
    require({k:v for k,v in before_security.items() if k != 'fsGroupChangePolicy'} == {k:v for k,v in after_security.items() if k != 'fsGroupChangePolicy'}
            and after_security.get('fsGroupChangePolicy') == 'OnRootMismatch'
            and {k:v for k,v in before.items() if k not in {'containers','volumes','securityContext'}} == {k:v for k,v in after.items() if k not in {'containers','volumes','securityContext'}}
            and {k:v for k,v in before['containers'][0].items() if k != 'volumeMounts'} == {k:v for k,v in after['containers'][0].items() if k != 'volumeMounts'}, 'Owner derivation cannot change an unselected Pod field')
    accepted_security = accepted.get('securityContext',{})
    require(all(accepted_security.get(k) == v for k,v in before_security.items()), 'Accepted owner security defaults differ')
    expected['securityContext']['fsGroupChangePolicy'] = 'OnRootMismatch'
    require([v['name'] for v in accepted['volumes']] == [v['name'] for v in before['volumes']]
            and len(accepted['containers'][0]['volumeMounts']) == len(before['containers'][0]['volumeMounts']), 'Accepted owner mount/volume inventory differs')
    if guard.previous['overlay'] is None:
        mounts = public.overlay_mounts(volume)
        added = {'name':volume,'persistentVolumeClaim':{'claimName':selected['shellClaim']}}
        require(after['containers'][0]['volumeMounts'] == [*before['containers'][0]['volumeMounts'],*mounts]
                and after['volumes'] == [*before['volumes'],added], 'Only the exact anchored five-path bootstrap may change the full owner spec')
        expected['containers'][0]['volumeMounts'].extend(copy.deepcopy(mounts)); expected['volumes'].append(copy.deepcopy(added))
    else:
        indexes = [i for i,v in enumerate(before['volumes']) if v['name'] == volume]
        require(before_security.get('fsGroupChangePolicy') == 'OnRootMismatch' and len(indexes) == 1 and accepted['volumes'][indexes[0]] == before['volumes'][indexes[0]]
                and after['containers'][0]['volumeMounts'] == before['containers'][0]['volumeMounts'], 'Accepted read-only overlay mounts/defaults differ')
        changed = copy.deepcopy(before['volumes']); changed[indexes[0]]['persistentVolumeClaim']['claimName'] = selected['shellClaim']
        require(changed == after['volumes'], 'Only the selected public claim may change after bootstrap')
        expected['volumes'][indexes[0]]['persistentVolumeClaim']['claimName'] = selected['shellClaim']
    return expected


def static_fetch(url, maximum):
    opener = urllib.request.build_opener(updater.NoRedirect(),urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(url,timeout=30) as response:
        require(response.status == 200, 'Normal public HTTPS status differs')
        data = response.read(maximum + 1); require(len(data) <= maximum, 'Normal HTTPS body exceeds exact bound'); return data


class Publication:
    def __init__(self, path, checksum, operator_sha, command_runner=None, static_fetcher=None):
        self.path = cohort.local_path(str(path),Path.cwd()); self.input_sha = cohort.sha(checksum); self.operator_sha = cohort.sha(operator_sha)
        require(stage.checksum(__file__) == self.operator_sha and stage.checksum(self.path) == self.input_sha, 'Reviewed public publisher source/input changed')
        self.inputs = cohort.Inputs(self.path.parent); self.value = self.inputs.file({'path':str(self.path),'sha256':self.input_sha})
        x = self.value; exact(x, INPUT_KEYS); require(type(x['version']) is int and x['version'] == 1 and x['status'] == 'REVIEWED_PUBLIC_SHELL_PUBLICATION_INPUT', 'Reviewed public publication input required')
        stage_path = self.inputs.file(x['stageInput'],False)
        stage_input = self.inputs.file(x['stageInput']); sources = {Path(r['path']).name:r for r in stage_input['sourceFiles']}
        require('stage-public-shell.py' in sources, 'Maintained reviewed stager source required')
        self.guard = stage.Stage(stage_path,x['stageInput']['sha256'],sources['stage-public-shell.py']['sha256'])
        self.proof = review_retirement(self.inputs.file(x['stage']),self.guard)
        self.prepared, self.previous = self.guard.prepared, self.guard.previous
        self.expected_owner_spec = expected_owner_spec(self.guard)
        require(x['preflight'] == self.guard.value['preflight'], 'Promotion must use the same explicit reviewed target preflight')
        pinned = {self.inputs.file(r,False) for r in x['sourceFiles']}
        require(pinned == {Path(__file__).with_name(n).resolve() for n in stage.SOURCE_NAMES | {'publish-public-shell.py'}}, 'Exact complete public publisher source closure required')
        self.out = Path(x['outputDirectory']); require(self.out.is_absolute() and self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent
                and self.out != self.guard.out and self.guard.out not in self.out.parents and self.out not in self.guard.out.parents, 'Exclusive separate publication output required')
        self.guard.out = self.out; self.guard.policy_retired = True
        self.guard.identities = lambda: {'shellClaim':self.proof['claim'],'shellClaimPV':self.proof['pv'],'policy':self.proof['policy'],'writer':self.proof['writer'],'qualifier':self.proof['qualifier']}
        self.static_fetcher = static_fetcher or static_fetch
        if command_runner: self.guard.run = command_runner
        self.probes = x['staticProbes']; require(isinstance(self.probes,list) and 4 <= len(self.probes) <= 100, 'Explicit public HTTPS index/catalog/chunk probes required')
        origins = {urllib.parse.urlsplit(u).netloc for u in self.guard.component.get('healthURLs',[])}
        require(origins, 'Explicit public component HTTPS origin required')
        urls, paths = set(), set()
        for row in self.probes:
            exact(row, {'url','path','size','sha256'}); parts = urllib.parse.urlsplit(row['url'])
            require(parts.scheme == 'https' and parts.netloc in origins and not parts.username and not parts.password and not parts.query and not parts.fragment
                    and parts.path == '/' + urllib.parse.quote(row['path'],safe='/') and row['url'] not in urls, 'Credential-free exact normal public route required')
            require(self.guard.effective.files.get(row['path']) == {k:row[k] for k in ('path','size','sha256')} and row['size'] <= 8 * 1024**2, 'Probe must bind actual qualified static bytes')
            urls.add(row['url']); paths.add(row['path'])
        require({'index.html','catalog/tools/index.json','catalog/tools/index.sig.json'} <= paths and any(p.startswith('_app/') for p in paths), 'Entry/catalog/lazy chunk probes missing')
        self.source_check()

    def source_check(self):
        require(stage.checksum(self.path) == self.input_sha and stage.checksum(__file__) == self.operator_sha, 'Publisher source/input custody changed')
        self.inputs.unchanged(); self.guard.source_check()

    def save(self, name, value): return self.guard.save(name,value)

    def begin(self, phase):
        self.source_check(); updater.write_json(self.out/(phase+'.started.json'),{'version':1,'status':'STARTED_NO_RETRY','inputSha256':self.input_sha,'operatorSha256':self.operator_sha})

    def phase(self, name, body):
        self.begin(name)
        try:
            value = body(); self.save(name+'.actual.json',{'version':1,'inputSha256':self.input_sha,'operatorSha256':self.operator_sha,**value}); return value
        except Exception as error:
            self.save(name+'.uncertain.json',{'version':1,'status':'REFUSED_NO_REPLAY_READ_ONLY_RECONCILIATION_REQUIRED','failureType':type(error).__name__,'inputSha256':self.input_sha}); raise

    def prior(self, name, status):
        value = updater.load_json(self.out/(name+'.actual.json'))
        require(value.get('status') == status and value.get('inputSha256') == self.input_sha and value.get('operatorSha256') == self.operator_sha, 'Actual accepted prior publication phase required'); return value

    def retired(self):
        for role in ('writer','qualifier'):
            pod = self.proof[role]; require(self.guard.absent('pod',pod['metadata']['name']), 'A retired public stager reappeared')
            self.guard.mount_release(pod['metadata']['uid'])
        require(self.guard.absent('networkpolicy',self.proof['policy']['metadata']['name']), 'Retired deny policy reappeared')

    def fresh(self, after=False, owner_uid=None):
        self.source_check(); self.retired(); self.guard.verify_bindings(); pods = self.guard.fresh(owner_uid,after)
        current = self.guard.get('deployment',self.guard.component['deployment'],self.guard.namespace)
        require(current['metadata']['uid'] == self.guard.component['deploymentUID'] and current['spec'] == (self.prepared['desiredSpec'] if after else self.guard.accepted_deployment['spec']), 'Current exact public Deployment differs')
        return current,pods

    def preflight(self):
        # The full resource and retired UID checks occur before this final target
        # command. Nothing else may run between this command and the mutation.
        self.source_check(); self.guard.run([sys.executable,'-B',str(self.guard.preflight_path)],timeout=120)

    def patch(self, patch, dryrun):
        args = ['patch','deployment',self.guard.component['deployment'],'-n',self.guard.namespace,'--type=json','--patch',cohort.canonical(patch).decode(),'-o','json']
        if dryrun: args.append('--dry-run=server')
        roots = self.root_metadata()
        self.save(('dryrun' if dryrun else 'apply')+'.root-metadata.original.json',roots)
        self.preflight(); raw = self.guard.remote(args); response = cohort.parse_json(raw)
        self.save(('dryrun' if dryrun else 'apply')+'.response.original.json',response)
        require(response['metadata']['uid'] == self.guard.component['deploymentUID'] and response['spec'] == self.prepared['desiredSpec'], 'Original admission/apply response changed an unselected field')
        return response

    def root_metadata(self):
        # Model storage is never mounted by a stager. Only metadata at its whole
        # backing root is read; mismatch refuses rather than repairing it.
        roots = {'overlay':self.guard.root_metadata(),'models':self.guard.root_metadata(models=True)}
        observed = [self.guard.inputs.file(roots[role])['metadata']['root'] for role in ('overlay','models')]
        require((observed[0]['device'],observed[0]['inode']) != (observed[1]['device'],observed[1]['inode']), 'Overlay and models unexpectedly alias the same filesystem root')
        return roots

    def dryrun(self):
        require(not self.out.exists(), 'New exclusive publication output required'); self.out.mkdir(mode=0o700)
        return self.phase('dryrun',lambda: {'status':'PUBLIC_SHELL_ADMISSION_DRY_RUN_ACCEPTED','deployment':self.patch(patch_for(self.prepared,self.fresh()[0]),True),'productionMutation':False})

    def apply(self):
        self.prior('dryrun','PUBLIC_SHELL_ADMISSION_DRY_RUN_ACCEPTED')
        return self.phase('apply',lambda: {'status':'ATOMIC_PUBLIC_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING','deployment':self.patch(patch_for(self.prepared,self.fresh()[0]),False),'productionMutation':True})

    def observe(self, timeout=180):
        self.prior('apply','ATOMIC_PUBLIC_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING')
        def body():
            self.guard.remote(['rollout','status','deployment/'+self.guard.component['deployment'],'-n',self.guard.namespace,'--timeout='+str(timeout)+'s'],timeout=timeout+20)
            pods = self.guard.get('pods',namespace=self.guard.namespace)['items']; candidates = []
            for pod in pods:
                if any(v.get('persistentVolumeClaim',{}).get('claimName') == self.prepared['selection']['shellClaim'] for v in pod['spec'].get('volumes',[])): candidates.append(pod)
            require(len(candidates) == 1 and candidates[0]['metadata']['uid'] != self.guard.owner_uid, 'Exactly one new public overlay owner required')
            pod = candidates[0]; current,pods = self.fresh(True,pod['metadata']['uid'])
            refs = pod['metadata'].get('ownerReferences',[]); require(len(refs) == 1, 'Actual new owner chain missing')
            replica = self.guard.get('replicaset',refs[0]['name'],self.guard.namespace); self.guard.owner_chain(pod,replica,current)
            want = {'apiVersion':'v1','kind':'Pod','metadata':{'name':pod['metadata']['name'],'namespace':self.guard.namespace,'labels':current['spec']['template']['metadata'].get('labels',{})},'spec':self.expected_owner_spec}
            stage.validate_public_pod(pod,want,True); status = self.guard.healthy(pod,self.prepared['selection']['container'])
            identity = self.guard.remote(['exec','-n',self.guard.namespace,pod['metadata']['name'],'-c',self.prepared['selection']['container'],'--','sh','-eu','-c','id -u; id -g'])
            require(identity == b'101\n101\n', 'Actual owning Nginx UID/GID differs')
            old_overlay = self.previous['overlay']; protected = {self.prepared['modelsClaim'],self.prepared['selection']['shellClaim']}
            for p in pods['items']:
                for volume in stage.resources.active_volumes(p['spec']):
                    claim = volume.get('persistentVolumeClaim',{}).get('claimName')
                    require(claim not in protected or p['metadata']['uid'] == pod['metadata']['uid'], 'Models/new shell have another owner')
                    require(not old_overlay or claim != old_overlay['claim'], 'Retained old overlay still mounted')
            runtime = {}
            for name, component in self.guard.target['components'].items():
                d = updater.deployment_identity(component,self.guard.kube)
                require(d['status'].get('readyReplicas') == d['spec'].get('replicas',1) and d['status'].get('updatedReplicas') == d['spec'].get('replicas',1)
                        and d['status'].get('availableReplicas') == d['spec'].get('replicas',1) and d['status'].get('observedGeneration') == d['metadata']['generation'], 'A protected application is not healthy')
                runtime[name] = {'uid':d['metadata']['uid'],'specSha256':cohort.digest(d['spec']),'ready':True}
            owner = self.save('observe.owner.original.json',{'deployment':current,'pod':pod,'replicaSet':replica,'protectedRuntime':runtime})
            static,hashes = self.guard.full_tree(pod,self.guard.effective.files,container=self.prepared['selection']['container'])
            catalog = self.guard.catalog(pod,container=self.prepared['selection']['container']); probes = {}
            for row in self.probes:
                data = self.static_fetcher(row['url'],row['size']); require(len(data) == row['size'] and hashlib.sha256(data).hexdigest() == row['sha256'], 'Fresh normal verified-TLS static bytes differ')
                probes[row['url']] = {'status':200,'verifiedTlsAndHostname':True,'size':len(data),'sha256':row['sha256']}
            tls = self.save('observe.https.actual.json',{'normalVerifiedTLSRequests':probes,'trustedSystemCA':{'certificateVerification':'CERT_REQUIRED','hostnameVerification':True}})
            root_before = updater.load_json(self.out/'apply.root-metadata.original.json'); root_after = self.root_metadata()
            for role in ('overlay','models'):
                claim, pv = (self.proof['claim'],self.proof['pv']) if role == 'overlay' else (self.guard.inputs.file(self.previous['modelsClaim']),self.guard.inputs.file(self.previous['modelsPV']))
                stage.same_root(stage.root_proof(root_before[role],self.guard,claim,pv),stage.root_proof(root_after[role],self.guard,claim,pv))
            self.save('observe.root-metadata.original.json',root_after)
            self.fresh(True,pod['metadata']['uid']); self.guard.healthy(self.guard.get('pod',pod['metadata']['name'],self.guard.namespace),self.prepared['selection']['container'])
            previous = self.accepted_previous(current,pod,replica,static,hashes,catalog,owner,tls,probes)
            return {'status':'PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED','acceptedPrevious':previous,'readOnly':True,'productionMutation':False,'remainingAcceptance':['Signed-in or full-app browser reconnection where applicable','Physical presenter/clicker and unqualified native targets']}
        return self.phase('observe',body)

    def accepted_previous(self, deployment, pod, replica, static, hashes, catalog, owner, tls, probes):
        config = self.guard.inputs.file(self.previous['nginxConfig']); pin = self.previous['publicCatalog']; claimed = self.proof['claim']['metadata']
        runtime = {'actualPublicSpecSha256':cohort.digest(deployment['spec']),'independentExpectedSpecSha256':self.prepared['desiredSpecSha256'],
                   'image':self.prepared['image'],'imageID':self.prepared['image'],'deploymentUID':deployment['metadata']['uid'],'podUID':pod['metadata']['uid'],
                   'podSpecSha256':cohort.digest(pod['spec']),'replicaSetUID':replica['metadata']['uid'],'ready':True,'restarts':0,'allStaticFilesChecked':len(self.guard.effective.files),'uidGid':['101','101'],
                   'stagerPodAndPolicyAbsent':True,'modelsPrefixExcluded':public.ROOT+'/models/','runtimeHashManifestSha256':hashes['sha256'],
                   'modelsClaimUID':self.prepared['modelsClaimUID'],'modelsPVUID':self.prepared['modelsPVUID'],'nginxConfigSha256':hashlib.sha256(config['data']['default.conf'].encode()).hexdigest()}
        original = {'version':1,'status':'PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED','shellSource':self.prepared['sources']['shell'],'imageSource':self.prepared['sources']['image'],
                    'overlayManifestSha256':self.guard.new.manifest_sha,'staticManifestSha256':self.guard.producer['shell']['manifest']['sha256'],
                    'readOnly':True,'productionMutation':False,'publicMCPAndOtherEightSpecsUnchanged':True,'preparedSha256':self.guard.value['prepared']['sha256'],'runtime':runtime,
                    'catalogSignatureVerifiedAndActualSignedBytesMatched':{'verified':True,'exactFreshNeutralCatalogPayloadPreserved':True,'existingPublicPinCanonicalSha256':pin['pinCanonicalSha256'],
                          'publicJWKSha256':self.previous['publicKeySha256'],'indexSha256':pin['indexSha256'],'keyId':pin['keyId'],'files':pin['signedFiles']},
                    'normalVerifiedTLSRequests':probes,'trustedSystemCA':{'certificateVerification':'CERT_REQUIRED','hostnameVerification':True},
                    'actualReadbackEvidence':[owner,static,hashes,catalog,tls],'originalCommands':self.guard.events,
                    'checksumListConversion':'DERIVED_LOSSLESSLY_FROM_COMPLETE_ACTUAL_OWNING_POD_STAT_AND_SHA256_OUTPUT','ociImageSignatureClaimed':False}
        original_ref = self.save('observe.acceptance.original.json',original)
        deployment_ref = self.save('accepted.deployment.original.json',deployment)
        def absolute(ref): return {**ref,'path':str(cohort.local_path(ref['path'],self.guard.inputs.base))}
        previous = {**self.previous,'shellSource':self.prepared['sources']['shell'],'staticManifest':absolute(self.guard.producer['shell']['manifest']),
                    'deploymentSpecSha256':cohort.digest(deployment['spec']),'deployment':deployment_ref,
                    'overlay':{'volume':self.prepared['selection']['shellVolume'],'claim':claimed['name'],'claimUID':claimed['uid'],'manifest':absolute(self.guard.producer['overlay']['manifest'])},
                    'originalEvidence':[original_ref,absolute(self.previous['originalEvidence'][1]),absolute(static),absolute(hashes),absolute(self.guard.value['prepared'])]}
        for key in ('nginxConfig','modelsClaim','modelsPV','policyInventory','serviceInventory'): previous[key] = absolute(self.previous[key])
        # Fail before publishing next-release custody if the actual future
        # baseline parser cannot consume it. No success-wrapper normalization.
        public.baseline(previous,self.guard.inputs)
        return self.save('accepted.previous.json',previous)

    def rollback_intent(self):
        self.prior('apply','ATOMIC_PUBLIC_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING')
        def body():
            pods = self.guard.get('pods',namespace=self.guard.namespace)['items']
            holders = [p for p in pods if any(v.get('persistentVolumeClaim',{}).get('claimName') == self.prepared['selection']['shellClaim'] for v in p['spec'].get('volumes',[]))]
            require(len(holders) == 1, 'Fresh current owner required for rollback review')
            current,_ = self.fresh(True,holders[0]['metadata']['uid'])
            return {'status':'FRESH_PUBLIC_ROLLBACK_REVIEW_INTENT_NOT_EXECUTABLE','deploymentUID':current['metadata']['uid'],'resourceVersion':current['metadata']['resourceVersion'],
                    'currentSpecSha256':cohort.digest(current['spec']),'restoreSpec':self.guard.accepted_deployment['spec'],'productionMutation':False,
                    'required':['Separate current data/asset compatibility review','Fresh isolated target/storage guards and server admission','A new reviewed rollback operator intent; never replay the old patch']}
        return self.phase('rollback-intent',body)

    def execute(self, action, timeout=180):
        if action == 'check': return {'status':'PUBLIC_PUBLICATION_INPUTS_BOUND_NOT_EXECUTED','productionMutation':False,'desiredSpecSha256':self.prepared['desiredSpecSha256']}
        return {'dryrun':self.dryrun,'apply':self.apply,'observe':lambda:self.observe(timeout),'rollback-intent':self.rollback_intent}[action]()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['check','dryrun','apply','observe','rollback-intent'])
    parser.add_argument('--inputs',required=True); parser.add_argument('--sha256',required=True); parser.add_argument('--operator-sha256',required=True); parser.add_argument('--timeout',type=int,default=180)
    args = parser.parse_args(); require(1 <= args.timeout <= 600, 'Bounded rollout observation timeout required')
    print(json.dumps(Publication(args.inputs,args.sha256,args.operator_sha256).execute(args.action,args.timeout),sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Refusal,private.Refusal,updater.Refusal,stage.resources.Refusal,OSError,ValueError,KeyError,TypeError,StopIteration,subprocess.SubprocessError):
        print('REFUSED: public promotion custody, retired mounts, exact storage/spec or observation differs; preserve originals and never replay',file=sys.stderr); raise SystemExit(1)
