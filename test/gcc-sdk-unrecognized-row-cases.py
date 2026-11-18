"""First-party synthetic closed row diagnostics; never reads original SDK output."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('row_layout_fixture',ROOT/'test/gcc-sdk-format-layout-cases.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
m=fixture.m;d=fixture.d
RAW_A='SYNTHETIC_PRIVATE_MAPPING_ROW_ALPHA_/private/not-for-egress'
RAW_B='SYNTHETIC_PRIVATE_MAPPING_ROW_BETA_名前'

class Rows(unittest.TestCase):
    def helper(self):
        helper=fixture.Layout();self.addCleanup(helper.doCleanups);return helper
    def project(self,raw,change=None):return self.helper().project(raw,change)
    def public(self,value):
        result=json.dumps(m.validate(value),sort_keys=True,separators=(',',':')).encode()
        for denied in [RAW_A.encode(),RAW_B.encode(),b'/private/',b'origin=',b'fmtutil.cnf-SYNTHETIC']:
            self.assertNotIn(denied,result)
        self.assertLessEqual(len(result),8192);return result
    def test_n2_unknown_rows_have_exact_positions_byte_lengths_hashes_and_no_body_egress(self):
        helper=self.helper();raw=helper.listing()+RAW_A.encode()+b'\n'+RAW_B.encode()+b'\n'
        value=self.project(raw);rows=value['nonRecordMappingRows'];self.public(value)
        self.assertEqual((rows['state'],rows['sourceBound'],rows['totalRows'],rows['retainedRows'],rows['omittedRows']),('observed',True,2,2,0))
        self.assertEqual(rows['stdoutSha256'],hashlib.sha256(raw).hexdigest())
        for index,text in enumerate([RAW_A,RAW_B]):
            row=rows['rows'][index]
            self.assertEqual(row,{'documentLine':42+index,'bodyLine':40+index,'byteLength':len(text.encode()),'sha256':hashlib.sha256(text.encode()).hexdigest(),
                'category':'other-nonempty','completeRecordsBefore':13,'completeRecordsAfter':0,'position':'after-complete-records'})
        self.assertEqual(sum(rows['categoryCounts'].values()),2);self.assertFalse(value['mapping']['layoutCompatible']);self.assertFalse(value['sdkQualifiedByProjection'])
    def test_before_between_and_after_are_physical_positions_not_a_footer_acceptance(self):
        helper=self.helper();blocks=helper.blocks()
        raw=('List of all formats:\n'+RAW_A+'\n'+'\n'.join(blocks[0])+'\n'+RAW_B+'\n'+'\n'.join(sum(blocks[1:],[]))+'\n'+RAW_A+'\n').encode()
        value=self.project(raw);rows=value['nonRecordMappingRows'];self.public(value)
        self.assertEqual([r['position'] for r in rows['rows']],['before-complete-records','between-complete-records','after-complete-records'])
        self.assertEqual([(r['completeRecordsBefore'],r['completeRecordsAfter']) for r in rows['rows']],[(0,13),(1,12),(13,0)])
        self.assertEqual([r['bodyLine'] for r in rows['rows']],[1,5,42]);self.assertFalse(value['mapping']['layoutCompatible'])
    def test_finite_syntactic_fragment_categories_reconcile_without_paths_or_names(self):
        lines=[' \t','standalone (engine=engine) enabled',RAW_A,'  hyphen=synthetic, args=synthetic',RAW_B,'  origin=/private/not-for-egress']
        value=self.project(('List of all formats:\n'+'\n'.join(lines)+'\n').encode());rows=value['nonRecordMappingRows'];self.public(value)
        self.assertEqual(rows['categoryCounts'],{'whitespace-only':1,'record-header-fragment':1,'record-details-fragment':1,'record-origin-fragment':1,'other-nonempty':2,'status0-trailer-literal':0})
        self.assertTrue(all(r['position']=='no-complete-records' for r in rows['rows']));self.assertEqual(rows['totalRows'],6)
    def test_n10_rows_keep_only_eight_descriptors_and_all_category_totals(self):
        helper=self.helper();texts=[RAW_A+str(i) for i in range(10)];value=self.project(helper.listing()+('\n'.join(texts)+'\n').encode())
        rows=value['nonRecordMappingRows'];self.public(value)
        self.assertEqual((rows['totalRows'],rows['retainedRows'],rows['omittedRows']),(10,8,2));self.assertEqual(len(rows['rows']),8)
        self.assertEqual(rows['categoryCounts']['other-nonempty'],10);self.assertEqual([r['bodyLine'] for r in rows['rows']],list(range(40,48)))
    def test_crlf_unicode_and_exact_ascii_whitespace_have_distinct_byte_truth_without_stripping(self):
        helper=self.helper();line=' '+RAW_B+'\t';lf=helper.listing()+line.encode()+b'\n'
        for raw in [lf,lf.replace(b'\n',b'\r\n')]:
            value=self.project(raw);row=value['nonRecordMappingRows']['rows'][0];self.public(value)
            self.assertEqual(row['byteLength'],len(line.encode()));self.assertEqual(row['sha256'],hashlib.sha256(line.encode()).hexdigest())
            self.assertEqual(row['category'],'other-nonempty');self.assertNotEqual(row['sha256'],hashlib.sha256(line.strip().encode()).hexdigest())
    def test_empty_boundaries_and_no_unknown_rows_remain_explicit_zero_not_missing(self):
        helper=self.helper()
        for raw in [helper.listing(),helper.listing(lead=2,gaps=1,tail=2)]:
            value=self.project(raw);rows=value['nonRecordMappingRows'];self.public(value)
            self.assertEqual((rows['totalRows'],rows['retainedRows'],rows['omittedRows'],rows['rows']),(0,0,0,[]));self.assertEqual(sum(rows['categoryCounts'].values()),0)
            self.assertTrue(value['mapping']['layoutCompatible']);self.assertFalse(value['sdkQualifiedByProjection'])
    def test_unknown_or_duplicate_document_header_withholds_positional_claims(self):
        helper=self.helper()
        for raw in [b'no exact header\n'+RAW_A.encode()+b'\n',helper.listing().replace(b'List of all formats:\n',b'List of all formats:\nList of all formats:\n')]:
            value=self.project(raw);rows=value['nonRecordMappingRows'];self.public(value)
            self.assertEqual(rows,{**m.empty_mapping_rows(),'state':'unsupported','sourceBound':True,'stdoutSha256':hashlib.sha256(raw).hexdigest()})
        unsupported=m.unrecognized_mapping_rows(b'\xff\x00');self.assertEqual(unsupported['state'],'unsupported');self.assertIsNone(unsupported['totalRows'])
    def test_hash_count_exact_command19_and_genuine_terminal_zero_are_required_before_row_projection(self):
        helper=self.helper();raw=helper.listing()+RAW_A.encode()+b'\n'
        changes=[lambda record,rows:record.__setitem__('effectiveMappingNativeOutput',record['effectiveMappingNativeOutput']+'\n'),
                 lambda record,rows:record['effectiveMappingCommand'].__setitem__('label','sdk-effective-format-mapping-suffix'),
                 lambda record,rows:rows[-1].__setitem__('stdoutSha256','f'*64),lambda record,rows:rows[-1].__setitem__('stdoutBytesRetained',len(raw)+1),
                 lambda record,rows:rows[-1].__setitem__('exitCode',7)]
        def mutually_consistent_wrong_stdout_sha(record,rows):
            rows[-1]['stdoutSha256']='f'*64;record['effectiveMappingCommand']=copy.deepcopy(rows[-1])
        changes.append(mutually_consistent_wrong_stdout_sha)
        for change in changes:
            value=self.project(raw,change);self.public(value);self.assertEqual(value['state'],'invalid');self.assertEqual(value['nonRecordMappingRows'],m.empty_mapping_rows())
    def test_closed_rows_refuse_raw_fields_boolean_positions_corrupt_counts_reordered_or_unbound_data(self):
        helper=self.helper();value=self.project(helper.listing()+RAW_A.encode()+b'\n'+RAW_B.encode()+b'\n');self.public(value)
        edits=[lambda x:x.update(raw=RAW_A),lambda x:x.update(totalRows=True),lambda x:x.update(totalRows=3),lambda x:x.update(omittedRows=1),
               lambda x:x.update(sourceBound=False),lambda x:x.update(stdoutSha256='f'*64),lambda x:x['categoryCounts'].update(raw=RAW_B),
               lambda x:x['rows'][0].update(raw=RAW_A),lambda x:x['rows'][0].update(documentLine=True),lambda x:x['rows'][0].update(byteLength=0),
               lambda x:x['rows'][0].update(sha256=RAW_A),lambda x:x['rows'][0].update(category='footer-safe'),lambda x:x['rows'][0].update(completeRecordsAfter=1),
               lambda x:x['rows'][0].update(position='before-complete-records'),lambda x:x['rows'].reverse(),lambda x:x['rows'].pop()]
        for edit in edits:
            with self.subTest(edit=edit):
                bad=copy.deepcopy(value);edit(bad['nonRecordMappingRows'])
                with self.assertRaises((m.Bad,TypeError)):m.validate(bad)
    def test_one_unknown_row_never_grants_origin_or_original_config_validation(self):
        helper=self.helper();raw=helper.listing()+RAW_A.encode()+b'\n';value=self.project(raw)
        self.assertEqual(value['mapping']['recognizedRecords'],13);self.assertEqual(value['mapping']['semanticMismatchRecords'],0)
        path,rows=fixture.fixture.Metadata().mapping_fixture()
        with mock.patch.object(d,'expected_leaf',return_value=(path,[rows[path]])) as origin,\
             mock.patch.object(d,'file_pin',side_effect=lambda p:rows[str(p)]):
            with self.assertRaisesRegex(ValueError,'Complete13-format native mapping required'):d.parse_mapping(raw,rows)
            origin.assert_not_called()
        self.assertFalse(value['sdkQualifiedByProjection']);self.assertFalse(value['underlyingRootCauseAssessed'])

if __name__=='__main__':unittest.main(verbosity=2)
