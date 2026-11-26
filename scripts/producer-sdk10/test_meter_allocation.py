"""Actual inert inode/link fixtures plus bounded metadata-race doubles."""
import errno
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import capture
import common
import live_resource
import meter

class Allocation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def pair(self,hardlink=True):
        first=self.root/'first';second=self.root/'second';first.write_bytes(b'inert first-party data\n'*4)
        if hardlink:os.link(first,second)
        else:second.write_bytes(first.read_bytes())
        return first,second
    def sample(self,hook=None):return meter.sample_once(self.root,time.monotonic()+20,hook)
    def metadata(self,s,**changes):
        names=['st_dev','st_ino','st_mode','st_size','st_blocks','st_mtime_ns','st_ctime_ns','st_nlink']
        return SimpleNamespace(**{**{n:getattr(s,n) for n in names},**changes})
    def test_sample_memory_at_the_entry_bound_fits_half_the_sampler_container(self):
        # tracemalloc peak over two real trees gives the fixed and per-entry
        # cost; at MAX_ENTRIES the sum must stay within half the 256 MiB
        # sampler limit, leaving the other half for the interpreter and I/O.
        import json as json_module, tracemalloc
        budget=json_module.loads(common.bundle_bytes(Path(meter.__file__).parent/'profile.json'))['limits']['samplerMemory']//2;peaks={}
        for count in [500,6500]:
            tree=self.root/('tree-'+str(count));tree.mkdir()
            for i in range(count):(tree/(str(i)+'-7129')).write_bytes(b'')
            tracemalloc.start()
            try:result=meter.sample_once(str(tree),time.monotonic()+60)
            finally:peak=tracemalloc.get_traced_memory()[1];tracemalloc.stop()
            self.assertTrue(result['samplingComplete'],result);self.assertEqual(result['uniqueObservedInodes'],count);peaks[count]=peak
        per_entry=(peaks[6500]-peaks[500])/6000;predicted=peaks[500]+per_entry*(meter.MAX_ENTRIES-500)
        self.assertLess(predicted,budget,(per_entry,peaks))
    def test_inode_table_reports_matches_changes_and_its_bound(self):
        table=meter.InodeTable(3);stamp=(0o100644,7129,8,1,2,1)
        self.assertIsNone(table.observe(66,7129,stamp));self.assertTrue(table.observe(66,7129,stamp));self.assertFalse(table.observe(66,7129,stamp[:5]+(2,)))
        self.assertIsNone(table.observe(67,7129,stamp));self.assertIsNone(table.observe(66,0,stamp));self.assertEqual(table.count,3)
        with self.assertRaisesRegex(meter.Incomplete,'unique inode bound'):table.observe(66,7130,stamp)
        # A timestamp past 2262 does not fit 64 signed bits but is still exact.
        late=meter.InodeTable(2);far=(0o100644,1,8,2**64+7129,2,1)
        self.assertIsNone(late.observe(66,1,far));self.assertTrue(late.observe(66,1,far));self.assertFalse(late.observe(66,1,far[:3]+(2**64+7130,)+far[4:]))
    def test_actual_hardlinks_keep_two_paths_and_logical_bodies_but_one_allocated_inode(self):
        first,second=self.pair();s=first.stat();self.assertEqual((s.st_dev,s.st_ino),(second.stat().st_dev,second.stat().st_ino));result=self.sample()
        self.assertTrue(result['samplingComplete']);self.assertEqual(result['members'],2);self.assertEqual(result['regularLogicalBytes'],2*s.st_size)
        self.assertEqual(result['uniqueObservedInodes'],1);self.assertEqual(result['repeatedInodePaths'],1)
        self.assertEqual(result['allocatedBytesUniqueInodes'],s.st_blocks*512);self.assertEqual(result['allocatedBytesWithHardlinkDoubleCounting'],2*s.st_blocks*512)
    def test_distinct_equal_content_inodes_both_count_without_content_dedup(self):
        first,second=self.pair(False);a,b=first.stat(),second.stat();self.assertNotEqual((a.st_dev,a.st_ino),(b.st_dev,b.st_ino));self.assertEqual(first.read_bytes(),second.read_bytes());result=self.sample()
        self.assertTrue(result['samplingComplete']);self.assertEqual(result['uniqueObservedInodes'],2);self.assertEqual(result['repeatedInodePaths'],0);self.assertEqual(result['allocatedBytesUniqueInodes'],(a.st_blocks+b.st_blocks)*512)
    def test_physical_guard_accepts_alias_overcount_but_refuses_distinct_equal_body_allocation(self):
        first,second=self.pair();allocation=first.stat().st_blocks*512
        self.assertGreaterEqual(allocation,2*first.stat().st_size,'actual fixture must arm allocated-overcount guard')
        result=meter.sample(self.root);self.assertGreater(result['allocatedBytesWithHardlinkDoubleCounting'],allocation);live_resource.validate_meter(result,allocation)
        second.unlink();second.write_bytes(first.read_bytes());result=meter.sample(self.root)
        with self.assertRaisesRegex(common.Refusal,'sampled work byte bound'):live_resource.validate_meter(result,allocation)
    def test_same_inode_change_between_before_and_after_is_incomplete_not_a_zero_or_stale_pass(self):
        first=self.root/'first';first.write_bytes(b'inert');changed=[]
        def hook(stage,fd,name,s):
            if stage=='after-stat' and not changed:changed.append(True);first.write_bytes(b'inert metadata changed')
        result=self.sample(hook);self.assertFalse(result['samplingComplete']);self.assertEqual(result['incompleteCode'],'inode-metadata-changed-during-sample');self.assertEqual(result['members'],0)
        with self.assertRaises(common.Refusal):live_resource.validate_meter(result,10**9)
    def test_repeated_inode_changed_between_aliases_refuses_instead_of_reusing_old_allocation(self):
        first,second=self.pair();real=os.stat;seen=[];changed=[]
        def inspect(path,*args,**kwargs):
            if path in ['first','second']:
                if not seen:seen.append(path)
                elif path!=seen[0] and not changed:changed.append(True);first.write_bytes(b'changed between stable alias observations')
            return real(path,*args,**kwargs)
        with patch.object(meter.os,'stat',side_effect=inspect):result=self.sample()
        self.assertTrue(changed);self.assertFalse(result['samplingComplete']);self.assertEqual(result['incompleteCode'],'inode-observation-changed');self.assertEqual(result['members'],1)
    def test_replaced_path_identity_never_reuses_an_observed_inode_record(self):
        first=self.root/'first';first.write_bytes(b'inert');changed=[]
        def hook(stage,fd,name,s):
            if stage=='after-stat' and not changed:
                changed.append(True);first.unlink();first.write_bytes(b'new inode or changed inode epoch')
        result=self.sample(hook);self.assertFalse(result['samplingComplete']);self.assertIn(result['incompleteCode'],['entry-identity-replaced','inode-metadata-changed-during-sample'])
    def test_same_inode_number_on_distinct_devices_counts_two_physical_objects(self):
        first,second=self.pair(False);a,b=first.stat(),second.stat();real=os.stat
        def inspect(path,*args,**kwargs):
            result=real(path,*args,**kwargs)
            if path=='second':return self.metadata(result,st_dev=a.st_dev+1,st_ino=a.st_ino)
            return result
        with patch.object(meter.os,'stat',side_effect=inspect):result=self.sample()
        self.assertTrue(result['samplingComplete']);self.assertEqual(result['uniqueObservedInodes'],2);self.assertEqual(result['allocatedBytesUniqueInodes'],(a.st_blocks+b.st_blocks)*512)
    def test_mounted_descendant_device_is_traversed_without_a_same_device_filter(self):
        directory=self.root/'nested-mount';directory.mkdir();leaf=directory/'leaf';leaf.write_bytes(b'inert mounted descendant');ds=directory.stat();ls=leaf.stat();real_stat=os.stat;real_fstat=os.fstat
        def inspect(path,*args,**kwargs):
            info=real_stat(path,*args,**kwargs);fd=kwargs.get('dir_fd')
            if path=='nested-mount' or (fd is not None and real_fstat(fd).st_ino==ds.st_ino):return self.metadata(info,st_dev=ds.st_dev+1)
            return info
        def opened(fd):
            info=real_fstat(fd)
            return self.metadata(info,st_dev=ds.st_dev+1) if info.st_ino==ds.st_ino else info
        with patch.object(meter.os,'stat',side_effect=inspect),patch.object(meter.os,'fstat',side_effect=opened):result=self.sample()
        self.assertTrue(result['samplingComplete']);self.assertEqual(result['members'],2);self.assertEqual(result['regularLogicalBytes'],ls.st_size);self.assertEqual(result['uniqueObservedInodes'],2);self.assertEqual(result['allocatedBytesUniqueInodes'],(ds.st_blocks+ls.st_blocks)*512)
    def test_observation_failure_does_not_turn_missing_allocation_into_passing_zero(self):
        self.pair();real=os.stat
        def inspect(path,*args,**kwargs):
            if path in ['first','second']:raise PermissionError(errno.EACCES,'inert metadata refusal')
            return real(path,*args,**kwargs)
        with patch.object(meter.os,'stat',side_effect=inspect):result=self.sample()
        self.assertFalse(result['samplingComplete']);self.assertEqual(result['allocatedBytesUniqueInodes'],0)
        with self.assertRaises(common.Refusal):live_resource.validate_meter(result,10**9)
    def test_retry_starts_new_inode_map_and_never_accumulates_failed_counters(self):
        first,second=self.pair();phase=[0];paths=[0]
        def hook(stage,fd,name,s):
            if stage=='before-attempt':phase[0]=s;paths[0]=0
            elif stage=='after-stat':
                paths[0]+=1
                if phase[0]==1 and paths[0]==2:first.write_bytes(b'inert whole retry changes logical bytes')
        result=meter.sample(self.root,hook);self.assertTrue(result['samplingComplete']);self.assertEqual(len(result['attempts']),2);self.assertFalse(result['attempts'][0]['samplingComplete']);self.assertGreater(result['attempts'][0]['allocatedBytesUniqueInodes'],0)
        self.assertEqual(result['allocatedBytesUniqueInodes'],first.stat().st_blocks*512);self.assertEqual(result['uniqueObservedInodes'],1);self.assertFalse(result['failedAttemptCountersCredited']);self.assertEqual(result['regularLogicalBytes'],2*first.stat().st_size)
    def test_full_capture_keeps_both_paths_hardlink_metadata_and_original_logical_scope(self):
        first,second=self.pair();target=self.root.parent/(self.root.name+'-inert-capture.gz');self.addCleanup(lambda:target.unlink(missing_ok=True));size=first.stat().st_size
        result=capture.capture({'work':self.root},target,time.monotonic()+20,65536,1024**2)
        self.assertEqual(result['logicalPersistentBytes'],2*size);self.assertEqual(result['persistentRegularPaths'],2);self.assertEqual(result['uniqueDecodedBodyBytes'],size);self.assertEqual(result['provenDuplicateBodyBytesStoredByReference'],size);self.assertTrue(result['archiveRoundtripVerified'])
    def test_numeric_cohort_requires_new_metric_and_consistent_path_partition(self):
        self.pair();base=meter.sample(self.root)
        for key in ['allocatedBytesUniqueInodes','uniqueObservedInodes','repeatedInodePaths','allocationAccounting']:
            value=dict(base);value.pop(key)
            with self.subTest(key=key),self.assertRaises(common.Refusal):live_resource.validate_meter(value,10**9)
        for change in [{'allocatedBytesUniqueInodes':True},{'uniqueObservedInodes':True},{'repeatedInodePaths':10},{'allocatedBytesUniqueInodes':base['allocatedBytesWithHardlinkDoubleCounting']+1},{'allocationAccounting':'content-hash-dedup'}]:
            with self.subTest(change=change),self.assertRaises(common.Refusal):live_resource.validate_meter({**base,**change},10**9)

if __name__=='__main__':unittest.main(verbosity=2)
