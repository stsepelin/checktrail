"""Synthetic POSIX checkpoint and exact GCC phase-ledger controls only."""
import copy
import hashlib
import importlib.util
import json
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
def load(name):
    path=ROOT/'scripts/producer-qualification'/name
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
c=load('gcc-staged-checkpoint.py');p=load('gcc-staged-plan.py')

def binding(**overrides):
    return {'profile':c.PROFILE,'catalogSha256':c.CATALOG,'image':c.IMAGE,
            'platform':'linux/amd64','sourceVersion':'12.2.0-14+deb12u1',
            'configurationSha256':'a'*64,'packageInventorySha256':'b'*64,
            'sourceEpochSha256':'c'*64,'phase':'configure','sequence':0,
            'predecessorSha256':None,**overrides}

def configuration(jit=True,nvptx=True,gcn=True,hppa64=False,ada=True):
    v={name:'' for name in p.VARIABLES}
    v.update(build_type='build-native',distribution='Debian',distrelease='bookworm',
             DEB_HOST_ARCH='amd64',DEB_TARGET_ARCH='amd64',DEB_BUILD_OPTIONS='parallel=4',
             with_check='yes',with_cxx='yes',with_ada='yes' if ada else 'disabled',
             with_jit='yes' if jit else 'disabled',with_offload_nvptx='yes' if nvptx else 'disabled',
             with_offload_gcn='yes' if gcn else 'disabled',with_hppa64='yes' if hppa64 else 'disabled',
             flags_to_pass='CFLAGS CXXFLAGS',bootstrap_target='bootstrap',CONFARGS='--enable-languages=c,c++,fortran --enable-multilib',NJOBS='-j 4')
    phases=['native']+[phase for on,phase in [(jit,'jit'),(nvptx,'nvptx'),(gcn,'gcn'),(hppa64,'hppa64')] if on]
    builds=[p.STAMPS[name][0] for name in phases]+p.STAMPS['check']
    independent=builds+['stamps/05-build-html-stamp','stamps/05-build-doxygen-stamp']
    if ada:independent+=['stamps/05-build-gnatdoc-stamp']
    install=['stamps/07-install-stamp']
    install += [stamp for on,stamp in [(jit,'stamps/07-install-jit-stamp'),(nvptx,'stamps/06-install-nvptx-stamp'),(gcn,'stamps/06-install-gcn-stamp'),(hppa64,'stamps/07-install-hppa64-stamp')] if on]
    v.update(configure_dependencies='stamps/04-configure-stamp',build_dependencies=' '.join(builds),
             build_arch_dependencies=' '.join(builds),build_indep_dependencies=' '.join(independent),
             install_dependencies=' '.join(install),check_dependencies='stamps/06-check-stamp')
    return {'schemaVersion':1,'profile':p.PROFILE,'originalRulePins':p.RULES.copy(),'variables':v,'passedVariableValues':{'CFLAGS':'-O2','CXXFLAGS':'-O2'},'generatedParametersSha256':'e'*64}

def job(**changes):
    return {'runnerLabel':'ubuntu-26.04','architecture':'x86_64','cpus':4,'memoryBytes':16*1024**3,
            'sourceAndImagePinsVerified':True,'packageInventoryUnchanged':True,'restoredPhysicalTreeVerified':True,
            'restoredCheckpointSha256':None,'remainingSeconds':21000,'freeDiskBytes':100*1024**3,
            'activeTreeBytes':1024**3,'repositoryCacheLimitBytes':10000000000,'availableCacheBytes':8000000000,**changes}

def completed(ledger, config):
    selected,previous,_,index,_=p.validate_ledger(ledger,config);phase=selected['phases'][index]
    return {'phase':phase['phase'],'command':phase['command'],'attempt':len(ledger['attempts']),'sequence':index,
            'predecessorSha256':previous,'nativeSeconds':100,'outcome':'completed','exitCode':0,
            'terminalObserved':True,'quiescenceObserved':True,'checkpointSha256':str(index%10)*64,
            'requiredStamps':phase['requiredStamps'],'stampIdentities':phase['requiredStamps'],
            'originalTestReportEvidence':{'reports':2,'logicalBytes':1000,'inventorySha256':'d'*64,'allOriginalTestsPassRequired':False},
            'packageOutputKinds':['deb','changes','buildinfo']}

class Checkpoints(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='gcc-synthetic-');self.base=Path(self.tmp.name).resolve()
        self.tree=self.base/'native';self.tree.mkdir();(self.tree/'source').mkdir();(self.tree/'source/a.b').mkdir()
        (self.tree/'source/a.b/object').write_bytes(b'original synthetic object\n')
        (self.tree/'source/a.b/object').chmod(0o751)
        os.utime(self.tree/'source/a.b/object',ns=(1700000000123456789,1700000000123456789))
        (self.tree/'source/empty').write_bytes(b'')
        os.symlink('/usr/include/synthetic-sdk',self.tree/'source/external-pointer')
        os.link(self.tree/'source/a.b/object',self.tree/'source/hard-alias')
        self.destination=self.base/'checkpoint';self.restored=self.base/'restored'
    def tearDown(self):self.tmp.cleanup()
    def capture(self,**kw):
        self.receipt=c.capture(self.tree,self.destination,binding(),**kw);return self.receipt
    def restore(self,selected=None,**kw):
        return c.restore(self.destination,self.restored,selected or binding(),getattr(self,'receipt',{'archiveSha256':'0'*64})['archiveSha256'],**kw)

    def test_round_trip_preserves_bytes_modes_links_owners_and_nanosecond_mtimes(self):
        before=c.snapshot(self.tree,c.Budget());r=self.capture();s=self.restore()
        self.assertTrue(s['physicalTreeVerified']);self.assertFalse(r['phaseCompletionAssessed']);self.assertFalse(s['gateAComplete'])
        self.assertEqual(c.snapshot(self.restored,c.Budget()),before)
        self.assertEqual((self.restored/'source/a.b/object').stat().st_mtime_ns,1700000000123456789)
        self.assertEqual((self.restored/'source/a.b/object').stat().st_ino,(self.restored/'source/hard-alias').stat().st_ino)
        self.assertEqual(os.readlink(self.restored/'source/external-pointer'),'/usr/include/synthetic-sdk')
        self.assertFalse(Path('/usr/include/synthetic-sdk').exists())

    def test_empty_native_tree_is_not_a_source_or_build_acceptance(self):
        empty=self.base/'empty';empty.mkdir();r=c.capture(empty,self.destination,binding())
        self.assertFalse(r['originalCommandCompleted']);self.assertFalse(r['phaseCompletionAssessed']);self.assertFalse(r['gateAComplete'])

    def test_hardlink_base_is_lexically_canonical_across_traversal_order(self):
        (self.tree/'z').mkdir();(self.tree/'a').mkdir();(self.tree/'z/original').write_bytes(b'same inode')
        os.link(self.tree/'z/original',self.tree/'a/alias')
        self.capture();self.restore()
        self.assertEqual((self.restored/'z/original').stat().st_ino,(self.restored/'a/alias').stat().st_ino)

    def test_external_hardlink_alias_refuses_before_publication(self):
        os.link(self.tree/'source/empty',self.base/'outside')
        with self.assertRaisesRegex(ValueError,'External hardlink'):self.capture()
        self.assertFalse(self.destination.exists())

    def test_wrong_catalog_image_config_or_predecessor_cannot_restore(self):
        self.capture()
        for change in [{'image':'floating-image'},{'configurationSha256':'e'*64},{'sequence':1,'predecessorSha256':'f'*64},{'sourceVersion':'12.2.0-14+deb12u2'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):self.restore(binding(**change))
            self.assertFalse(self.restored.exists())

    def test_one_changed_compressed_byte_refuses_without_partial_published_tree(self):
        self.capture();path=self.destination/'tree.tar.gz';data=path.read_bytes();path.write_bytes(data[:4]+bytes([data[4]^1])+data[5:])
        with self.assertRaisesRegex(ValueError,'archive identity'):self.restore()
        self.assertFalse(self.restored.exists())

    def test_self_consistent_forged_cache_cannot_replace_independent_predecessor(self):
        self.capture();trusted=self.receipt['archiveSha256']
        alternate=self.base/'alternate';shutil.copytree(self.tree,alternate,symlinks=True)
        # copytree breaks the original hardlinks; that is a valid different tree.
        (alternate/'source/empty').write_bytes(b'changed compiler object')
        forged=self.base/'forged';c.capture(alternate,forged,binding())
        for name in ['receipt.json','tree.tar.gz']:shutil.copyfile(forged/name,self.destination/name)
        with self.assertRaisesRegex(ValueError,'independently pinned predecessor'):self.restore()
        self.assertFalse(self.restored.exists());self.assertEqual(self.receipt['archiveSha256'],trusted)

    def test_missing_or_stale_checkpoint_is_unavailable_not_success(self):
        with self.assertRaises((ValueError,FileNotFoundError)):self.restore()
        self.capture();(self.destination/'receipt.json').unlink()
        with self.assertRaisesRegex(ValueError,'receipt'):self.restore()
        self.assertFalse(self.restored.exists())

    def test_receipt_symlink_and_source_parent_alias_are_refused(self):
        self.capture();receipt=self.destination/'receipt.json';actual=self.base/'real-receipt';receipt.rename(actual);receipt.symlink_to(actual)
        with self.assertRaisesRegex(ValueError,'receipt'):self.restore()
        alias=self.base/'alias';alias.symlink_to(self.tree,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'Canonical physical'):c.capture(alias,self.base/'other',binding())

    def test_source_output_overlap_and_existing_restore_destination_are_refused(self):
        with self.assertRaisesRegex(ValueError,'overlap'):c.capture(self.tree,self.tree/'checkpoint',binding())
        self.capture();self.restored.mkdir();(self.restored/'keep').write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError,'already exists'):self.restore()
        self.assertEqual((self.restored/'keep').read_bytes(),b'keep')

    def test_atomic_publication_cannot_overwrite_a_late_empty_destination(self):
        source=self.base/'stage';source.mkdir();(source/'own').write_bytes(b'own')
        foreign=self.base/'published';foreign.mkdir();inode=foreign.stat().st_ino
        with self.assertRaises(OSError):c.rename_no_replace(source,foreign)
        self.assertEqual(foreign.stat().st_ino,inode);self.assertEqual((source/'own').read_bytes(),b'own')

    def test_late_publication_is_withheld_after_whole_operation_deadline(self):
        source=self.base/'stage';source.mkdir();(source/'own').write_bytes(b'own')
        foreign=self.base/'published';budget=c.Budget();calls=0
        def tick():
            nonlocal calls
            calls+=1
            if calls==2:raise ValueError('Checkpoint deadline')
        with mock.patch.object(budget,'tick',tick),self.assertRaisesRegex(ValueError,'deadline'):c.publish(source,foreign,budget)
        self.assertFalse(foreign.exists());self.assertEqual((source/'own').read_bytes(),b'own')

    def test_compressed_and_entry_limits_fail_before_checkpoint_publication(self):
        for limits in [{'archiveBytes':20},{'entries':2},{'treeBytes':1},{'memberBytes':2},{'manifestBytes':10}]:
            with self.subTest(limits=limits),self.assertRaises(ValueError):self.capture(limits=limits)
            self.assertFalse(self.destination.exists())

    def test_expansion_limit_refuses_even_with_authentic_archive_digest(self):
        self.capture()
        with self.assertRaisesRegex(ValueError,'Expanded checkpoint limit'):self.restore(limits={'expandedBytes':1024})
        self.assertFalse(self.restored.exists())

    def test_changed_source_during_capture_cannot_publish_a_checkpoint(self):
        original=c.tarfile.TarFile.addfile;mutated=[]
        def changing(archive,item,fileobj=None):
            result=original(archive,item,fileobj)
            if item.name=='tree/source/empty':
                (self.tree/'source/empty').write_bytes(b'mutated');mutated.append(True)
            return result
        with mock.patch.object(c.tarfile.TarFile,'addfile',changing),self.assertRaisesRegex(ValueError,'Source changed'):self.capture()
        self.assertEqual(mutated,[True]);self.assertEqual((self.tree/'source/empty').read_bytes(),b'mutated')
        self.assertFalse(self.destination.exists())

    def test_compressed_writer_stops_before_the_first_over_budget_write(self):
        sink=io.BytesIO();writer=c.CappedWriter(sink,c.Budget({'archiveBytes':20}))
        self.assertEqual(writer.write(b'a'*8),8);self.assertEqual(writer.write(b'b'*12),12)
        with self.assertRaisesRegex(ValueError,'Compressed checkpoint limit'):writer.write(b'c')
        self.assertEqual(sink.getvalue(),b'a'*8+b'b'*12);self.assertEqual(writer.bytes,20)

    def test_partial_validation_failure_preserves_old_checkpoint_and_no_new_target(self):
        self.capture();old=(self.destination/'tree.tar.gz').read_bytes()
        with mock.patch.object(c,'set_metadata',side_effect=OSError('synthetic metadata failure')),self.assertRaisesRegex(OSError,'metadata failure'):
            self.restore()
        self.assertFalse(self.restored.exists());self.assertEqual((self.destination/'tree.tar.gz').read_bytes(),old)
        self.assertFalse(list(self.base.glob('.gcc-restore-*')))

    def test_manifest_rejects_traversal_duplicate_hardlink_and_parent_counterfactuals(self):
        tree=c.snapshot(self.tree,c.Budget());base={'schemaVersion':1,'binding':binding(),'tree':tree}
        bads=[]
        for path in ['../escape','/absolute','source//empty','source/./empty','source/../../escape']:
            value=copy.deepcopy(base);value['tree']['entries'][1]['path']=path;bads.append(value)
        value=copy.deepcopy(base);value['tree']['entries'].append(value['tree']['entries'][1]);bads.append(value)
        value=copy.deepcopy(base);next(x for x in value['tree']['entries'] if x['kind']=='hardlink')['target']='../escape';bads.append(value)
        for value in bads:
            with self.subTest(value=value['tree']['entries'][1]['path']),self.assertRaises(ValueError):c.validate_manifest(value,binding(),c.Budget())

    def test_restored_disk_corruption_is_not_accepted_from_stream_hash_alone(self):
        self.capture();original=c.set_metadata
        def corrupt(path,row):
            original(path,row)
            if row['kind']=='file' and path.name=='object':
                body=path.read_bytes();path.write_bytes(bytes([body[0]^1])+body[1:]);os.utime(path,ns=(row['mtimeNs'],row['mtimeNs']))
        with mock.patch.object(c,'set_metadata',corrupt),self.assertRaisesRegex(ValueError,'Physical restored checkpoint differs'):self.restore()
        self.assertFalse(self.restored.exists())

    def test_oversized_pax_and_sparse_headers_refuse_before_allocation(self):
        header=c.LimitedTarInfo('pax');header.size=1048577
        with self.assertRaisesRegex(ValueError,'Oversized PAX'):header._proc_pax(None)
        with self.assertRaisesRegex(ValueError,'sparse'):header._proc_sparse(None)
        with self.assertRaisesRegex(ValueError,'GNU long'):header._proc_gnulong(None)

class Phases(unittest.TestCase):
    def test_original_two_argument_parallel_expansion_is_preserved(self):
        config=configuration();self.assertEqual(config['variables']['NJOBS'],'-j 4')
        self.assertTrue(p.plan(config)['phases'])
        for narrowed in ['-j1','-j 1','-j4','-j 4 --shuffle=random']:
            changed=copy.deepcopy(config);changed['variables']['NJOBS']=narrowed
            with self.subTest(value=narrowed),self.assertRaisesRegex(ValueError,'parallel expansion'):p.plan(changed)

    def test_proxy_preserves_original_outer_locale_makelevel_and_parallel_forwarding(self):
        proxy=ROOT/'scripts/producer-qualification/gcc-staged-rules2.sh'
        for args in [[],['unexpected-target'],['stamps/05-build-stamp','unexpected-extra']]:
            result=subprocess.run(['/bin/sh',str(proxy),*args],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
        subprocess.run(['/bin/sh','-n',str(proxy)],check=True,capture_output=True)
        with tempfile.TemporaryDirectory(prefix='gcc-forward-synthetic-') as name:
            source=Path(name).resolve();(source/'debian').mkdir()
            (source/'debian/rules').write_text('unexport LANG LC_ALL LC_CTYPE LC_COLLATE LC_TIME LC_NUMERIC LC_MESSAGES\nNJOBS := -j 4\n.PHONY: baseline\nbaseline:\n\t$(MAKE) $(NJOBS) -f debian/rules2 stamps/05-build-stamp\n')
            (source/'debian/rules2').write_text("stamps/05-build-stamp:\n\t@printf '%s\\n' '$(MAKELEVEL)' '$(MAKEFLAGS)' > synthetic-result\n\t@env > synthetic-environment\n")
            environment={key:value for key,value in os.environ.items() if key not in {'MAKEFLAGS','MFLAGS','MAKELEVEL'}}
            for key in ['LANG','LC_ALL','LC_CTYPE','LC_COLLATE','LC_TIME','LC_NUMERIC','LC_MESSAGES']:environment[key]='C'
            baseline=subprocess.run(['/usr/bin/make','--no-print-directory','-f','debian/rules','baseline'],cwd=source,env=environment,capture_output=True,text=True)
            self.assertEqual(baseline.returncode,0,baseline.stderr)
            expected_level,expected_flags=(source/'synthetic-result').read_text().splitlines()
            result=subprocess.run(['/bin/sh',str(proxy),'stamps/05-build-stamp'],cwd=source,env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            level,flags=(source/'synthetic-result').read_text().splitlines()
            self.assertEqual(level,'1');self.assertEqual(level,expected_level)
            normal=lambda value:[word.partition('=')[0] if word.startswith('--jobserver-') else word for word in value.partition(' -- ')[0].split()]
            self.assertEqual(normal(flags),normal(expected_flags));self.assertTrue(any(word in ['-j','-j4'] for word in normal(flags)))
            envkeys={line.partition('=')[0] for line in (source/'synthetic-environment').read_text().splitlines()}
            self.assertFalse(envkeys.intersection({'LANG','LC_ALL','LC_CTYPE','LC_COLLATE','LC_TIME','LC_NUMERIC','LC_MESSAGES'}))
        self.assertIn('-f debian/rules -f \"$controller_fragment\" \"CHECKTRAIL_GCC_FRAGMENT=$controller_fragment\" checktrail-forward-phase',proxy.read_text())
        self.assertIn('-f debian/rules -f \"$controller_fragment\" \"CHECKTRAIL_GCC_FRAGMENT=$controller_fragment\" checktrail-forward-configuration',proxy.read_text())

    def test_changed_expanded_passed_flags_cannot_reuse_an_existing_ledger(self):
        config=configuration();ledger=p.new_ledger(config)
        changed=copy.deepcopy(config);changed['passedVariableValues']['CXXFLAGS']='-O0 changed'
        with self.assertRaisesRegex(ValueError,'ledger/configuration'):p.validate_ledger(ledger,changed)
        changed=copy.deepcopy(config);del changed['passedVariableValues']['CFLAGS']
        with self.assertRaisesRegex(ValueError,'passed-variable'):p.plan(changed)

    def test_generated_parameters_are_bound_separately_from_static_original_rules(self):
        config=configuration();ledger=p.new_ledger(config)
        self.assertNotIn('debian/rules.parameters',p.RULES)
        changed=copy.deepcopy(config);changed['generatedParametersSha256']='f'*64
        self.assertEqual(len(p.plan(changed)['phases']),len(p.plan(config)['phases']))
        with self.assertRaisesRegex(ValueError,'ledger/configuration'):p.validate_ledger(ledger,changed)

    def test_rendered_configuration_reader_binds_every_flag_and_generated_parameters(self):
        with tempfile.TemporaryDirectory(prefix='gcc-config-synthetic-') as name:
            base=Path(name).resolve();source=base/'source';source.mkdir();directory=base/'variables';directory.mkdir();pins={}
            for relative in p.RULES:
                path=source/relative;path.parent.mkdir(parents=True,exist_ok=True);body=('Synthetic inert rule '+relative).encode();path.write_bytes(body);pins[relative]=c.sha(body)
            generated=b'Synthetic original-generated parameters\n';(source/'debian/rules.parameters').write_bytes(generated)
            config=configuration()
            for key,value in config['variables'].items():(directory/key).write_text(value+'\n')
            for key,value in config['passedVariableValues'].items():(directory/('flag-'+key)).write_text(value+'\n')
            value=p.read_configuration(directory,source,expected_rules=pins)
            self.assertEqual(value['passedVariableValues'],config['passedVariableValues'])
            self.assertEqual(value['generatedParametersSha256'],c.sha(generated))
            with self.assertRaisesRegex(ValueError,'Original Debian rules changed'):p.plan(value)
            (directory/'flag-CFLAGS').unlink()
            with self.assertRaises((ValueError,FileNotFoundError)):p.read_configuration(directory,source,expected_rules=pins)

    def test_full_default_graph_includes_every_selected_branch_and_doc_phase(self):
        config=configuration(hppa64=True);planned=p.plan(config)
        self.assertEqual([x['phase'] for x in planned['phases']],['configure','native','jit','nvptx','gcn','hppa64','check','default-build','packages'])
        self.assertEqual(planned['phases'][-1]['command'],p.DPKG+['-nc'])
        self.assertEqual(planned['phases'][-2]['command'],p.DPKG+['--rules-target=build'])
        self.assertIn('--rules-file=/controller/gcc-staged-rules2.sh',planned['phases'][1]['command'])
        self.assertFalse(planned['configurationNativeOriginAssessed']);self.assertFalse(planned['gateAComplete'])

    def test_valid_branch_near_misses_keep_actual_optional_selection(self):
        for jit in [False,True]:
            for nvptx in [False,True]:
                for gcn in [False,True]:
                    for hppa64 in [False,True]:
                        config=configuration(jit=jit,nvptx=nvptx,gcn=gcn,hppa64=hppa64)
                        names=[x['phase'] for x in p.plan(config)['phases']]
                        for flag,name in [(jit,'jit'),(nvptx,'nvptx'),(gcn,'gcn'),(hppa64,'hppa64')]:self.assertEqual(name in names,flag)

    def test_pinned_original_profiledbootstrap_lean_is_retained_not_substituted(self):
        config=configuration();config['variables']['bootstrap_target']='profiledbootstrap-lean'
        planned=p.plan(config);self.assertEqual(planned['configurationSha256'],p.sha(p.canonical(config)))
        self.assertNotIn('bootstrap-lean',json.dumps(planned['phases']))

    def test_removed_check_docs_jit_or_offload_dependencies_refuse(self):
        for key,term in [('build_dependencies','stamps/06-check-stamp'),('build_arch_dependencies','stamps/05-build-jit-stamp'),('build_indep_dependencies','stamps/05-build-doxygen-stamp'),('install_dependencies','stamps/06-install-gcn-stamp')]:
            config=configuration();config['variables'][key]=config['variables'][key].replace(term,'')
            with self.subTest(key=key),self.assertRaises(ValueError):p.plan(config)

    def test_disabled_tests_narrowed_build_profiles_and_changed_rules_refuse(self):
        for key,value in [('with_check','no'),('DEB_BUILD_OPTIONS','parallel=4 nocheck'),('DEB_BUILD_OPTIONS','parallel=4 nostrap'),('DEB_BUILD_PROFILES','stage1'),('DEB_STAGE','stage1'),('single_package','yes'),('DEB_TARGET_ARCH','arm64')]:
            config=configuration();config['variables'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):p.plan(config)
        config=configuration();config['originalRulePins']['debian/rules2']='f'*64
        with self.assertRaisesRegex(ValueError,'rules changed'):p.plan(config)

    def test_failed_and_timeout_attempts_consume_budget_without_advancing_phase(self):
        config=configuration();ledger=p.new_ledger(config)
        for index,outcome in enumerate(['failed','timeout-incomplete']):
            row=completed(ledger,config);row.update(outcome=outcome,exitCode=2 if index==0 else None,terminalObserved=index==0,checkpointSha256=None,nativeSeconds=5000)
            ledger=p.append_attempt(ledger,config,row)
        next=p.next_phase(ledger,config,job())
        self.assertEqual(next['phase'],'configure');self.assertEqual(next['attempt'],2)
        self.assertEqual(p.completion(ledger,config)['allAttemptNativeSeconds'],10000)
        self.assertIsNone(next['restoreCheckpointSha256'])

    def test_timeouts_never_invent_exit137_or_publish_partial_checkpoint(self):
        config=configuration();ledger=p.new_ledger(config);row=completed(ledger,config)
        row.update(outcome='timeout-incomplete',terminalObserved=False,exitCode=137,checkpointSha256=None)
        with self.assertRaisesRegex(ValueError,'invented'):p.append_attempt(ledger,config,row)
        row['exitCode']=None;row['checkpointSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'cannot become'):p.append_attempt(ledger,config,row)

    def test_skipped_reordered_duplicate_and_wrong_predecessor_phases_refuse(self):
        config=configuration();ledger=p.new_ledger(config);row=completed(ledger,config)
        for key,value in [('phase','native'),('sequence',1),('attempt',2),('predecessorSha256','f'*64),('command',['touch','stamps/04-configure-stamp'])]:
            bad={**row,key:value}
            with self.subTest(key=key),self.assertRaises(ValueError):p.append_attempt(ledger,config,bad)
        ledger=p.append_attempt(ledger,config,row)
        with self.assertRaises(ValueError):p.append_attempt(ledger,config,row)

    def test_next_phase_requires_exact_successor_restore_and_unpaid_capacity(self):
        config=configuration();ledger=p.new_ledger(config);row=completed(ledger,config);ledger=p.append_attempt(ledger,config,row)
        admitted=p.next_phase(ledger,config,job(restoredCheckpointSha256=row['checkpointSha256']))
        self.assertEqual(admitted['phase'],'native');self.assertEqual(admitted['maximumNativeSeconds'],14400)
        for changes in [{'restoredCheckpointSha256':'f'*64},{'availableCacheBytes':7999999999},{'repositoryCacheLimitBytes':20000000000},{'freeDiskBytes':14*1024**3},{'remainingSeconds':3299},{'sourceAndImagePinsVerified':False},{'packageInventoryUnchanged':False}]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):p.next_phase(ledger,config,job(restoredCheckpointSha256=row['checkpointSha256'],**{k:v for k,v in changes.items() if k!='restoredCheckpointSha256'}) if 'restoredCheckpointSha256' not in changes else job(**changes))

    def test_completed_phase_cannot_omit_stamps_quiescence_or_native_terminal(self):
        config=configuration();ledger=p.new_ledger(config);row=completed(ledger,config)
        for key,value in [('stampIdentities',[]),('quiescenceObserved',False),('terminalObserved',False),('checkpointSha256',None)]:
            with self.subTest(key=key),self.assertRaises(ValueError):p.append_attempt(ledger,config,{**row,key:value})

    def test_entire_plan_reconciles_without_claiming_native_authority_or_upstream_pass(self):
        config=configuration();ledger=p.new_ledger(config)
        while len(ledger['attempts'])<len(p.plan(config)['phases']):ledger=p.append_attempt(ledger,config,completed(ledger,config))
        result=p.completion(ledger,config);self.assertTrue(result['allSelectedPhasesReported'])
        for key in ['nativeEvidenceOriginAssessed','uninterruptedOriginalCommandCompleted','fullCompilerSdkBootstrapClosureVerified','gateAComplete']:self.assertFalse(result[key])
        with self.assertRaisesRegex(ValueError,'No continuation'):p.next_phase(ledger,config,job())

    def test_jit_and_check_require_original_reports_without_requiring_all_tests_green(self):
        config=configuration();ledger=p.new_ledger(config)
        for _ in range(2):ledger=p.append_attempt(ledger,config,completed(ledger,config))
        row=completed(ledger,config);self.assertEqual(row['phase'],'jit')
        row['originalTestReportEvidence']['reports']=0
        with self.assertRaisesRegex(ValueError,'test evidence'):p.append_attempt(ledger,config,row)
        row=completed(ledger,config);row['originalTestReportEvidence']['allOriginalTestsPassRequired']=True
        with self.assertRaisesRegex(ValueError,'accounting changed'):p.append_attempt(ledger,config,row)

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]);r=unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({'tests':r.testsRun,'failures':len(r.failures),'errors':len(r.errors),'skips':len(r.skipped),'projectOrCompilerExecuted':False}))
    raise SystemExit(0 if r.wasSuccessful() and not r.skipped else 1)
