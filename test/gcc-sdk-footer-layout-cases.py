"""Synthetic exact optional final status0 trailer; native identity remains unobserved."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('footer_layout_fixture',ROOT/'test/gcc-sdk-format-layout-cases.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
d=fixture.d;m=fixture.m

class Footer(unittest.TestCase):
    def helper(self):
        h=fixture.Layout();self.addCleanup(h.doCleanups);return h
    def raw(self,**kwargs):return self.helper().listing(**kwargs)+d.MAPPING_STATUS0_TRAILER.encode()+b'\n'
    def test_public_source_candidate_is_one_exact37byte_literal_not_observed_native_identity(self):
        encoded=d.MAPPING_STATUS0_TRAILER.encode();self.assertEqual(len(encoded),37)
        self.assertEqual(hashlib.sha256(encoded).hexdigest(),'d74d290a07eece9d8e624d67bae8e30c5b01448a61e77f88976721fddf894a09')
    def test_optional_exact_final_status0_after_all13_records_preserves_every_mapping(self):
        h=self.helper();expected=h.parse(h.listing())
        for kwargs in [{},{'gaps':1},{'lead':2,'gaps':1},{'gaps':lambda i:1 if i%2 else 0,'tail':2}]:
            for tail in [b'',b'\n\n']:
                raw=self.raw(**kwargs)+tail;blocks,shape=d.mapping_layout(raw)
                self.assertEqual(h.parse(raw),expected);self.assertEqual(len(blocks),13)
                self.assertTrue(shape['layoutCompatible']);self.assertEqual((shape['status0TrailerLines'],shape['misplacedStatus0TrailerLines'],shape['unknownLines']),(1,0,0))
                self.assertEqual(shape['bodyLines'],39+shape['blankLines']+1)
    def test_final_trailer_does_not_bypass_actual13_effective_origin_physical_checks(self):
        path,rows=fixture.fixture.Metadata().mapping_fixture();raw=self.raw()
        with mock.patch.object(d,'expected_leaf',return_value=(path,[rows[path]])) as origin,\
             mock.patch.object(d,'file_pin',side_effect=lambda p:rows[str(p)]):
            result=d.parse_mapping(raw,rows);self.assertEqual(len(result),13);self.assertEqual(origin.call_count,13)
        h=self.helper()
        for key,value in [('sha256','f'*64),('mode',0o777),('mtimeNs',0),('bytes',999)]:
            with self.assertRaisesRegex(ValueError,'Effective fmtutil configuration differs'):
                h.parse(raw,physical=lambda p:{**rows[path],key:value} if str(p)==path else rows[str(p)])
        bad='/usr/share/not-an-original-effective-config';extra={**rows,bad:{**rows[path],'path':bad}}
        with self.assertRaisesRegex(ValueError,'configuration origin'):h.parse(raw,extra,origin=bad)
    def test_prefix_suffix_whitespace_case_nonzero_and_other_info_lines_are_never_generic_footers(self):
        h=self.helper();literal=d.MAPPING_STATUS0_TRAILER
        candidates=['prefix '+literal,literal+' suffix',' '+literal,literal+' ',literal[:-1]+' ',literal.replace('[INFO]','[info]'),literal[:-1]+'1',literal[:-1]+'00','fmtutil [INFO]: done']
        for text in candidates:
            raw=h.listing()+text.encode()+b'\n'
            with self.subTest(text=text),self.assertRaises(ValueError):h.parse(raw)
            shape=d.mapping_layout(raw)[1];self.assertFalse(shape['layoutCompatible']);self.assertEqual(shape['status0TrailerLines'],0)
    def test_duplicate_and_all_reordered_trailer_positions_including_prefix_refuse(self):
        h=self.helper();blocks=h.blocks();literal=d.MAPPING_STATUS0_TRAILER
        candidates=[literal.encode()+b'\n'+h.listing(),self.raw()+literal.encode()+b'\n']
        for position in range(13):
            lines=['List of all formats:']+sum(blocks[:position],[])+[literal]+sum(blocks[position:],[]);candidates.append(('\n'.join(lines)+'\n').encode())
        for raw in candidates:
            with self.subTest(rawHash=hashlib.sha256(raw).hexdigest()),self.assertRaises(ValueError):h.parse(raw)
            shape=d.mapping_layout(raw)[1];self.assertFalse(shape['layoutCompatible']);self.assertGreater(shape['misplacedStatus0TrailerLines'],0)
    def test_unknown_or_extra_record_after_or_before_trailer_cannot_become_terminal_success(self):
        h=self.helper();block=('\n'.join(h.blocks()[0])+'\n').encode()
        for raw in [self.raw()+b'unknown additional output\n',self.raw()+block,h.listing()+block+d.MAPPING_STATUS0_TRAILER.encode()+b'\n',h.listing()+b'unknown\n'+d.MAPPING_STATUS0_TRAILER.encode()+b'\n']:
            with self.assertRaises(ValueError):h.parse(raw)
    def test_13_matching_names_without_exact_semantics_cannot_admit_footer_or_skip_config_checks(self):
        h=self.helper();raw=self.raw()
        for changed in [raw.replace(b' enabled',b' disabled',1),raw.replace(b'(engine=mf-nowin)',b'(engine=mf)',1),raw.replace(b'args=tex.ini',b'args=tex.ini extra',1),raw.replace(b'hyphen=language.def',b'hyphen=changed.def',1)]:
            with self.assertRaises(ValueError):h.parse(changed)
            self.assertEqual(d.mapping_layout(changed)[1]['status0TrailerLines'],0)
        _,rows=fixture.fixture.Metadata().mapping_fixture()
        for entry in d.FORMAT_MAP.values():
            changed=copy.deepcopy(rows);changed[entry['sourceConfigPath']]['sha256']='f'*64
            with self.assertRaisesRegex(ValueError,'configuration identity differs'):h.parse(raw,changed)
    def test_hash_bound_projection_identifies_only_footer_enum_position_length_sha_and_no_body(self):
        raw=self.raw();value=self.helper().project(raw);m.validate(value)
        shape=value['mapping'];rows=value['nonRecordMappingRows'];self.assertTrue(shape['sourceBound']);self.assertTrue(shape['layoutCompatible'])
        self.assertEqual((shape['status0TrailerLines'],shape['misplacedStatus0TrailerLines']),(1,0));self.assertEqual(shape['unknownLines'],0)
        self.assertEqual((rows['totalRows'],rows['retainedRows'],rows['omittedRows']),(1,1,0));self.assertEqual(rows['categoryCounts']['status0-trailer-literal'],1)
        row=rows['rows'][0];self.assertEqual(row,{'documentLine':42,'bodyLine':40,'byteLength':37,'sha256':'d74d290a07eece9d8e624d67bae8e30c5b01448a61e77f88976721fddf894a09','category':'status0-trailer-literal','completeRecordsBefore':13,'completeRecordsAfter':0,'position':'after-complete-records'})
        self.assertEqual(shape['stdoutSha256'],rows['stdoutSha256']);self.assertEqual(shape['stdoutSha256'],hashlib.sha256(raw).hexdigest())
        public=json.dumps(value,sort_keys=True).encode()
        for raw_body in [d.MAPPING_STATUS0_TRAILER.encode(),b'exiting with status',b'origin=',b'/var/lib/',b'fmtutil.cnf-SYNTHETIC']:self.assertNotIn(raw_body,public)
        self.assertLessEqual(len(public),8192);self.assertFalse(value['sdkQualifiedByProjection']);self.assertFalse(value['underlyingRootCauseAssessed'])
        receipt=fixture.h.empty_receipt('a'*40);receipt['errorId']='sdk-incomplete';receipt['structuredSdk']=value
        self.assertLessEqual(len(fixture.h.PREFIX+fixture.h.canonical(fixture.h.validate_receipt(receipt))),16384)
    def test_known_literal_category_is_not_a_layout_admission_when_reordered_duplicated_or_nonzero(self):
        h=self.helper();raw=self.raw()+d.MAPPING_STATUS0_TRAILER.encode()+b'\n';value=h.project(raw);m.validate(value)
        self.assertFalse(value['mapping']['layoutCompatible']);self.assertEqual(value['mapping']['status0TrailerLines'],0)
        self.assertEqual(value['mapping']['misplacedStatus0TrailerLines'],2);self.assertEqual(value['nonRecordMappingRows']['categoryCounts']['status0-trailer-literal'],2)
        changed=self.raw().replace(d.MAPPING_STATUS0_TRAILER.encode(),d.MAPPING_STATUS0_TRAILER[:-1].encode()+b'1');value=h.project(changed);self.assertEqual(value['state'],'observed')
        self.assertEqual(value['nonRecordMappingRows']['categoryCounts']['status0-trailer-literal'],0);self.assertFalse(value['mapping']['layoutCompatible'])
    def test_wrong_native_command_hash_or_nonzero_never_qualifies_even_exact_trailer_projection(self):
        h=self.helper();raw=self.raw()
        def wrong_hash(record,rows):rows[-1]['stdoutSha256']='f'*64;record['effectiveMappingCommand']=copy.deepcopy(rows[-1])
        for change in [wrong_hash,lambda record,rows:rows[-1].__setitem__('exitCode',7),lambda record,rows:record['effectiveMappingCommand'].__setitem__('label','sdk-effective-format-mapping-suffix')]:
            value=h.project(raw,change);self.assertEqual(value['state'],'invalid');self.assertFalse(value['mapping']['sourceBound']);self.assertEqual(value['nonRecordMappingRows'],m.empty_mapping_rows())
    def test_new_trailer_counts_and_unsupported_positional_state_remain_closed_and_reconciled(self):
        h=self.helper();value=h.project(self.raw());m.validate(value)
        for edit in [lambda x:x.update(status0TrailerLines=2),lambda x:x.update(status0TrailerLines=True),lambda x:x.update(misplacedStatus0TrailerLines=True),lambda x:x.update(status0TrailerLines=0),lambda x:x.update(misplacedStatus0TrailerLines=1)]:
            bad=copy.deepcopy(value);edit(bad['mapping'])
            with self.assertRaises((m.Bad,TypeError)):m.validate(bad)
        bad=copy.deepcopy(value);bad['nonRecordMappingRows']={**m.empty_mapping_rows(),'state':'unsupported','sourceBound':True,'stdoutSha256':value['mapping']['stdoutSha256']}
        with self.assertRaises(m.Bad):m.validate(bad)

if __name__=='__main__':unittest.main(verbosity=2)
