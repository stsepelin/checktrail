"""Phase-specific clock/cache admission using synthetic API metadata only."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('native_service',ROOT/'scripts/producer-qualification/gcc-main05-service.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Service(unittest.TestCase):
 def fixture(self):
  return {'clock':{'capturedMonotonic':1000,'remainingSeconds':20000,'jobId':123},
          'cache':{'observedOccupiedBytes':6044189091,'capturedMonotonic':1000,'completeUniqueListingObserved':True,
                   'storagePolicyState':'previous-402-unavailable','checkpointCompressedByteLimit':768*1024**2}}

 def test_original_readonly_collector_is_reused_but_native_limits_and_source_clock_are_explicit(self):
  original=self.fixture();api=object();selected={'syntheticContext':True}
  with mock.patch.object(m.h.capacity,'capture_service',return_value=original) as capture,mock.patch.object(m.time,'monotonic',return_value=1000):
   native=m.capture_service(api,selected);capture.assert_called_once_with(api,selected)
  self.assertEqual(native['clock'],original['clock']);self.assertEqual(native['cache']['checkpointCompressedByteLimit'],4*m.GIB)
  self.assertEqual(native['cache']['requiredObservedHeadroomBytes'],4437573632);self.assertTrue(native['cache']['headroomAdmitted'])
  self.assertEqual(native['cache']['storagePolicyState'],'previous-402-unavailable')
  self.assertFalse(native['cache']['reservationGuaranteed']);self.assertFalse(native['cache']['laterPhaseCapacityQualified'])
  self.assertEqual(original['cache']['checkpointCompressedByteLimit'],768*1024**2)

 def test_measured_actual_archive_and_envelope_are_used_not_a_generic_four_gib_constant(self):
  value=self.fixture();value['cache']['observedOccupiedBytes']=m.FREE_CACHE_BYTES-(12345+67+m.SHARED_MARGIN_BYTES)
  with mock.patch.object(m.time,'monotonic',return_value=1000):
   result=m.admit_measured_save(value,12345,67)
   self.assertEqual(result['requiredUnreservedCacheBytes'],12345+67+m.SHARED_MARGIN_BYTES)
   self.assertEqual(result['actualArchiveBytesMeasured'],12345);self.assertFalse(result['sharedCacheReservationGuaranteed'])
   value['cache']['observedOccupiedBytes']+=1
   with self.assertRaisesRegex(ValueError,'headroom'):m.admit_measured_save(value,12345,67)

 def test_fresh_complete_clock_cache_and_real_source_restore_window_are_required(self):
  for kind in ['stale-cache','stale-clock','future-cache','short-source','incomplete']:
   value=self.fixture()
   if kind=='stale-cache':value['cache']['capturedMonotonic']=969
   if kind=='stale-clock':value['clock']['capturedMonotonic']=969
   if kind=='future-cache':value['cache']['capturedMonotonic']=1001
   if kind=='short-source':value['clock']['remainingSeconds']=3899
   if kind=='incomplete':value['cache']['completeUniqueListingObserved']=False
   with self.subTest(kind=kind),mock.patch.object(m.time,'monotonic',return_value=1000),self.assertRaises(ValueError):m.admit_measured_save(value,12345,67)
  for archive,envelope in [(0,1),(True,1),(m.CHECKPOINT_BYTES+1,1),(1,0),(1,True),(1,m.ENVELOPE_BYTES+1)]:
   with self.subTest(archive=archive,envelope=envelope),self.assertRaises(ValueError):m.admit_measured_save(self.fixture(),archive,envelope)

 def test_closed_nonempty_json_envelope_and_exact_member_set(self):
  files={name:b'{}' for name in ['receipt.json','CHECKPOINT-ROOT.json','PHASE-LEDGER.json']};result=m.measure_envelope(files)
  self.assertEqual(result['envelopeLogicalBytesMeasured'],6);self.assertFalse(result['serviceCacheWrapperBytesMeasured'])
  self.assertTrue(result['serviceStoredSizeMustBeVerifiedAfterSave'])
  for wrong in [{**files,'extra':b'{}'},{key:value for key,value in files.items() if key!='receipt.json'},
                {**files,'receipt.json':b''},{**files,'receipt.json':b'not-json'},{**files,'receipt.json':'{}'}]:
   with self.subTest(wrong=wrong),self.assertRaises(ValueError):m.measure_envelope(wrong)

 def test_missing_or_bool_occupancy_is_not_an_available_storage_observation(self):
  for occupied in [True,-1]:
   value=self.fixture();value['cache']['observedOccupiedBytes']=occupied
   with mock.patch.object(m.h.capacity,'capture_service',return_value=value),self.assertRaises(ValueError):m.capture_service(object(),{})


if __name__=='__main__':unittest.main(verbosity=2)
