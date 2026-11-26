"""Synthetic N=13 listing compatibility and hash-bound closed shape evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parent.parent
RAW='RAW_SYNTHETIC_MAPPING_LINE_NOT_FOR_PUBLIC_17'

def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

fixture=load(ROOT/'test/gcc-sdk-derived-run-cases.py','format_fixture')
d=fixture.m
structured_cases=load(ROOT/'test/gcc-sdk-structured-diagnostics-cases.py','structured_fixture')
m=structured_cases.m
h=structured_cases.h

class Layout(unittest.TestCase):
    def blocks(self):
        return [[name+' (engine='+entry['configuredEngine']+') enabled','  hyphen='+entry['hyphenInput']+', args='+' '.join(entry['generatorArguments']),
                 '  origin=/var/lib/texmf/fmtutil.cnf-SYNTHETIC'] for name,entry in sorted(d.FORMAT_MAP.items())]
    def listing(self,blocks=None,gaps=0,tail=0,lead=0):
        blocks=self.blocks() if blocks is None else blocks;lines=['Synthetic original protocol prelude','List of all formats:']+['']*lead
        for index,block in enumerate(blocks):
            lines+=block
            if index<len(blocks)-1:lines+=['']*(gaps(index) if callable(gaps) else gaps)
        lines+=['']*tail
        return ('\n'.join(lines)+'\n').encode()
    def parse(self,raw,rows=None,origin=None,physical=None):
        path,default=fixture.Metadata().mapping_fixture();rows=default if rows is None else rows
        with mock.patch.object(d,'expected_leaf',return_value=(origin or path,[rows[path]])),\
             mock.patch.object(d,'file_pin',side_effect=physical or (lambda p:rows[str(p)])):
            return d.parse_mapping(raw,rows)
    def project(self,raw,change=None):
        helper=structured_cases.Structured();self.addCleanup(helper.doCleanups);f=helper.fixture()
        rows=helper.rows(f,20);rows[-1].update(stdoutBytesRetained=len(raw),stdoutSha256=m.digest(raw))
        helper.write_journal(f,0,rows);helper.software(f);record=helper.generation(f)
        record.update(effectiveMappingNativeOutput=raw.decode(),effectiveMappingCommand=copy.deepcopy(rows[-1]))
        if change:change(record,rows)
        helper.write_journal(f,0,rows);(f['observations']/m.FILES['generation']).write_bytes(h.canonical(record));helper.times(f)
        return helper.project(f)
    def test_n13_compact_and_empty_completed_record_separators_preserve_identical_semantics(self):
        compact=self.parse(self.listing());self.assertEqual(len(compact),13)
        for gaps,tail,layout in [(0,0,'compact'),(1,0,'separated'),(2,3,'separated'),(lambda i:1 if i%2 else 0,2,'mixed'),(0,4,'compact')]:
            with self.subTest(layout=layout,tail=tail):
                raw=self.listing(gaps=gaps,tail=tail);blocks,shape=d.mapping_layout(raw)
                self.assertTrue(shape['layoutCompatible']);self.assertEqual(self.parse(raw),compact)
                self.assertEqual(len(blocks),13);self.assertEqual(shape['layout'],layout)
                self.assertEqual(shape['recognizedRecords'],13)
                self.assertEqual((shape['unknownRecords'],shape['duplicateRecords'],shape['missingRecords'],shape['semanticMismatchRecords']),(0,0,0,0))
                self.assertEqual(3*len(blocks)+shape['boundaryBlankLines'],shape['bodyLines'])
    def test_exact_empty_document_boundary_lines_preserve_all13_records_and_have_distinct_counts(self):
        expected=self.parse(self.listing())
        for leading in [1,3]:
            raw=self.listing(lead=leading,gaps=1);blocks,shape=d.mapping_layout(raw)
            self.assertTrue(shape['layoutCompatible']);self.assertEqual(self.parse(raw),expected);self.assertEqual(len(blocks),13)
            self.assertEqual(shape['documentBlankLines'],leading);self.assertEqual(shape['misplacedBlankLines'],0)
            self.assertEqual(shape['separatorScope'],'document-and-complete-record-boundaries')
            value=self.project(raw);self.assertTrue(value['mapping']['sourceBound']);self.assertEqual(value['mapping']['documentBlankLines'],leading)

    def test_valid_reordered13_records_crlf_and_old_trailing_blank_near_misses_still_match(self):
        expected=self.parse(self.listing());raw=self.listing(blocks=list(reversed(self.blocks())),gaps=1,tail=2)
        self.assertEqual(self.parse(raw),expected);self.assertEqual(self.parse(raw.replace(b'\n',b'\r\n')),expected)
    def test_blank_replacing_any_n13_header_details_origin_or_inside_field_never_becomes_a_separator(self):
        for index in range(13):
            for field in range(3):
                with self.subTest(record=index,field=field):
                    blocks=self.blocks();blocks[index][field]='';raw=self.listing(blocks,gaps=1)
                    with self.assertRaises(ValueError):self.parse(raw)
                    _,shape=d.mapping_layout(raw);self.assertFalse(shape['layoutCompatible']);self.assertGreater(shape['misplacedBlankLines']+shape['unknownLines'],0)
            for field in [1,2]:
                with self.subTest(record=index,insertBeforeField=field):
                    blocks=self.blocks();blocks[index].insert(field,'');raw=self.listing(blocks)
                    with self.assertRaises(ValueError):self.parse(raw)
                    self.assertFalse(d.mapping_layout(raw)[1]['layoutCompatible'])
    def test_unknown_nonempty_or_whitespace_footer_and_inter_record_lines_are_not_filtered(self):
        for suffix in [b'unknown footer\n',b' \n',RAW.encode()+b'\n']:
            with self.subTest(suffix=suffix):
                raw=self.listing(gaps=1)+suffix
                with self.assertRaises(ValueError):self.parse(raw)
                self.assertEqual(d.mapping_layout(raw)[1]['unknownLines'],1)
        raw=self.listing().replace(b'  origin=/var/lib/texmf/fmtutil.cnf-SYNTHETIC\n',b'  origin=/var/lib/texmf/fmtutil.cnf-SYNTHETIC\n'+RAW.encode()+b'\n',1)
        with self.assertRaises(ValueError):self.parse(raw)
    def test_unknown_suffix_duplicate_and_missing_records_keep_exact13_set_and_closed_counts(self):
        for kind in ['unknown','duplicate','missing','extra-record','duplicate-title']:
            with self.subTest(kind=kind):
                blocks=self.blocks()
                if kind=='unknown':blocks[0][0]='dvilualatex-suffix (engine=luatex) enabled'
                elif kind=='duplicate':blocks[0]=copy.deepcopy(blocks[1])
                elif kind=='missing':blocks.pop()
                elif kind=='extra-record':blocks.append(copy.deepcopy(blocks[0]))
                raw=self.listing(blocks,gaps=1)
                if kind=='duplicate-title':raw=raw.replace(b'List of all formats:\n',b'List of all formats:\nList of all formats:\n')
                with self.assertRaises(ValueError):self.parse(raw)
                _,shape=d.mapping_layout(raw)
                if kind=='unknown':self.assertEqual((shape['unknownRecords'],shape['missingRecords']),(1,1))
                elif kind=='duplicate':self.assertEqual((shape['duplicateRecords'],shape['missingRecords']),(1,1))
                elif kind=='missing':self.assertEqual((shape['recognizedRecords'],shape['missingRecords']),(12,1))
                elif kind=='extra-record':self.assertEqual(shape['duplicateRecords'],1)
                else:self.assertEqual(shape['headerLines'],2)
    def test_enabled_engine_hyphen_arguments_and_full_original_config_identities_are_still_required(self):
        raw=self.listing(gaps=1)
        for changed in [raw.replace(b' enabled',b' disabled',1),raw.replace(b'(engine=mf-nowin)',b'(engine=mf)',1),
                        raw.replace(b'args=tex.ini',b'args=tex.ini extra',1),raw.replace(b'hyphen=language.def',b'hyphen=changed-language.def',1)]:
            with self.subTest(changed=changed[:64]):
                with self.assertRaises(ValueError):self.parse(changed)
                self.assertEqual(d.mapping_layout(changed)[1]['semanticMismatchRecords'],1)
        path,rows=fixture.Metadata().mapping_fixture()
        for entry in d.FORMAT_MAP.values():
            changed=copy.deepcopy(rows);changed[entry['sourceConfigPath']]['sha256']='f'*64
            with self.assertRaisesRegex(ValueError,'configuration identity differs'):self.parse(raw,changed)
        for key,value in [('sha256','e'*64),('mode',0o777),('bytes',999),('mtimeNs',0)]:
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'configuration differs'):
                self.parse(raw,physical=lambda p:{**rows[path],key:value} if str(p)==path else rows[str(p)])
        for entry in d.FORMAT_MAP.values():
            source_path=entry['sourceConfigPath']
            for key,value in [('sha256','f'*64),('mode',0o777),('mtimeNs',0)]:
                with self.subTest(physicalSource=source_path,key=key),self.assertRaisesRegex(ValueError,'Physical original format configuration differs'):
                    self.parse(raw,physical=lambda p:{**rows[str(p)],key:value} if str(p)==source_path else rows[str(p)])
        bad_origin='/usr/share/fmtutil.cnf';extra={**rows,bad_origin:{**rows[path],'path':bad_origin}}
        with self.assertRaisesRegex(ValueError,'configuration origin'):self.parse(raw,extra,origin=bad_origin)
    def test_closed_native_shape_binds_exact_command19_original_stdout_hash_and_byte_count(self):
        raw=self.listing(gaps=1);value=self.project(raw);self.assertEqual(value['state'],'observed')
        shape=value['mapping'];self.assertTrue(shape['sourceBound']);self.assertEqual(shape['stdoutSha256'],m.digest(raw))
        self.assertEqual(shape['layout'],'separated');self.assertEqual(shape['recognizedRecords'],13);self.assertEqual(shape['boundaryBlankLines'],12)
        self.assertEqual(shape['totalLines'],53);self.assertEqual(shape['blankLines'],12)
        self.assertIs(value['sdkQualifiedByProjection'],False);self.assertIs(value['underlyingRootCauseAssessed'],False)
        public=h.canonical(value)
        for body in [b'/var/lib/',b'fmtutil.cnf-SYNTHETIC',b'dvilualatex',b'origin=',b'List of all formats:']:self.assertNotIn(body,public)
        self.assertLessEqual(len(public),8192)
    def test_borrowed_stdout_wrong_command_hash_count_and_nonzero_mapping_cannot_supply_shape_evidence(self):
        raw=self.listing(gaps=1)
        changes=[lambda record,rows:record.__setitem__('effectiveMappingNativeOutput',record['effectiveMappingNativeOutput']+'\n'),
                 lambda record,rows:record['effectiveMappingCommand'].__setitem__('label','sdk-effective-format-mapping-suffix'),
                 lambda record,rows:rows[-1].__setitem__('stdoutSha256','f'*64),
                 lambda record,rows:rows[-1].__setitem__('stdoutBytesRetained',len(raw)+1),
                 lambda record,rows:rows[-1].__setitem__('exitCode',7)]
        for change in changes:
            with self.subTest(change=change):
                value=self.project(raw,change);self.assertEqual(value['state'],'invalid');self.assertFalse(value['mapping']['sourceBound'])
                self.assertNotIn(b'/var/lib/',h.canonical(value))
    def test_observed_unsupported_and_unknown_shapes_are_counts_not_raw_lines_or_silent_compatibility(self):
        for raw in [self.listing()+RAW.encode()+b'\n',b'no exact original header\n',self.listing().replace(b'  hyphen=',b'\n  hyphen=',1)]:
            with self.subTest(raw=raw[:48]):
                value=self.project(raw);self.assertEqual(value['state'],'observed');shape=value['mapping']
                self.assertTrue(shape['sourceBound']);self.assertFalse(shape['layoutCompatible']);self.assertEqual(shape['layout'],'unsupported')
                self.assertNotIn(RAW.encode(),h.canonical(value));m.validate(value)
        _,shape=d.mapping_layout(b'\xff\x00');self.assertEqual(shape['state'],'invalid');self.assertFalse(shape['layoutCompatible'])
    def test_shape_schema_extra_raw_field_boolean_counts_unbound_facts_and_overbudget_receipts_fail_closed(self):
        value=self.project(self.listing(gaps=1));m.validate(value)
        for change in [lambda x:x.update(raw=RAW),lambda x:x.update(totalLines=True),lambda x:x.update(layout=RAW),
                       lambda x:x.update(stdoutSha256='/path/'+RAW),lambda x:x.update(sourceBound=False),
                       lambda x:x.update(unknownLines=1),lambda x:x.update(bodyLines=x['bodyLines']+1)]:
            bad=copy.deepcopy(value);change(bad['mapping'])
            with self.assertRaises((m.Bad,TypeError)):m.validate(bad)
        receipt=h.empty_receipt('a'*40);receipt['errorId']='sdk-incomplete';receipt['structuredSdk']=value
        self.assertLessEqual(len(h.PREFIX+h.canonical(h.validate_receipt(receipt))),16384)

if __name__=='__main__':unittest.main(verbosity=2)
