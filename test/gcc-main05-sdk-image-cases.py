import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('main_sdk_image',ROOT/'scripts/producer-qualification/gcc-main05-sdk-image.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NAME='checktrail-gcc-sdk-'+'1'*32
CONTAINER='2'*64
IMAGE='sha256:'+'3'*64
TAG='checktrail-gcc-main05-sdk:'+'1'*32


def fixture():
    owner={'Id':CONTAINER,'Config':{'Labels':{'io.checktrail.gcc-staged-owner':NAME},'Image':m.codec.IMAGE,
        'Entrypoint':['/usr/bin/env'],'Cmd':['-i',*[k+'='+v for k,v in m.sdk.stage.FIXED_ENVIRONMENT.items()],*m.sdk.BODY]},
        'State':{'Running':False,'Status':'exited','Pid':0,'ExitCode':0,'OOMKilled':False},'SizeRw':1000}
    proof={'state':'sdk-material-reconstructed-and-physically-verified','packageInventoryMatches':True,
        'sdkMaterialReconstructionObserved':True,'generatedStatePhysicallyValidated':True,'allTimestampWritesPrecededFinalValidators':True,
        'softwareAndGeneratedStateContract':'gcc12-original-sdk-generated-state-v1','historicalCacheBodyEqualityClaimed':False,'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,'wholeRootIdentityClaimed':False}
    base={'Id':'sha256:'+'4'*64,'Os':'linux','Architecture':'amd64','RootFS':{'Type':'layers','Layers':['sha256:'+'5'*64]}}
    image={'Id':IMAGE,'Os':'linux','Architecture':'amd64','RepoTags':[TAG],
        'RootFS':{'Type':'layers','Layers':base['RootFS']['Layers']+['sha256:'+'6'*64]},'Config':{'User':'0:0','WorkingDir':'/work','Labels':{'io.checktrail.gcc-staged-owner':NAME}}}
    return owner,proof,base,image


class LocalSdkImage(unittest.TestCase):
    def test_exact_stopped_materializer_to_owned_local_image(self):
        owner,proof,base,image=fixture();calls=[]
        def docker(args,**kw):
            calls.append((args,kw))
            if args==['inspect','--size',CONTAINER]:return json.dumps([owner]).encode()
            if args==['image','ls','--no-trunc','--quiet',TAG]:return b''
            if args==['commit','--pause=true',CONTAINER,TAG]:return (IMAGE+'\n').encode()
            if args==['image','inspect',IMAGE]:return json.dumps([image]).encode()
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as d:
            output=Path(d).resolve();record=m.commit_prepared(NAME,CONTAINER,base,proof,output,docker)
            self.assertEqual(record['localImageId'],IMAGE);self.assertEqual(record['originalRootfsLayers'],base['RootFS']['Layers'])
            self.assertFalse(record['registryPublicationPerformed']);self.assertFalse(record['native05Executed'])
            self.assertTrue(record['ephemeralLocalImageCleanupRequired'])
            self.assertEqual(len(calls),4);self.assertEqual(calls[2],(['commit','--pause=true',CONTAINER,TAG],{'timeout':300}))
            self.assertEqual(json.loads((output/'SDK-STOPPED-FOR-SNAPSHOT.json').read_bytes()),owner)

    def test_each_process_ownership_exit_and_measured_layer_axis(self):
        for section,key,value in [('State','Running',True),('State','Pid',1),('State','ExitCode',1),
                                  ('State','OOMKilled',True),('State','Status','created'),('Config','Image','other')]:
            owner,proof,_,_=fixture();owner[section][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):m.validate_stopped(owner,NAME,CONTAINER,proof)
        for size in [None,True,0,8*m.h.GIB+1]:
            owner,proof,_,_=fixture();owner['SizeRw']=size
            with self.subTest(size=size),self.assertRaisesRegex(ValueError,'storage'):m.validate_stopped(owner,NAME,CONTAINER,proof)
        owner,proof,_,_=fixture();owner['Config']['Labels']['io.checktrail.gcc-staged-owner']='other'
        with self.assertRaisesRegex(ValueError,'Owned'):m.validate_stopped(owner,NAME,CONTAINER,proof)

    def test_every_material_proof_axis(self):
        for key in fixture()[1]:
            owner,proof,_,_=fixture();proof[key]='wrong' if key=='state' else not proof[key]
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'software reconstruction'):m.validate_stopped(owner,NAME,CONTAINER,proof)
        owner,proof,_,_=fixture();owner['Config']['Cmd'][-1]='main05'
        with self.assertRaisesRegex(ValueError,'another source'):m.validate_stopped(owner,NAME,CONTAINER,proof)

    def test_original_rootfs_cannot_be_swapped_dropped_or_aliased(self):
        for change in ['replace','drop','extra','id','arch','tag','user','workdir']:
            _,_,base,image=fixture()
            if change=='replace':image['RootFS']['Layers'][0]='sha256:'+'7'*64
            if change=='drop':image['RootFS']['Layers']=image['RootFS']['Layers'][1:]
            if change=='extra':image['RootFS']['Layers']+=['sha256:'+'8'*64]
            if change=='id':image['Id']='sha256:'+'7'*64
            if change=='arch':image['Architecture']='arm64'
            if change=='tag':image['RepoTags']=['unowned']
            if change=='user':image['Config']['User']='1001'
            if change=='workdir':image['Config']['WorkingDir']='/build/source'
            with self.subTest(change=change),self.assertRaises(ValueError):m.validate_local_image(image,IMAGE,TAG,base)

    def test_existing_tag_never_overwritten(self):
        owner,proof,base,_=fixture();calls=[]
        def docker(args,**kw):
            calls.append(args)
            return json.dumps([owner]).encode() if args[0]=='inspect' else (IMAGE+'\n').encode()
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'cannot be overwritten'):m.commit_prepared(NAME,CONTAINER,base,proof,Path(d).resolve(),docker)
        self.assertEqual(len(calls),2);self.assertFalse(any(row[0]=='commit' for row in calls))

    def test_bad_post_commit_identity_is_retained_but_not_promoted(self):
        owner,proof,base,image=fixture();image['Architecture']='arm64'
        def docker(args,**kw):
            if args[0]=='inspect':return json.dumps([owner]).encode()
            if args[1]=='ls':return b''
            if args[0]=='commit':return (IMAGE+'\n').encode()
            return json.dumps([image]).encode()
        with tempfile.TemporaryDirectory() as d:
            output=Path(d).resolve()
            with self.assertRaisesRegex(ValueError,'identity differs'):m.commit_prepared(NAME,CONTAINER,base,proof,output,docker)
            self.assertTrue((output/'SDK-LOCAL-SNAPSHOT-COMMAND.json').is_file())
            self.assertTrue((output/'SDK-LOCAL-IMAGE-OBSERVATION.json').is_file())
            self.assertFalse((output/'SDK-LOCAL-IMAGE.json').exists())


FOREIGN_TAG='synthetic-foreign/holder:137'
FOREIGN_IMAGE='sha256:'+'f1'*32


class ImageTable:
    """Synthetic image store with Docker's removal semantics.

    `image rm <tag>` only untags while another tag holds the image and deletes
    it with its last tag; `image rm <id>` deletes an image that has at most one
    tag (taking that tag with it) and refuses one with several. `races` maps a
    call (as a tuple) to a mutation applied by another client right before it.
    """
    def __init__(self):
        self.images={};self.tags={};self.calls=[];self.races={}

    def bind(self,tag,image):self.tags[tag]=image

    def view(self,image):
        return {**self.images[image],'RepoTags':sorted(tag for tag,bound in self.tags.items() if bound==image)}

    def resolve(self,reference):
        if reference in self.images:return reference
        if reference in self.tags:return self.tags[reference]
        raise ValueError('Fixed Docker operation failed: No such image: '+reference)

    def __call__(self,args,**kw):
        self.calls.append(list(args))
        race=self.races.pop(tuple(args),None)
        if race:race(self)
        if args[:2]==['image','ls'] and '--all' in args:return ''.join(image+'\n' for image in self.images).encode()
        if args[:2]==['image','ls']:return (self.tags[args[-1]]+'\n').encode() if args[-1] in self.tags else b''
        if args[:2]==['image','inspect']:return json.dumps([self.view(self.resolve(args[2]))]).encode()
        if args[0]=='tag':self.resolve(args[1]);self.bind(args[2],self.resolve(args[1]));return b''
        if args[:2]==['image','rm']:
            reference=args[2];image=self.resolve(reference);held=self.view(image)['RepoTags']
            if reference==image:
                if len(held)>1:raise ValueError('Fixed Docker operation failed: image is referenced in multiple repositories')
                for tag in held:del self.tags[tag]
            else:
                del self.tags[reference]
                if len(held)>1:return ('Untagged: '+reference+'\n').encode()
            del self.images[image];return ('Deleted: '+image+'\n').encode()
        raise AssertionError(args)


class FailedSnapshotCleanup(unittest.TestCase):
    def attempt(self,output,mode):
        owner,proof,base,image=fixture();table=ImageTable()
        if mode=='validation-failure':image['Architecture']='arm64'
        def docker(args,**kw):
            if args==['inspect','--size',CONTAINER]:return json.dumps([owner]).encode()
            if args==['commit','--pause=true',CONTAINER,TAG]:
                self.assertTrue((output/'SDK-LOCAL-SNAPSHOT-REQUEST.json').is_file())
                table.images[IMAGE]={key:value for key,value in image.items() if key!='RepoTags'};table.bind(TAG,IMAGE)
                if mode.startswith('ambiguous'):raise ValueError('Synthetic commit response lost after actual image creation')
                return (IMAGE+'\n').encode()
            return table(args,**kw)
        with self.assertRaises(ValueError):m.commit_prepared(NAME,CONTAINER,base,proof,output,docker)
        return image,table,docker

    def removals(self,table):return [call for call in table.calls if call[:2]==['image','rm'] or call[0]=='tag']

    def test_created_image_cleanup_recovers_from_command_when_no_success_return_exists(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();image,table,docker=self.attempt(output,'validation-failure')
            self.assertIn(IMAGE,table.images);self.assertTrue((output/'SDK-LOCAL-SNAPSHOT-COMMAND.json').exists())
            self.assertFalse((output/'SDK-LOCAL-IMAGE.json').exists())
            result=m.cleanup_owned(output,docker);self.assertTrue(result['ownedImageCleanupComplete']);self.assertNotIn(IMAGE,table.images)
            self.assertEqual(self.removals(table),[['image','rm',TAG]])
            self.assertFalse(result['unrelatedTagsRemoved']);self.assertFalse(result['imagePrunePerformed'])

    def test_ambiguous_local_commit_recovers_only_from_exact_request_tag_and_independent_owner(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();image,table,docker=self.attempt(output,'ambiguous-created')
            self.assertIn(IMAGE,table.images);self.assertFalse((output/'SDK-LOCAL-SNAPSHOT-COMMAND.json').exists())
            result=m.cleanup_owned(output,docker);self.assertTrue(result['ownedImageCleanupComplete']);self.assertNotIn(IMAGE,table.images)
            self.assertIsNone(result['returnedLocalImageId']);self.assertEqual(result['observedLocalImageId'],IMAGE)

    def test_rebound_or_unproven_owner_image_is_retained_without_deleting_any_resource(self):
        for mode in ['validation-failure','ambiguous-created']:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as name:
                output=Path(name).resolve();image,table,docker=self.attempt(output,mode)
                if mode=='validation-failure':
                    table.images[FOREIGN_IMAGE]=dict(table.images[IMAGE],Id=FOREIGN_IMAGE);table.bind(TAG,FOREIGN_IMAGE)
                else:table.images[IMAGE]['Config']['Labels']['io.checktrail.gcc-staged-owner']='other-owner'
                with self.assertRaises(ValueError):m.cleanup_owned(output,docker)
                self.assertIn(IMAGE,table.images);self.assertEqual(self.removals(table),[])
                self.assertFalse(json.loads((output/'SDK-IMAGE-CLEANUP.json').read_bytes())['ownedImageCleanupComplete'])

    def test_ambiguous_commit_without_tag_or_returned_identity_never_claims_cleanup_complete(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'ambiguous-created');del table.tags[TAG]
            with self.assertRaisesRegex(ValueError,'cleanup is unproven'):m.cleanup_owned(output,docker)
            self.assertIn(IMAGE,table.images);self.assertEqual(self.removals(table),[])
            self.assertFalse(json.loads((output/'SDK-IMAGE-CLEANUP.json').read_bytes())['ownedImageCleanupComplete'])

    def test_tag_dropped_and_image_aliased_after_inspection_keeps_the_foreign_tag_and_image(self):
        # Another client untags ours and tags the image as its own between the
        # admission inspect and the removal. Removing by ID would take its tag.
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure')
            raced=[]
            def docker_after_inspect(args,**kw):
                value=docker(args,**kw)
                if args==['image','inspect',TAG] and not raced:
                    raced.append(True);del table.tags[TAG];table.bind(FOREIGN_TAG,IMAGE)
                return value
            with self.assertRaisesRegex(ValueError,'no longer names the observed image'):m.cleanup_owned(output,docker_after_inspect)
            self.assertEqual(raced,[True])
            self.assertIn(IMAGE,table.images);self.assertEqual(table.view(IMAGE)['RepoTags'],[FOREIGN_TAG])
            self.assertEqual([call for call in table.calls if call[:2]==['image','rm']],[])
            self.assertFalse(json.loads((output/'SDK-IMAGE-CLEANUP.json').read_bytes())['ownedImageCleanupComplete'])

    def test_tag_rebound_to_a_foreign_image_after_inspection_never_untags_that_image(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure')
            raced=[]
            def docker_after_inspect(args,**kw):
                value=docker(args,**kw)
                if args==['image','inspect',TAG] and not raced:
                    raced.append(True);table.images[FOREIGN_IMAGE]=dict(table.images[IMAGE],Id=FOREIGN_IMAGE);table.bind(TAG,FOREIGN_IMAGE)
                return value
            with self.assertRaisesRegex(ValueError,'no longer names the observed image'):m.cleanup_owned(output,docker_after_inspect)
            self.assertEqual(raced,[True])
            self.assertIn(FOREIGN_IMAGE,table.images);self.assertEqual(table.view(FOREIGN_IMAGE)['RepoTags'],[TAG])
            self.assertIn(IMAGE,table.images);self.assertEqual([call for call in table.calls if call[:2]==['image','rm']],[])

    def test_rebind_in_the_last_instant_before_removal_is_detected_and_reported(self):
        # The Docker API offers no compare-and-delete: a rebind between the
        # final tag read and the removal reaches the foreign image. The owned
        # image is then left untagged, which cleanup refuses to call complete.
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure')
            def rebind(store):store.images[FOREIGN_IMAGE]=dict(store.images[IMAGE],Id=FOREIGN_IMAGE);store.bind(TAG,FOREIGN_IMAGE)
            table.races[('image','rm',TAG)]=rebind
            with self.assertRaisesRegex(ValueError,'survived removal of its only tag'):m.cleanup_owned(output,docker)
            self.assertIn(IMAGE,table.images);self.assertEqual(table.view(IMAGE)['RepoTags'],[])
            self.assertFalse(json.loads((output/'SDK-IMAGE-CLEANUP.json').read_bytes())['ownedImageCleanupComplete'])

    def test_image_that_already_carries_a_foreign_alias_loses_only_the_owned_tag(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure');table.bind(FOREIGN_TAG,IMAGE)
            result=m.cleanup_owned(output,docker)
            self.assertTrue(result['ownedImageCleanupComplete']);self.assertEqual(result['unrelatedRemainingAliasesProtected'],[FOREIGN_TAG])
            self.assertIn(IMAGE,table.images);self.assertEqual(table.view(IMAGE)['RepoTags'],[FOREIGN_TAG])
            self.assertEqual(self.removals(table),[['image','rm',TAG]])

    def test_returned_untagged_image_is_removed_through_the_owned_tag_not_its_id(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure');del table.tags[TAG]
            result=m.cleanup_owned(output,docker)
            self.assertTrue(result['ownedImageCleanupComplete']);self.assertNotIn(IMAGE,table.images)
            self.assertEqual(self.removals(table),[['tag',IMAGE,TAG],['image','rm',TAG]])

    def test_returned_untagged_image_aliased_before_removal_keeps_the_foreign_tag(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name).resolve();_,table,docker=self.attempt(output,'validation-failure');del table.tags[TAG]
            raced=[]
            def docker_after_inspect(args,**kw):
                value=docker(args,**kw)
                if args==['image','inspect',IMAGE] and not raced:raced.append(True);table.bind(FOREIGN_TAG,IMAGE)
                return value
            result=m.cleanup_owned(output,docker_after_inspect)
            self.assertEqual(raced,[True]);self.assertTrue(result['ownedImageCleanupComplete'])
            self.assertIn(IMAGE,table.images);self.assertEqual(table.view(IMAGE)['RepoTags'],[FOREIGN_TAG])
            self.assertEqual(result['unrelatedRemainingAliasesProtected'],[FOREIGN_TAG])


if __name__=='__main__':unittest.main(verbosity=2)
