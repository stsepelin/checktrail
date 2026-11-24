"""Synthetic Docker daemon table for every owned container/image lifecycle.

No Docker, GCC, SDK or project code runs: /usr/bin/docker is answered by an
in-memory table. Right after a container is admitted, the table renames it
away and binds its exact name and owner labels to a foreign container, so only
an effect addressed by the admitted ID can reach the owned container.
"""
import ast
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
MODULES=ROOT/'scripts/producer-qualification'


def load(name,alias):
    spec=importlib.util.spec_from_file_location(alias,MODULES/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


carrier=load('gcc-hosted-carrier.py','identity_carrier')
sdk=load('gcc-hosted-sdk.py','identity_sdk')
prepare=load('gcc-main05-prepare.py','identity_prepare')
start=load('gcc-main05-start.py','identity_start')
observer=start.observer
BASE_IMAGE={'Id':'sha256:'+'4a'*32,'Os':'linux','Architecture':'amd64','RepoTags':[],
            'RootFS':{'Type':'layers','Layers':['sha256:'+'5b'*32]},'Config':{'User':'0:0','WorkingDir':'/work','Labels':{}}}
# Every container verb that addresses one container or image by reference.
TARGETED={'attach','commit','cp','diff','exec','export','inspect','kill','logs','pause','port','rename','restart',
          'rm','start','stop','top','unpause','update','wait'}
PROOF={'state':'sdk-material-reconstructed-and-physically-verified','packageInventoryMatches':True,
       'sdkMaterialReconstructionObserved':True,'generatedStatePhysicallyValidated':True,
       'allTimestampWritesPrecededFinalValidators':True,'softwareAndGeneratedStateContract':'gcc12-original-sdk-generated-state-v1',
       'historicalCacheBodyEqualityClaimed':False,'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,
       'wholeRootIdentityClaimed':False}


class Refused(Exception):
    """A daemon-side refusal, surfaced to the caller as a nonzero docker exit."""


class Daemon:
    def __init__(self,*,rebind,exit_code=0,body=None):
        self.rebind=rebind;self.exit_code=exit_code;self.body=body or (lambda record:None)
        self.containers={};self.images={BASE_IMAGE['Id']:json.loads(json.dumps(BASE_IMAGE))}
        self.aliases={sdk.codec.IMAGE:BASE_IMAGE['Id']}
        self.pending=[];self.rebound=set();self.foreign=set();self.foreign_images=set();self.effects=[];self.calls=[];self.rebinds=0
        self.serial=0;self.foreign_serial=0

    def next_id(self):
        self.serial+=1;return ('%02x'%(0x30+self.serial))*32

    def next_foreign(self):
        self.foreign_serial+=1;return 'f'*62+'%02x'%(0xa0+self.foreign_serial)

    def lookup(self,reference):
        if reference in self.containers:return reference
        named=[key for key,row in self.containers.items() if row['Name']==reference]
        if len(named)!=1:raise Refused('No such container: '+reference)
        return named[0]

    def race(self,verb,reference):
        """Rebind each admitted name exactly once, before its first post-admission effect."""
        if not self.rebind:return
        for owned in list(self.pending):
            row=self.containers[owned]
            if verb=='inspect' and reference==row['Name'] and row['admissions']==0:
                row['admissions']+=1;continue
            name=row['Name'];row['Name']=name+'-renamed-by-synthetic-race-137';self.pending.remove(owned)
            foreign=self.next_foreign();clone=json.loads(json.dumps({key:value for key,value in row.items() if key!='admissions'}))
            clone.update(Id=foreign,Name=name,State={'Status':'created','Running':False,'Pid':0,'ExitCode':0,'OOMKilled':False,'Error':''})
            self.containers[foreign]={**clone,'admissions':1};self.foreign.add(foreign);self.rebound.add(owned);self.rebinds+=1

    def effect(self,verb,reference):
        self.race(verb,reference)
        target=self.lookup(reference);self.effects.append((verb,target));return target

    def create(self,args):
        options={};labels={};mounts=[];index=1;env=[]
        flags_with_value={'--name','--label','--entrypoint','--workdir','--user','--hostname','--network','--cpus','--memory',
                          '--pids-limit','--mount','--platform'}
        while index<len(args):
            arg=args[index]
            if arg in flags_with_value:
                value=args[index+1];index+=2
                if arg=='--label':key,_,text=value.partition('=');labels[key]=text
                elif arg=='--mount':
                    parts=dict(part.partition('=')[::2] for part in value.split(',') if '=' in part)
                    mounts.append({'Type':parts['type'],'Source':parts.get('src',parts.get('source')),
                                   'Destination':parts['target'],'RW':'readonly' not in value.split(',')})
                else:options[arg]=value
                continue
            if arg.startswith('--'):options[arg]=True;index+=1;continue
            image=arg;command=args[index+1:];break
        require_image=self.aliases.get(image,image);assert require_image in self.images,image
        if any(row['Name']==options['--name'] for row in self.containers.values()):
            raise Refused('Conflict. The container name "/'+options['--name']+'" is already in use')
        identifier=self.next_id()
        self.containers[identifier]={'Id':identifier,'Name':options['--name'],'admissions':0,
            'Config':{'Labels':labels,'Image':image,'Entrypoint':[options.get('--entrypoint')],'Cmd':command,
                      'User':options.get('--user'),'WorkingDir':options.get('--workdir')},
            'HostConfig':{'NetworkMode':options.get('--network'),'Privileged':False,'Init':options.get('--init') is True,
                          'NanoCpus':int(float(options.get('--cpus','0'))*1e9),
                          'Memory':6*carrier.GIB if options.get('--memory')=='6g' else 0,
                          'PidsLimit':int(options.get('--pids-limit','0'))},
            'Mounts':mounts,'SizeRw':6137,
            'State':{'Status':'created','Running':False,'Pid':0,'ExitCode':0,'OOMKilled':False,'Error':''}}
        self.pending.append(identifier);return identifier+'\n'

    def public(self,row):
        return {key:value for key,value in row.items() if key not in {'admissions','Name'}}

    def image_ref(self,reference):
        if reference in self.images:return reference
        tagged=[key for key,row in self.images.items() if reference in row['RepoTags']]
        if reference in self.aliases:return self.aliases[reference]
        if len(tagged)!=1:raise Refused('No such image: '+reference)
        return tagged[0]

    def image(self,args):
        verb=args[1]
        if verb=='inspect':
            target=self.image_ref(args[2]);self.effects.append(('image-inspect',target))
            value=self.images[target]
            # A tag read is the image admission; rebind the tag right after it.
            if self.rebind and args[2]!=target and args[2] in value['RepoTags'] and target not in self.foreign_images:
                foreign='sha256:'+'f'*64;self.foreign_images.add(foreign);self.rebinds+=1
                value['RepoTags']=[tag for tag in value['RepoTags'] if tag!=args[2]]
                self.images[foreign]={**json.loads(json.dumps(value)),'Id':foreign,'RepoTags':[args[2]]}
                return json.dumps([{**json.loads(json.dumps(value)),'RepoTags':[args[2]]}])
            return json.dumps([value])
        if verb=='ls':
            if '--all' in args:return ''.join(key+'\n' for key in self.images)
            return ''.join(key+'\n' for key,row in self.images.items() if args[-1] in row['RepoTags'])
        if verb=='rm':
            # Docker semantics: a tag reference only untags unless it was the
            # last tag; an ID with several tags is refused without --force.
            target=self.image_ref(args[2]);self.effects.append(('image-rm',target));row=self.images[target]
            if args[2]!=target:
                row['RepoTags']=[tag for tag in row['RepoTags'] if tag!=args[2]]
                if row['RepoTags']:return 'Untagged: '+args[2]+'\n'
            elif len(row['RepoTags'])>1:raise Refused('image is referenced in multiple repositories')
            del self.images[target];return 'Deleted: '+target+'\n'
        raise AssertionError('Unplanned image operation '+repr(args))

    def run(self,argv,**kwargs):
        assert argv[0]=='/usr/bin/docker',argv
        args=argv[1:];self.calls.append(args)
        try:stdout=self.dispatch(args)
        except Refused as error:return types.SimpleNamespace(returncode=1,stdout=b'',stderr=str(error).encode())
        return types.SimpleNamespace(returncode=0,stdout=stdout.encode(),stderr=b'')

    def dispatch(self,args):
        verb=args[0]
        if verb=='pull':return 'pulled\n'
        if verb=='info':return '{}'
        if verb=='image':return self.image(args)
        if verb=='create':return self.create(args)
        if verb=='ps':
            selector=args[-1]
            if selector.startswith('name='):name=selector[len('name=^/'):-1];return ''.join(k+'\n' for k,r in self.containers.items() if r['Name']==name)
            assert selector.startswith('id='),args;return ''.join(k+'\n' for k in self.containers if k==selector[3:])
        assert verb in TARGETED,'Unplanned Docker operation '+repr(args)
        if verb=='inspect':
            target=self.effect('inspect',args[-1]);return json.dumps([self.public(self.containers[target])])
        if verb=='cp':
            reference=args[2].split(':',1)[0];self.effect('cp',reference);return ''
        if verb=='kill':
            target=self.effect('kill',args[-1]);self.containers[target]['State'].update(Status='exited',Running=False,Pid=0);return ''
        if verb=='rm':
            target=self.effect('rm',args[-1]);row=self.containers[target]
            if row['State']['Running'] and '--force' not in args:raise Refused('container is running')
            del self.containers[target];return ''
        if verb=='commit':
            target=self.effect('commit',args[-2]);row=self.containers[target]
            image='sha256:'+hashlib.sha256(target.encode()).hexdigest()
            base=self.images[self.aliases.get(row['Config']['Image'],row['Config']['Image'])]
            self.images[image]={'Id':image,'Os':'linux','Architecture':'amd64','RepoTags':[args[-1]],
                                'RootFS':{'Type':'layers','Layers':base['RootFS']['Layers']+['sha256:'+'6c'*32]},
                                'Config':{'User':'0:0','WorkingDir':'/work','Labels':row['Config']['Labels']}}
            return image+'\n'
        raise AssertionError('Unplanned Docker operation '+repr(args))

    def popen(self,argv,**kwargs):
        assert argv[:3]==['/usr/bin/docker','start','--attach'] and len(argv)==4,argv
        self.calls.append(argv[1:]);target=self.effect('start',argv[3]);row=self.containers[target]
        code=self.exit_code if target not in self.foreign else 0
        if target not in self.foreign:self.body(row)
        row['State'].update(Status='exited',Running=False,Pid=0,ExitCode=code)
        read,write=os.pipe();os.write(write,b'Synthetic attached stdout 137\n');os.close(write)
        class Process:
            pid=2**22+137;returncode=None;stdout=os.fdopen(read,'rb')
            def wait(self,timeout=None):self.returncode=code;return code
            def poll(self):self.returncode=code;return code
        return Process()

    @contextlib.contextmanager
    def serving(self):
        real=subprocess.run
        def run(argv,*args,**kwargs):
            if argv and argv[0]=='/usr/bin/docker':return self.run(argv,**kwargs)
            raise AssertionError('Unplanned subprocess '+repr(argv))
        with mock.patch.object(subprocess,'run',side_effect=run),mock.patch.object(subprocess,'Popen',side_effect=self.popen),\
             mock.patch.object(shutil,'disk_usage',return_value=types.SimpleNamespace(free=400*carrier.GIB)),\
             mock.patch.object(time,'sleep'):
            yield self
        assert subprocess.run is real

    def foreign_effects(self):
        return [effect for effect in self.effects if effect[1] in self.foreign or effect[1] in self.foreign_images]


def copy_input(source,target,pin):
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b'synthetic-input-137')


class Identity(unittest.TestCase):
    def folder(self):
        temporary=tempfile.TemporaryDirectory(prefix='gcc-identity-synthetic-');self.addCleanup(temporary.cleanup)
        return Path(temporary.name).resolve()

    def service(self):
        return {'clock':{'remainingSeconds':20000,'capturedMonotonic':time.monotonic(),'jobId':137},'cache':{'headroomAdmitted':True}}

    def assert_contained(self,daemon,*,expect_rebinds):
        self.assertEqual(daemon.foreign_effects(),[],'An effect reached a container or image that took the owned name')
        if expect_rebinds:
            self.assertGreater(daemon.rebinds,0,'The synthetic race never rebound a name')
            started=[target for verb,target in daemon.effects if verb in ('start','cp')]
            self.assertTrue(started);self.assertLessEqual(set(started),daemon.rebound,'A started or copied container was never raced')
        else:self.assertEqual(daemon.rebinds,0)
        # A foreign holder of the name is never removed.
        for foreign in daemon.foreign:self.assertIn(foreign,daemon.containers)
        for foreign in daemon.foreign_images:self.assertIn(foreign,daemon.images)

    # Hosted configure carrier -------------------------------------------------
    def run_carrier(self,*,rebind,exit_code,holder=None):
        root=self.folder();inputs=root/'inputs';inputs.mkdir();output=root/'gcc-phase0'
        config={'synthetic':'configuration-137'};selected={'configurationSha256':'7'*64}
        def body(row):
            if row['Config']['Labels'].get('io.checktrail.gcc-staged-owner')!=row['Name'].removesuffix('-renamed-by-synthetic-race-137'):return
            work=output/'state/__carrier_work'
            (work/'FIRST-STAGE.json').write_text(json.dumps({'state':'native-configure-terminal-and-selected-configuration-observed',
                'configure':{'exitCode':0,'command':['synthetic-configure']},'externalSdkUnchanged':True,'selectedConfiguration':selected,
                'packageInventorySha256':'8'*64,'externalSdkSha256':'9'*64}))
            (work/'configured-values.json').write_text(json.dumps(config))
            (output/'state/source/stamps').mkdir(parents=True);(output/'state/source/stamps/04-configure-stamp').write_text('stamp')
        daemon=Daemon(rebind=rebind,exit_code=exit_code,body=body);real_load=carrier.load
        if holder is not None:
            # Another run's container, labelled as its own owner under `holder`.
            foreign=daemon.next_foreign();daemon.foreign.add(foreign)
            daemon.containers[foreign]={'Id':foreign,'Name':holder,'admissions':1,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':holder}},
                                        'State':{'Status':'running','Running':True,'Pid':4137,'ExitCode':0,'OOMKilled':False,'Error':''}}
        def load(path):
            module=real_load(path)
            if path.name=='gcc-staged-plan.py':module.read_configuration=lambda *args:config
            if path.name=='gcc-hosted-stage.py':module.selected_configuration=lambda *args:selected
            if path.name=='gcc-staged-checkpoint.py':module.capture=mock.Mock(side_effect=RuntimeError('Synthetic stop after native cleanup'))
            return module
        resources={'context':{'GITHUB_SHA':'b'*40}}
        argv=['carrier','--repository',str(ROOT),'--inputs',str(inputs),'--output',str(output),'--operator-trust-execution']
        with daemon.serving(),mock.patch.dict(os.environ,{'RUNNER_TEMP':str(root),'CHECKTRAIL_HOST_NODE':'{}'}),\
             mock.patch.object(sys,'argv',argv),mock.patch.object(carrier.os,'getuid',return_value=0),\
             mock.patch.object(carrier,'load',side_effect=load),\
             mock.patch.object(carrier.capacity,'stock_resources',return_value=resources),\
             mock.patch.object(carrier.capacity,'GitHub'),mock.patch.object(carrier.capacity,'capture_service',side_effect=lambda *a:self.service()),\
             mock.patch.object(carrier.capacity,'admit',return_value={}),\
             mock.patch.object(carrier,'verify_repository',return_value={}),mock.patch.object(carrier,'admit_host_node',return_value={'path':'/synthetic/node'}),\
             mock.patch.object(carrier,'copy_pinned',side_effect=copy_input),\
             mock.patch.object(carrier,'validate_and_retain_image',return_value={}),\
             mock.patch.object(carrier,'validate_daemon',return_value=resources),\
             mock.patch.object(carrier,'admit_state',return_value={'maximumNativeSeconds':60}),\
             mock.patch.object(carrier,'failed_retention_ledger',return_value={}):
            with self.assertRaises(Exception) as raised:carrier.main()
        return daemon,raised.exception,json.loads((output/'CARRIER.json').read_bytes())

    def test_configure_carrier_success_path_never_reaches_a_container_that_took_the_owned_name(self):
        for rebind in [True,False]:
            with self.subTest(rebind=rebind):
                daemon,error,outcome=self.run_carrier(rebind=rebind,exit_code=0)
                self.assert_contained(daemon,expect_rebinds=rebind)
                self.assertEqual(str(error),'Synthetic stop after native cleanup')
                created=[args for args in daemon.calls if args[0]=='create']
                owner=created[1][created[1].index('--name')+1]
                self.assertRegex(owner,'^checktrail-gcc-staged-[0-9a-f-]{36}$')
                self.assertIn('io.checktrail.gcc-staged-owner='+owner,created[1])
                self.assertEqual(created[0][created[0].index('--name')+1],owner+'-seed')
                self.assertEqual((outcome['ownedSeedCleanup'],outcome['ownedContainerCleanup']),('removed','removed'))
                owned=[target for verb,target in daemon.effects if verb=='start']
                self.assertEqual(len(owned),1);self.assertNotIn(owned[0],daemon.containers)
                self.assertEqual([verb for verb,target in daemon.effects if target==owned[0]],['inspect','start','inspect','inspect','rm'])

    def test_configure_carrier_failure_path_signals_and_removes_only_the_admitted_id(self):
        for rebind in [True,False]:
            with self.subTest(rebind=rebind):
                daemon,error,outcome=self.run_carrier(rebind=rebind,exit_code=3)
                self.assert_contained(daemon,expect_rebinds=rebind)
                self.assertIn('exited nonzero',str(error))
                owned=[target for verb,target in daemon.effects if verb=='start'][0]
                self.assertEqual([verb for verb,target in daemon.effects if target==owned],['inspect','start','kill','kill','inspect','inspect','rm'])
                self.assertEqual(outcome['ownedContainerCleanup'],'removed');self.assertNotIn(owned,daemon.containers)

    def test_configure_carrier_never_shares_an_owner_name_with_another_run(self):
        # The holder name is every fixed control filename, the per-run token's only possible collision.
        for holder in [*carrier.SOURCE_CONTROLS,'gcc-hosted-stage.py']:
            with self.subTest(holder=holder):
                daemon,error,outcome=self.run_carrier(rebind=False,exit_code=3,holder=holder)
                self.assert_contained(daemon,expect_rebinds=False)
                self.assertIn('exited nonzero',str(error));self.assertEqual(outcome['ownedContainerCleanup'],'removed')
                self.assertEqual(daemon.containers[sorted(daemon.foreign)[0]]['Name'],holder)

    # SDK reconstruction (standalone and main05 materializer) -------------------
    def sdk_patches(self,module,frame_root,resources):
        h=module.h if hasattr(module,'h') else module.sdk.h
        target=module if hasattr(module,'verify_predecessor') else module.sdk
        def predecessor(transport,output):
            tree=output/'predecessor';tree.mkdir();return tree,{'synthetic':'expected-root-137'}
        stack=contextlib.ExitStack()
        for patch in [mock.patch.object(h.capacity,'stock_resources',return_value=resources),mock.patch.object(h.capacity,'GitHub'),
                      mock.patch.object(h.capacity,'capture_service',side_effect=lambda *a:self.service()),
                      mock.patch.object(h,'verify_repository',return_value={'synthetic':'source'}),
                      mock.patch.object(h,'admit_host_node',return_value={'path':'/synthetic/node'}),
                      mock.patch.object(h,'copy_pinned',side_effect=copy_input),
                      mock.patch.object(h,'validate_and_retain_image',return_value={}),
                      mock.patch.object(h,'validate_daemon',return_value=resources),
                      mock.patch.object(target,'admit',return_value={}),mock.patch.object(target,'verify_cache_identity',return_value={}),
                      mock.patch.object(target,'verify_predecessor',side_effect=predecessor),
                      mock.patch.object(target,'prepare_readonly_keyring',return_value={}),
                      mock.patch.object(target.codec,'snapshot',return_value={'synthetic':'unchanged-137'}),
                      mock.patch.object(h.os,'getuid',return_value=0),
                      mock.patch.dict(os.environ,{'RUNNER_TEMP':str(frame_root),'CHECKTRAIL_HOST_NODE':'{}','CHECKTRAIL_PREDECESSOR_CACHE_HIT':'true'})]:
            stack.enter_context(patch)
        return stack

    def proof_body(self,observations):
        def body(row):(observations/'SDK-RECONSTRUCTION.json').write_text(json.dumps(PROOF))
        return body

    def run_sdk(self,*,rebind,exit_code):
        root=self.folder();inputs=root/'inputs';inputs.mkdir();output=root/'gcc-sdk-reconstruction'
        daemon=Daemon(rebind=rebind,exit_code=exit_code,body=self.proof_body(output/'observations'))
        resources={'context':{'GITHUB_REF':sdk.PREDECESSOR['ref']}}
        argv=['sdk','--repository',str(ROOT),'--inputs',str(inputs),'--output',str(output),'--operator-trust-execution']
        error=None
        with daemon.serving(),self.sdk_patches(sdk,root,resources),mock.patch.object(sys,'argv',argv):
            try:sdk.main()
            except Exception as raised:error=raised
        return daemon,error,json.loads((output/'SDK-CARRIER.json').read_bytes())

    def test_sdk_reconstruction_starts_inspects_and_removes_only_admitted_ids(self):
        for rebind,code in [(True,0),(False,0),(True,3),(False,3)]:
            with self.subTest(rebind=rebind,exit_code=code):
                daemon,error,result=self.run_sdk(rebind=rebind,exit_code=code)
                self.assert_contained(daemon,expect_rebinds=rebind)
                if code==0:self.assertIsNone(error);self.assertEqual(result['state'],'sdk-material-reconstruction-observed-no-gcc-target-run')
                else:self.assertIn('exited nonzero',str(error))
                self.assertEqual((result['ownedSeedCleanup'],result['ownedContainerCleanup']),('removed','removed'))
                owned=[target for verb,target in daemon.effects if verb=='start'][0]
                self.assertNotIn(owned,daemon.containers)
                expected=['inspect','start','inspect','inspect','rm'] if code==0 else ['inspect','start','kill','kill','inspect','inspect','rm']
                self.assertEqual([verb for verb,target in daemon.effects if target==owned],expected)

    def run_prepare(self,*,rebind,exit_code):
        root=self.folder();inputs=root/'inputs';inputs.mkdir();(root/'gcc-main05').mkdir();frame=root/'gcc-main05/sdk-frame'
        daemon=Daemon(rebind=rebind,exit_code=exit_code,body=self.proof_body(frame/'observations'))
        resources={'context':{'GITHUB_REF':sdk.PREDECESSOR['ref']}};error=None;prepared=None
        with daemon.serving(),self.sdk_patches(prepare,root,resources):
            try:prepared=prepare.reconstruct_for_main(ROOT,inputs,frame)
            except Exception as raised:error=raised
            cleanup=None
            if (frame/'SDK-LOCAL-SNAPSHOT-REQUEST.json').exists():
                try:cleanup=prepare.image_stage.cleanup_owned(frame)
                except Exception as raised:cleanup=raised
        return daemon,error,prepared,cleanup,json.loads((frame/'SDK-FOR-MAIN.json').read_bytes())

    def test_main05_sdk_materializer_commits_and_removes_only_admitted_container_and_image_ids(self):
        for rebind in [True,False]:
            with self.subTest(rebind=rebind):
                daemon,error,prepared,cleanup,result=self.run_prepare(rebind=rebind,exit_code=0)
                self.assertIsNone(error);self.assert_contained(daemon,expect_rebinds=rebind)
                self.assertEqual(result['ownedContainerCleanup'],'removed')
                owned=[target for verb,target in daemon.effects if verb=='start'][0]
                self.assertEqual([verb for verb,target in daemon.effects if target==owned],['inspect','start','inspect','inspect','commit','inspect','rm'])
                image=prepared['localImage']['localImageId']
                if rebind:
                    # The tag now names a foreign image: removing by that tag
                    # would untag the holder, so cleanup removes nothing and
                    # stays unqualified, retaining the untagged owned image.
                    self.assertIsInstance(cleanup,ValueError);self.assertIn('no longer names the observed image',str(cleanup))
                    self.assertIn(image,daemon.images);self.assertEqual(daemon.images[image]['RepoTags'],[])
                    self.assertFalse(any(verb=='image-rm' for verb,_ in daemon.effects))
                else:
                    self.assertTrue(cleanup['ownedImageCleanupComplete'])
                    self.assertNotIn(image,daemon.images);self.assertIn(('image-rm',image),daemon.effects)

    def test_main05_sdk_materializer_failure_signals_and_removes_only_the_admitted_id(self):
        for rebind in [True,False]:
            with self.subTest(rebind=rebind):
                daemon,error,prepared,cleanup,result=self.run_prepare(rebind=rebind,exit_code=3)
                self.assertIn('exited nonzero',str(error));self.assertIsNone(cleanup)
                self.assert_contained(daemon,expect_rebinds=rebind)
                owned=[target for verb,target in daemon.effects if verb=='start'][0]
                self.assertEqual([verb for verb,target in daemon.effects if target==owned],['inspect','start','kill','kill','inspect','inspect','rm'])
                self.assertEqual(result['ownedContainerCleanup'],'removed')

    # Main05 native runtime -------------------------------------------------------
    def native_frame(self,daemon,*,response=True):
        frame=self.folder()/'native-frame';frame.mkdir()
        name='checktrail-gcc-native05-'+'3d'*16;local='sha256:'+'2e'*32
        command=['-i',*[key+'='+value for key,value in start.sdk.stage.FIXED_ENVIRONMENT.items()],*observer.BODY]
        identifier=daemon.create(['create','--init','--name',name,'--label','io.checktrail.gcc-staged-owner='+name,
                                  '--entrypoint','/usr/bin/env','--network','none','--cpus','4','--memory','6g','--pids-limit','1024',
                                  sdk.codec.IMAGE,*command]).strip()
        daemon.containers[identifier]['Config']['Image']=local
        (frame/'NATIVE-CREATION-REQUEST.json').write_text(json.dumps({'name':name,'localImageId':local,'sameNameWasAbsentObserved':True}))
        if response:(frame/'NATIVE-CREATION-RESPONSE.json').write_text(json.dumps({'name':name,'returnedContainerId':identifier}))
        return frame,name,identifier

    def test_main05_observer_and_native_cleanup_reach_only_the_admitted_id(self):
        for rebind in [True,False]:
            with self.subTest(rebind=rebind):
                daemon=Daemon(rebind=rebind,exit_code=0);frame,name,identifier=self.native_frame(daemon)
                (frame/'state').mkdir();(frame/'observations').mkdir()
                with daemon.serving():
                    attempt=observer.observe(frame,name,identifier,60,{'capturedMonotonic':time.monotonic(),'remainingSeconds':20000},sdk_seconds=50)
                    result=start.cleanup_native(frame)
                self.assertEqual(attempt['containerId'],identifier);self.assertTrue(attempt['quiescenceObserved'])
                self.assert_contained(daemon,expect_rebinds=rebind)
                self.assertEqual([verb for verb,target in daemon.effects if target==identifier],['inspect','start','inspect','inspect','rm'])
                self.assertEqual(result['removedContainerId'],identifier);self.assertNotIn(identifier,daemon.containers)
                self.assertEqual(result['ownedNameReboundTo'],sorted(daemon.foreign))
                self.assertIs(result['quiescenceAfterOwnedRemovalObserved'],not rebind)

    def test_native_cleanup_finds_a_renamed_owned_container_by_its_returned_id(self):
        for holder in ['absent','foreign']:
            with self.subTest(holder=holder):
                daemon=Daemon(rebind=False);frame,name,identifier=self.native_frame(daemon)
                daemon.containers[identifier]['Name']='synthetic-operator-rename-137'
                if holder=='foreign':
                    foreign=daemon.next_foreign();daemon.foreign.add(foreign)
                    daemon.containers[foreign]={**json.loads(json.dumps(daemon.containers[identifier])),'Id':foreign,'Name':name}
                with daemon.serving():result=start.cleanup_native(frame)
                self.assertTrue(result['ownedNativeCleanupComplete']);self.assertEqual(result['removedContainerId'],identifier)
                self.assertNotIn(identifier,daemon.containers);self.assert_contained(daemon,expect_rebinds=False)
                self.assertEqual(result['ownedNameReboundTo'],sorted(daemon.foreign))
                self.assertIs(result['quiescenceAfterOwnedRemovalObserved'],holder=='absent')

    def test_native_cleanup_reports_an_absent_returned_id_without_touching_the_name_holder(self):
        daemon=Daemon(rebind=False);frame,name,identifier=self.native_frame(daemon)
        foreign=daemon.next_foreign();daemon.foreign.add(foreign)
        daemon.containers[foreign]={**json.loads(json.dumps(daemon.containers[identifier])),'Id':foreign,'Name':name}
        del daemon.containers[identifier]
        with daemon.serving():result=start.cleanup_native(frame)
        self.assertEqual(result['state'],'exact-owned-native-container-absent');self.assertTrue(result['ownedNativeCleanupComplete'])
        self.assertEqual(result['ownedNameReboundTo'],[foreign]);self.assertNotIn('quiescenceAfterOwnedRemovalObserved',result)
        self.assertEqual(daemon.effects,[]);self.assert_contained(daemon,expect_rebinds=False)

    def test_ambiguous_native_create_is_reconciled_by_name_but_removed_by_the_observed_id(self):
        for command in ['exact','different']:
            with self.subTest(command=command):
                daemon=Daemon(rebind=False);frame,name,identifier=self.native_frame(daemon,response=False)
                if command=='different':daemon.containers[identifier]['Config']['Cmd']=['synthetic-other-command-137']
                with daemon.serving():
                    if command=='exact':
                        result=start.cleanup_native(frame);self.assertEqual(result['removedContainerId'],identifier)
                        self.assertEqual(daemon.effects,[('inspect',identifier),('rm',identifier)])
                    else:
                        with self.assertRaisesRegex(ValueError,'lacks matching observed command/image'):start.cleanup_native(frame)
                        self.assertIn(identifier,daemon.containers);self.assertEqual(daemon.effects,[('inspect',identifier)])


class StaticSweep(unittest.TestCase):
    """Every container/image effect argument is an ID-valued expression.

    The table above proves the paths it drives; this scan covers a new call
    site in any producer-qualification module before a harness reaches it.
    """
    ID_NAMES={'identifier','seed_identifier','returned','observed','actual'}
    # Admission reads by name or tag; each is followed by an ID comparison.
    LOOKUPS={('inspect','name'),('inspect','seed'),('inspect','listed[0]'),('image-inspect','tag'),
             ('image-inspect','codec.IMAGE'),('image-inspect','image.codec.IMAGE'),("image-inspect","local['localImageId']")}

    def reference(self,verb,elements):
        positional=[e for e in elements[1:] if not (isinstance(e,ast.Constant) and str(e.value).startswith('-'))]
        if verb in ('image-inspect','image-rm'):positional=positional[1:]
        if verb=='cp':
            node=positional[0]
            while isinstance(node,ast.BinOp):node=node.left
            return node
        if verb=='commit':return positional[0]
        if verb=='kill':return elements[-1]
        return positional[-1] if positional else None

    def identity(self,node):
        if isinstance(node,ast.Name) and node.id in self.ID_NAMES:return True
        return isinstance(node,ast.Subscript) and isinstance(node.slice,ast.Constant) and node.slice.value=='Id'

    # The one tag-addressed removal: it re-reads tag->ID immediately before the
    # effect and verifies the ID afterwards, because Docker deletes an image
    # removed by tag only when no other tag still holds it.
    TAG_REMOVAL=('remove_owned_tag','image-rm','tag')

    def allowed(self,verb,node,function=None):
        if self.identity(node):return True
        if (function,verb,ast.unparse(node))==self.TAG_REMOVAL:return True
        if isinstance(node,ast.BoolOp) and isinstance(node.op,ast.Or) and verb=='inspect':
            # `identifier or name`: the name only when a create returned no ID.
            return len(node.values)==2 and self.identity(node.values[0])
        return (verb,ast.unparse(node)) in self.LOOKUPS

    def scan(self,source,label):
        checked=0;refused=[];tree=ast.parse(source);enclosing={}
        for function in ast.walk(tree):
            if isinstance(function,(ast.FunctionDef,ast.AsyncFunctionDef)):
                # Breadth-first order visits outer functions first, so the innermost name wins.
                for inner in ast.walk(function):enclosing[id(inner)]=function.name
        for node in ast.walk(tree):
            if not isinstance(node,ast.List) or not node.elts:continue
            elements=node.elts;first=elements[0]
            if isinstance(first,ast.Constant) and first.value=='/usr/bin/docker':elements=elements[1:]
            if not elements or not isinstance(elements[0],ast.Constant):continue
            verb=elements[0].value
            if verb=='image' and len(elements)>1 and isinstance(elements[1],ast.Constant) and elements[1].value in ('rm','inspect'):
                verb='image-'+elements[1].value
            elif verb not in TARGETED:continue
            if verb=='start':elements=[e for e in elements if not (isinstance(e,ast.Constant) and e.value=='--attach')]
            reference=self.reference(verb,elements)
            if reference is None:refused.append(label+':'+str(node.lineno)+' '+verb+' <no reference>');continue
            checked+=1
            # A literal reference is a fixed name: never an admitted ID.
            if not self.allowed(verb,reference,enclosing.get(id(node))):refused.append(label+':'+str(node.lineno)+' '+verb+' '+ast.unparse(reference))
        return checked,refused

    def test_every_docker_container_and_image_effect_addresses_an_id(self):
        checked=0;refused=[]
        for path in sorted(MODULES.glob('*.py')):
            count,bad=self.scan(path.read_bytes(),path.name);checked+=count;refused+=bad
        self.assertGreaterEqual(checked,40);self.assertEqual(refused,[])

    def test_scan_refuses_name_tag_and_literal_references_and_admits_id_forms(self):
        for source,ok in [("docker(['rm',name])",False),("docker(['kill','--signal','TERM',name])",False),
                          ("docker(['cp','-a',seed+':'+x,y])",False),("docker(['commit','--pause=true',name,tag])",False),
                          ("docker(['inspect',name or identifier])",False),("docker(['rm','fixed-synthetic-name-137'])",False),
                          ("docker(['image','rm',tag])",False),("docker(['image','rm','synthetic:137'])",False),
                          ("def remove_owned_tag(tag):docker(['image','rm','synthetic:137'])",False),
                          ("def remove_owned_tag(tag):docker(['rm',tag])",False),
                          ("def cleanup_owned(tag):docker(['image','rm',tag])",False),
                          ("def remove_owned_tag(tag):docker(['image','rm',tag],timeout=30)",True),
                          ("subprocess.Popen(['/usr/bin/docker','start','--attach',name])",False),
                          ("docker(['rm',identifier])",True),("docker(['rm','--force',owner['Id']])",True),
                          ("docker(['cp','-a',seed_identifier+':'+x,y])",True),("docker(['inspect',identifier or name])",True),
                          ("docker(['image','rm',observed],timeout=30)",True),("docker(['image','inspect',tag])",True),
                          ("subprocess.Popen(['/usr/bin/docker','start','--attach',identifier])",True)]:
            with self.subTest(source=source):
                checked,refused=self.scan(source,'synthetic')
                self.assertEqual(checked,1);self.assertEqual(refused==[],ok,refused)


if __name__=='__main__':unittest.main(verbosity=2)
