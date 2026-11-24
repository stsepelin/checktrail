"""Synthetic Docker inspection controls; actual COPY/create/cp proof is separate."""
import copy,json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import common,driver

class VolumeControls(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='sdk10-volume-synthetic-');self.root=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def controller(self):
  c=object.__new__(driver.Controller);c.root=self.root;c.ctx={'run':123,'head':'a'*40,'nonce':'synthetic-test','attempt':1};c.state={'volume':'owned-work','tempVolume':'owned-temp','imageAlias':'inert:synthetic','imageID':'sha256:'+'7'*64};c.profile=json.loads((Path(driver.__file__).parent/'profile.json').read_bytes());return c
 def test_every_helper_native_readonly_and_capture_mode_disables_copy_for_all_three_volumes(self):
  c=self.controller()
  for readonly,helper,capture in [(False,False,False),(False,True,False),(True,True,False),(True,True,True)]:
   with self.subTest(readonly=readonly,helper=helper,capture=capture):
    args=c.container_args('synthetic',['/observer/first-party.py'],readonly,helper,capture);mounts=[args[i+1] for i,a in enumerate(args) if a=='--mount'];volumes=[x for x in mounts if x.startswith('type=volume,')];self.assertEqual(len(volumes),3);self.assertTrue(all('volume-nocopy' in x.split(',') for x in volumes));self.assertEqual({next(y[7:] for y in x.split(',') if y.startswith('target=')) for x in volumes},{'/work','/tmp','/work/tmp'})
 def test_actual_inspection_options_require_true_nocopy_exact_source_and_unique_targets(self):
  c=self.controller();name='synthetic';mounts=[{'Destination':'/work','Type':'volume','Name':'owned-work','RW':True},{'Destination':'/tmp','Type':'volume','Name':'owned-temp','RW':True},{'Destination':'/work/tmp','Type':'volume','Name':'owned-temp','RW':True},{'Destination':'/observer','Type':'bind','Source':str(driver.HERE),'RW':False},{'Destination':'/native-control','Type':'bind','Source':str(self.root/'protected'/name),'RW':True}];options=[{'Type':'volume','Source':s,'Target':t,'VolumeOptions':{'NoCopy':True}} for t,s in [('/work','owned-work'),('/tmp','owned-temp'),('/work/tmp','owned-temp')]]
  obj={'Mounts':mounts,'HostConfig':{'ReadonlyRootfs':True,'Privileged':False,'PidMode':'','CpusetCpus':'0-3','NetworkMode':'bridge','CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'Mounts':options}};self.assertTrue(c.validate_container(obj,name,[]))
  for index in range(3):
   bad=copy.deepcopy(obj);bad['HostConfig']['Mounts'][index]['VolumeOptions']['NoCopy']=False
   with self.subTest(index=index),self.assertRaises(common.Refusal):c.validate_container(bad,name,[])
  for change in [lambda x:x['HostConfig'].pop('Mounts'),lambda x:x['HostConfig']['Mounts'].pop(),lambda x:x['HostConfig']['Mounts'][2].update(Target='/tmp'),lambda x:x['HostConfig']['Mounts'][0].update(Source='unowned-work')]:
   bad=copy.deepcopy(obj);change(bad)
   with self.assertRaises(common.Refusal):c.validate_container(bad,name,[])

if __name__=='__main__':unittest.main(verbosity=2)
