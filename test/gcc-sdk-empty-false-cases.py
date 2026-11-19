"""Synthetic N13 exact numeric0/Perl-empty-false success protocol compatibility."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('empty_false_layout_fixture',ROOT/'test/gcc-sdk-format-layout-cases.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
d=fixture.d;m=fixture.m

class EmptyFalse(unittest.TestCase):
    def helper(self):
        h=fixture.Layout();self.addCleanup(h.doCleanups);return h
    def test_exact_two_literals_preserve_empty_false_finalspace_and_n13_mapping_for_both(self):
        self.assertEqual(d.MAPPING_SUCCESS_TRAILERS,{d.MAPPING_STATUS0_TRAILER,d.MAPPING_EMPTY_FALSE_TRAILER})
        empty=d.MAPPING_EMPTY_FALSE_TRAILER.encode();self.assertEqual((len(empty),hashlib.sha256(empty).hexdigest()),(36,'6f090543b0f5172f7485d1c67b2f2fac0e0df050c6181b8502d7dd966a2310a8'))
        h=self.helper();expected=h.parse(h.listing())
        for text in d.MAPPING_SUCCESS_TRAILERS:
            for kwargs in [{},{'lead':2,'gaps':1,'tail':2}]:
                raw=h.listing(**kwargs)+text.encode()+b'\n\n';self.assertEqual(h.parse(raw),expected)
                shape=d.mapping_layout(raw)[1];self.assertEqual((shape['status0TrailerLines'],shape['misplacedStatus0TrailerLines'],shape['unknownLines']),(1,0,0))
    def test_missing_finalspace_nonzero_prefix_suffix_case_and_other_whitespace_never_normalize(self):
        h=self.helper();empty=d.MAPPING_EMPTY_FALSE_TRAILER;zero=d.MAPPING_STATUS0_TRAILER
        values=[empty[:-1],empty+' ',empty+'1',empty+'00',' '+empty,'prefix'+empty,empty+'suffix',empty+'\t',empty.replace('[INFO]','[info]'),zero+' ',zero+'suffix']
        for text in values:
            with self.subTest(text=text),self.assertRaises(ValueError):h.parse(h.listing()+text.encode()+b'\n')
    def test_both_spellings_are_single_terminal_and_never_reordered_or_field_substitutes(self):
        h=self.helper();blocks=h.blocks()
        for first in d.MAPPING_SUCCESS_TRAILERS:
            for second in d.MAPPING_SUCCESS_TRAILERS:
                with self.assertRaises(ValueError):h.parse(h.listing()+(first+'\n'+second+'\n').encode())
            with self.assertRaises(ValueError):h.parse(first.encode()+b'\n'+h.listing())
            for position in range(13):
                raw=('List of all formats:\n'+'\n'.join(sum(blocks[:position],[])+[first]+sum(blocks[position:],[]))+'\n').encode()
                with self.assertRaises(ValueError):h.parse(raw)
            for field in range(3):
                changed=copy.deepcopy(blocks);changed[6][field]=first
                with self.assertRaises(ValueError):h.parse(h.listing(changed))
    def test_empty_false_preserves_semantic_source_config_and_all13_effective_origin_checks(self):
        h=self.helper();raw=h.listing()+d.MAPPING_EMPTY_FALSE_TRAILER.encode()+b'\n';path,rows=fixture.fixture.Metadata().mapping_fixture()
        with mock.patch.object(d,'expected_leaf',return_value=(path,[rows[path]])) as origin,\
             mock.patch.object(d,'file_pin',side_effect=lambda p:rows[str(p)]):
            self.assertEqual(len(d.parse_mapping(raw,rows)),13);self.assertEqual(origin.call_count,13)
        for changed in [raw.replace(b' enabled',b' disabled',1),raw.replace(b'(engine=mf-nowin)',b'(engine=mf)',1),raw.replace(b'args=tex.ini',b'args=tex.ini extra',1),raw.replace(b'hyphen=language.def',b'hyphen=changed.def',1)]:
            with self.assertRaises(ValueError):h.parse(changed)
        for entry in d.FORMAT_MAP.values():
            changed=copy.deepcopy(rows);changed[entry['sourceConfigPath']]['sha256']='f'*64
            with self.assertRaisesRegex(ValueError,'configuration identity differs'):h.parse(raw,changed)
        with self.assertRaisesRegex(ValueError,'Effective fmtutil configuration differs'):
            h.parse(raw,physical=lambda p:{**rows[path],'sha256':'f'*64} if str(p)==path else rows[str(p)])
    def test_closed_n13_prefix6_projection_identifies_observed36byte_public_grammar_without_body_egress(self):
        h=self.helper();raw=h.listing().replace(b'Synthetic original protocol prelude',b'\n'.join(('Synthetic prelude '+str(i)).encode() for i in range(6)))+d.MAPPING_EMPTY_FALSE_TRAILER.encode()+b'\n'
        value=h.project(raw);m.validate(value);self.assertEqual(value['state'],'observed');shape=value['mapping'];rows=value['nonRecordMappingRows']
        self.assertEqual((shape['totalLines'],shape['prefixLines'],shape['bodyLines']),(47,6,40));self.assertTrue(shape['layoutCompatible']);self.assertTrue(shape['sourceBound'])
        self.assertEqual(rows['rows'],[{'documentLine':47,'bodyLine':40,'byteLength':36,'sha256':'6f090543b0f5172f7485d1c67b2f2fac0e0df050c6181b8502d7dd966a2310a8','category':'empty-false-trailer-literal','completeRecordsBefore':13,'completeRecordsAfter':0,'position':'after-complete-records'}])
        self.assertEqual(rows['categoryCounts']['empty-false-trailer-literal'],1);self.assertEqual(rows['categoryCounts']['status0-trailer-literal'],0)
        self.assertEqual(rows['stdoutSha256'],shape['stdoutSha256']);self.assertEqual(rows['stdoutSha256'],hashlib.sha256(raw).hexdigest())
        public=json.dumps(value,sort_keys=True).encode()
        for text in [d.MAPPING_EMPTY_FALSE_TRAILER.encode(),b'exiting with status',b'Synthetic prelude',b'origin=',b'/var/lib/']:self.assertNotIn(text,public)
        self.assertLessEqual(len(public),8192);self.assertFalse(value['sdkQualifiedByProjection']);self.assertFalse(value['underlyingRootCauseAssessed'])
    def test_exact_empty_false_cannot_borrow_wrong_hash_command_or_nonzero_native_terminal(self):
        h=self.helper();raw=h.listing()+d.MAPPING_EMPTY_FALSE_TRAILER.encode()+b'\n'
        def wrong_hash(record,rows):rows[-1]['stdoutSha256']='f'*64;record['effectiveMappingCommand']=copy.deepcopy(rows[-1])
        for change in [wrong_hash,lambda record,rows:rows[-1].__setitem__('exitCode',7),lambda record,rows:record['effectiveMappingCommand'].__setitem__('label','sdk-effective-format-mapping-suffix')]:
            value=h.project(raw,change);self.assertEqual(value['state'],'invalid');self.assertFalse(value['mapping']['sourceBound']);self.assertEqual(value['nonRecordMappingRows'],m.empty_mapping_rows())

if __name__=='__main__':unittest.main(verbosity=2)
