"""Closed projection of existing LOCAL SDK records; never reads native.log.

This is diagnostic evidence only. No command is executed and no observed field
can qualify the SDK, identify an underlying root cause or advance a GCC phase.
"""
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat

HERE=Path(__file__).resolve().parent

def load(name):
    path=HERE/name;spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

sdk=load('gcc-hosted-sdk.py')
d=load('gcc-sdk-derived-run.py')
CATEGORIES={'matched','timestampOnlyMaterial','incidentalDifferences','unresolvedMaterial','generatedState'}
FAMILIES={'apt','ownership','mapping','generator','validator'}
JOURNAL_STATES={'unobserved','complete-prefix','complete','pending','partial'}
SDK_STATES={'unobserved','sdk-material-reconstruction-unqualified','sdk-material-reconstructed-and-physically-verified'}
GEN_STATES={'unobserved','derived-sdk-generation-incomplete','derived-sdk-outputs-generated-not-yet-finally-validated'}
VALIDATION_STATES={'unobserved','derived-sdk-final-validation-incomplete','derived-sdk-outputs-finally-validated'}
ERRORS={'none','record-invalid','record-unavailable','provenance-refused','stale-record','journal-refused','comparison-refused'}
CAUSES={'unestablished','recorded-command-nonzero','recorded-wrapper-error','recorded-material-comparison-false',
        'generation-reported-error','validation-reported-error'}
FILES={'journal':'sdk-commands.jsonl','sdk':'SDK-RECONSTRUCTION.json','generation':'SDK-DERIVED-GENERATION.json',
       'validation':'SDK-DERIVED-VALIDATION.json','comparison':'sdk-comparison-before.json.gz'}
MAX_JSON=32*1024**2
MAX_EXPANDED=256*1024**2
MAX_JOURNAL=2*1024**2

class Bad(Exception):
    def __init__(self,identifier):self.identifier=identifier

def need(value,identifier='record-invalid'):
    if not value:raise Bad(identifier)

def digest(value):return hashlib.sha256(value).hexdigest()
def number(value):return type(value) in [int,float] and math.isfinite(value) and 0<=value<=21600
def integer(value,maximum=10000000):return type(value) is int and 0<=value<=maximum
def hash_value(value):return value is None or type(value) is str and re.fullmatch('[a-f0-9]{64}',value) is not None

# Closed syntactic categories describe rows, never a semantic footer or acceptance.
ROW_CATEGORIES={'whitespace-only','record-header-fragment','record-details-fragment','record-origin-fragment','other-nonempty','status0-trailer-literal','empty-false-trailer-literal'}
MAX_UNRECOGNIZED_ROWS=8

def empty_mapping_rows():
    return {'state':'unobserved','sourceBound':False,'stdoutSha256':None,'totalRows':None,
            'retainedRows':None,'omittedRows':None,'categoryCounts':None,'rows':[]}

def row_position(before,after):
    return 'no-complete-records' if before==after==0 else 'before-complete-records' if before==0 else 'after-complete-records' if after==0 else 'between-complete-records'

def unrecognized_mapping_rows(raw):
    """Closed diagnostic only, using the exact current three-field recognizer.

    Positions are 1-based. Length/SHA cover the UTF-8 bytes of one decoded line,
    excluding its line terminator, with NO stripping or normalization. The full
    raw stdout digest still binds these observations to the original command.
    Up to eight non-record row descriptors are shown, including the exact
    numeric0 or empty-false trailer literal. Totals cover every such body row. Acceptance is
    separate: only the original parser can qualify its final trailer position.
    No category authorizes skipping a row or qualifies effective physical origin.
    """
    need(type(raw) is bytes and len(raw)<=d.STDOUT_BYTES)
    result=empty_mapping_rows();result.update(state='unsupported',stdoutSha256=digest(raw))
    try:lines=raw.decode().splitlines()
    except UnicodeDecodeError:return result
    headers=[index for index,line in enumerate(lines) if line=='List of all formats:']
    if len(headers)!=1:return result
    start=headers[0]+1;body=lines[start:];unknown=[];complete=0;offset=0;counts={name:0 for name in ROW_CATEGORIES}
    while offset<len(body):
        line=body[offset]
        if line=='':offset+=1;continue
        header,details,origin=d.mapping_fields(body[offset:offset+3])
        if header is not None and details is not None and origin is not None:
            complete+=1;offset+=3;continue
        category='other-nonempty'
        if line==d.MAPPING_EMPTY_FALSE_TRAILER:category='empty-false-trailer-literal'
        elif line==d.MAPPING_STATUS0_TRAILER:category='status0-trailer-literal'
        elif re.fullmatch(r'[ \t]+',line):category='whitespace-only'
        elif d.mapping_fields([line,'',''])[0] is not None:category='record-header-fragment'
        elif d.mapping_fields(['',line,''])[1] is not None:category='record-details-fragment'
        elif d.mapping_fields(['','',line])[2] is not None:category='record-origin-fragment'
        counts[category]+=1
        if len(unknown)<MAX_UNRECOGNIZED_ROWS:
            encoded=line.encode();unknown.append({'documentLine':start+offset+1,'bodyLine':offset+1,
                'byteLength':len(encoded),'sha256':digest(encoded),'category':category,'completeRecordsBefore':complete})
        offset+=1
    for row in unknown:
        row['completeRecordsAfter']=complete-row['completeRecordsBefore']
        row['position']=row_position(row['completeRecordsBefore'],row['completeRecordsAfter'])
    total=sum(counts.values());result.update(state='observed',totalRows=total,retainedRows=len(unknown),omittedRows=total-len(unknown),categoryCounts=counts,rows=unknown)
    return result

def validate_mapping_rows(value,mapping):
    prototype=empty_mapping_rows();need(type(value) is dict and set(value)==set(prototype))
    need(value['state'] in {'unobserved','unsupported','observed'} and type(value['sourceBound']) is bool and hash_value(value['stdoutSha256']))
    if not value['sourceBound']:
        need(value==prototype);return
    need(mapping['sourceBound'] is True and value['stdoutSha256']==mapping['stdoutSha256'] and type(value['stdoutSha256']) is str)
    if value['state']=='unsupported':
        need(value=={**prototype,'state':'unsupported','sourceBound':True,'stdoutSha256':mapping['stdoutSha256']})
        need(mapping['state']=='invalid' or mapping['headerLines']!=1);return
    need(value['state']=='observed' and mapping['state']=='observed' and mapping['headerLines']==1)
    total=value['totalRows'];retained=value['retainedRows'];omitted=value['omittedRows'];counts=value['categoryCounts'];rows=value['rows']
    need(integer(total,d.STDOUT_BYTES) and integer(retained,MAX_UNRECOGNIZED_ROWS) and integer(omitted,d.STDOUT_BYTES))
    need(total==mapping['unknownLines']+mapping['status0TrailerLines'] and retained==min(total,MAX_UNRECOGNIZED_ROWS) and total==retained+omitted)
    need(type(counts) is dict and set(counts)==ROW_CATEGORIES and all(integer(n,d.STDOUT_BYTES) for n in counts.values()) and sum(counts.values())==total)
    need(mapping['status0TrailerLines']<=counts['status0-trailer-literal']+counts['empty-false-trailer-literal']<=mapping['status0TrailerLines']+mapping['misplacedStatus0TrailerLines'])
    need(type(rows) is list and len(rows)==retained)
    previous=0;shown={name:0 for name in ROW_CATEGORIES};records=mapping['recognizedRecords']+mapping['unknownRecords']
    for row in rows:
        need(type(row) is dict and set(row)=={'documentLine','bodyLine','byteLength','sha256','category','completeRecordsBefore','completeRecordsAfter','position'})
        need(integer(row['documentLine'],d.STDOUT_BYTES) and integer(row['bodyLine'],d.STDOUT_BYTES) and previous<row['bodyLine']<=mapping['bodyLines'])
        need(row['documentLine']==mapping['prefixLines']+1+row['bodyLine']);previous=row['bodyLine']
        need(type(row['byteLength']) is int and 1<=row['byteLength']<=d.STDOUT_BYTES and type(row['sha256']) is str and hash_value(row['sha256']))
        need(row['category'] in ROW_CATEGORIES and integer(row['completeRecordsBefore'],records) and integer(row['completeRecordsAfter'],records))
        need(row['completeRecordsBefore']+row['completeRecordsAfter']==records and row['position']==row_position(row['completeRecordsBefore'],row['completeRecordsAfter']))
        shown[row['category']]+=1
    need(all(shown[name]<=counts[name] for name in ROW_CATEGORIES))

def empty():
    return {'schemaVersion':1,'state':'unobserved','errorId':'none','cause':'unestablished',
      'sdkQualifiedByProjection':False,'underlyingRootCauseAssessed':False,
      'unjournaledCollectionAndNormalizationTerminals':'unobserved',
      'hashes':{name:None for name in FILES},
      'journal':{'state':'unobserved','expectedSlots':74,'requested':None,'terminals':None,'terminalZero':None,
                 'terminalNonzero':None,'terminalUnknown':None,'lastRequested':None,'lastTerminal':None},
      'mapping':d.empty_mapping_shape(),'nonRecordMappingRows':empty_mapping_rows(),
      'sdk':{'state':'unobserved','packagesMatch':None,'entries':None,'counts':None,'materialProjectionMatches':None,'generatedComplete':None},
      'generation':{'state':'unobserved','toolIdentities':None,'removedOutputs':None,'completedGenerators':None,'freshFormats':None,'errorSha256':None},
      'validation':{'state':'unobserved','completedValidators':None,'finalGeneratedOutputs':None,'errorSha256':None}}

def validate(value):
    prototype=empty();need(type(value) is dict and set(value)==set(prototype))
    need(type(value['schemaVersion']) is int and value['schemaVersion']==1 and value['state'] in {'unobserved','observed','incomplete','invalid'} and value['errorId'] in ERRORS and value['cause'] in CAUSES)
    need(value['sdkQualifiedByProjection'] is False and value['underlyingRootCauseAssessed'] is False and value['unjournaledCollectionAndNormalizationTerminals']=='unobserved')
    for name in ['hashes','journal','mapping','nonRecordMappingRows','sdk','generation','validation']:need(type(value[name]) is dict and set(value[name])==set(prototype[name]))
    need(all(hash_value(v) for v in value['hashes'].values()))
    j=value['journal'];need(j['state'] in JOURNAL_STATES and type(j['expectedSlots']) is int and j['expectedSlots']==74)
    for key in ['requested','terminals','terminalZero','terminalNonzero','terminalUnknown']:need(j[key] is None or integer(j[key],74))
    if j['requested'] is not None:need(j['terminals'] is not None and j['terminalZero']+j['terminalNonzero']+j['terminalUnknown']==j['terminals']<=j['requested']<=j['terminals']+1)
    for key in ['lastRequested','lastTerminal']:
        row=j[key]
        if row is None:continue
        need(type(row) is dict and set(row)==({'id','stage'} if key=='lastRequested' else {'id','stage','terminalObserved','exitCode','signal','elapsedSeconds','stdoutComplete','stdoutSha256','errorSha256'}))
        need(integer(row['id'],73) and row['stage'] in FAMILIES)
        if key=='lastTerminal':
            need(type(row['terminalObserved']) is bool and (row['exitCode'] is None or integer(row['exitCode'],255)) and
                 (row['signal'] is None or type(row['signal']) is int and 1<=row['signal']<=255) and number(row['elapsedSeconds']))
            need((row['exitCode'] is not None)+(row['signal'] is not None)==int(row['terminalObserved']))
            need(row['stdoutComplete'] is None or type(row['stdoutComplete']) is bool)
            need(hash_value(row['stdoutSha256']) and hash_value(row['errorSha256']))
    mapping=value['mapping'];prototype_mapping=d.empty_mapping_shape()
    need(mapping['separatorScope']=='document-and-complete-record-boundaries')
    need(mapping['state'] in {'unobserved','observed','invalid'} and mapping['layout'] in {'unobserved','unsupported','compact','separated','mixed'} and type(mapping['sourceBound']) is bool and hash_value(mapping['stdoutSha256']))
    if not mapping['sourceBound']:need(mapping==prototype_mapping)
    else:
        need(mapping['state'] in {'observed','invalid'} and type(mapping['stdoutSha256']) is str and type(mapping['layoutCompatible']) is bool)
        fields=set(prototype_mapping)-{'state','layout','separatorScope','sourceBound','stdoutSha256','layoutCompatible'}
        for field in fields:need(mapping[field] is None or integer(mapping[field],d.STDOUT_BYTES))
        if mapping['state']=='observed':
            need(all(type(mapping[key]) is int for key in ['totalLines','blankLines','headerLines']))
            need(mapping['blankLines']<=mapping['totalLines'])
            if mapping['headerLines']==1:
                need(all(type(mapping[key]) is int for key in fields))
                need(mapping['prefixLines']+1+mapping['bodyLines']==mapping['totalLines'])
                count=mapping['recognizedRecords']+mapping['unknownRecords']
                need(3*count+mapping['boundaryBlankLines']+mapping['documentBlankLines']+mapping['misplacedBlankLines']+mapping['unknownLines']+mapping['status0TrailerLines']==mapping['bodyLines'])
                need(mapping['semanticMismatchRecords']<=mapping['recognizedRecords'] and mapping['duplicateRecords']<=count and mapping['missingRecords']<=13)
                need(mapping['separatorBoundaries']<=max(0,count-1) and mapping['separatorBoundaries']<=mapping['boundaryBlankLines'])
                need(mapping['documentBlankLines']+mapping['boundaryBlankLines']+mapping['misplacedBlankLines']<=mapping['blankLines'])
                need(mapping['status0TrailerLines']<=1)
                if mapping['status0TrailerLines']:
                    need(mapping['recognizedRecords']==13 and mapping['unknownRecords']==mapping['duplicateRecords']==mapping['missingRecords']==mapping['semanticMismatchRecords']==0)
        if mapping['layoutCompatible']:need(mapping['headerLines']==1 and mapping['misplacedBlankLines']==mapping['unknownLines']==mapping['misplacedStatus0TrailerLines']==0 and mapping['layout'] in {'compact','separated','mixed'})
        else:need(mapping['layout']=='unsupported')
    validate_mapping_rows(value['nonRecordMappingRows'],mapping)
    s=value['sdk'];need(s['state'] in SDK_STATES)
    for key in ['packagesMatch','materialProjectionMatches','generatedComplete']:need(s[key] is None or type(s[key]) is bool)
    need(s['entries'] is None or integer(s['entries']))
    if s['counts'] is not None:need(type(s['counts']) is dict and set(s['counts'])==CATEGORIES and all(integer(v) for v in s['counts'].values()) and sum(s['counts'].values())==s['entries'])
    need(value['generation']['state'] in GEN_STATES and value['validation']['state'] in VALIDATION_STATES)
    for section,fields in [('generation',{'toolIdentities':18,'removedOutputs':51,'completedGenerators':17,'freshFormats':13}),('validation',{'completedValidators':37,'finalGeneratedOutputs':51})]:
        for key,maximum in fields.items():need(value[section][key] is None or integer(value[section][key],maximum))
        need(hash_value(value[section]['errorSha256']))
    need(len(json.dumps(value,sort_keys=True,separators=(',',':')).encode())<=8192)
    return value

def catalog(expected,apt):
    result=[]
    def add(stage,label,commands):result.append({'id':len(result),'stage':stage,'label':label,'commands':commands})
    add('apt','original-offline-sdk-build-dep',[apt])
    for requested in d.KNOWN_PROGRAMS:
        leaf,_=d.expected_leaf(requested,expected);aliases={leaf}
        for original,merged in [('/bin/','/usr/bin/'),('/sbin/','/usr/sbin/')]:
            if leaf.startswith(merged):
                alias=original+leaf[len(merged):]
                try:other,_=d.expected_leaf(alias,expected)
                except (KeyError,ValueError):continue
                if other==leaf:aliases.add(alias)
        add('ownership','sdk-package-owner-'+Path(requested).name,[['/usr/bin/dpkg-query','--search','--',query] for query in sorted(aliases)])
    add('mapping','sdk-effective-format-mapping',[['/usr/bin/fmtutil-sys','--listcfg']])
    commands=[(['/usr/bin/fc-cache','--force','--system-only'],'fontconfig'),(['/usr/sbin/ldconfig','--ignore-aux-cache'],'ldconfig')]
    commands += [(['/usr/bin/fmtutil-sys','--byfmt',name],'format-'+name) for name in sorted(d.FORMAT_MAP)]
    commands += [(['/usr/bin/updmap-sys'],'fontmaps'),(['/usr/bin/mktexlsr','/var/lib/texmf'],'filename-index')]
    for command,label in commands:add('generator','sdk-regenerate-'+label,[command])
    fonts=[path for path in d.d.KNOWN_MODES if path.startswith('/var/cache/fontconfig/')]
    commands=[(['/usr/bin/fc-list','--format=%{file}\\n'],'font-inputs')]
    commands += [(['/usr/bin/fc-cat',path],'font-cache-'+str(index)) for index,path in enumerate(fonts)]
    commands += [(['/usr/sbin/ldconfig','--print-cache'],'loader-cache')]
    commands += [(['/usr/bin/kpsewhich','--engine='+entry['lookupEngine'],'--format='+('base' if entry['extension']=='.base' else 'fmt'),Path(entry['outputPath']).name],'format-lookup-'+name) for name,entry in sorted(d.FORMAT_MAP.items())]
    for command,label in commands:add('validator','sdk-validate-'+label,[command])
    need(len(result)==74 and len({row['label'] for row in result})==74)
    return result

def error_hash(value):
    need(value is None or type(value) is str and len(value)<=2000)
    return None if value is None else digest(value.encode())

def journal(raw,commands):
    need(type(raw) is bytes and len(raw)<=MAX_JOURNAL,'journal-refused')
    rows=raw.splitlines(keepends=True);need(len(rows)<=148,'journal-refused')
    summary=empty()['journal'];summary.update(state='complete-prefix',requested=0,terminals=0,terminalZero=0,terminalNonzero=0,terminalUnknown=0)
    pending=None;terminals={};partial=bool(rows and not rows[-1].endswith(b'\n'))
    if partial:rows=rows[:-1]
    for position,raw_row in enumerate(rows):
        need(raw_row.endswith(b'\n') and len(raw_row)<=65536,'journal-refused')
        row=json.loads(raw_row);need(type(row) is dict,'journal-refused')
        index=summary['terminals'];need(index<len(commands),'journal-refused');entry=commands[index]
        need(row.get('label')==entry['label'] and row.get('command') in entry['commands'] and row.get('cwd')=='/work','journal-refused')
        keys={'label','command','cwd','state'}|({'schemaVersion','elapsedSeconds','exitCode'} if index==0 else set())
        if row.get('state')=='requested':
            need(pending is None and set(row)==keys,'journal-refused')
            if index==0:need(type(row['schemaVersion']) is int and row['schemaVersion']==1 and row['elapsedSeconds']==0 and type(row['elapsedSeconds']) is int and row['exitCode'] is None,'journal-refused')
            pending=row;summary['requested']+=1;summary['lastRequested']={'id':index,'stage':entry['stage']}
            continue
        terminal_keys=keys|{'elapsedSeconds','exitCode','signal','terminalObserved'}|({'stdoutBytesRetained','stdoutSha256','stdoutComplete','error'} if index else set())
        need(row.get('state')=='terminal' and pending is not None and set(row)==terminal_keys,'journal-refused')
        for key in ['label','command','cwd']:need(row[key]==pending[key],'journal-refused')
        if index==0:need(type(row['schemaVersion']) is int and row['schemaVersion']==1,'journal-refused')
        need(number(row['elapsedSeconds']) and type(row['terminalObserved']) is bool,'journal-refused')
        code,signal=row['exitCode'],row['signal'];need((code is None or integer(code,255)) and (signal is None or type(signal) is int and 1<=signal<=255),'journal-refused')
        need((code is not None)+(signal is not None)==int(row['terminalObserved']),'journal-refused')
        if index:
            need(integer(row['stdoutBytesRetained'],d.STDOUT_BYTES) and type(row['stdoutSha256']) is str and hash_value(row['stdoutSha256']) and type(row['stdoutComplete']) is bool,'journal-refused')
            err=error_hash(row['error']);need((err is None)==row['stdoutComplete'],'journal-refused')
        else:need(row['terminalObserved'] is True,'journal-refused');err=None
        detail={'id':index,'stage':entry['stage'],'terminalObserved':row['terminalObserved'],'exitCode':code,'signal':signal,'elapsedSeconds':row['elapsedSeconds'],
                'stdoutComplete':row.get('stdoutComplete'),'stdoutSha256':row.get('stdoutSha256'),'errorSha256':err}
        terminals[index]=row;summary['lastTerminal']=detail;summary['terminals']+=1;pending=None
        name='terminalUnknown' if not row['terminalObserved'] else 'terminalZero' if code==0 else 'terminalNonzero';summary[name]+=1
        if code!=0 or err is not None:need(position==len(rows)-1 and not partial,'journal-refused')
    summary['state']='partial' if partial else 'pending' if pending is not None else 'complete' if summary['terminals']==74 else 'complete-prefix'
    if not raw:summary['state']='partial'
    return summary,terminals

def comparison(value):
    need(type(value) is dict and value.get('policy')==d.d.POLICY and value.get('state')=='data-only-software-and-generated-state-comparison','comparison-refused')
    counts=value['counts'];need(type(counts) is dict and set(counts)==CATEGORIES and all(integer(v) for v in counts.values()),'comparison-refused')
    need(integer(value['entries']) and sum(counts.values())==value['entries'] and type(value['categories']) is dict and set(value['categories'])==CATEGORIES,'comparison-refused')
    need(all(type(value['categories'][key]) is list and len(value['categories'][key])==counts[key] for key in CATEGORIES),'comparison-refused')
    for key in ['installedPackageInventoryMatches','completeGeneratedInventory','materialProjectionMatches']:need(type(value[key]) is bool,'comparison-refused')
    size=value['generatedBytes'];need(type(size) is dict and set(size)=={'expected','observed','aggregateLimit'} and all(integer(n,2**40) for n in size.values()) and size['aggregateLimit']==d.d.AGGREGATE_LIMIT,'comparison-refused')
    missing=value['missingGeneratedPaths'];need(type(missing) is list and len(missing)<=51 and len(set(missing))==len(missing) and set(missing)<=set(d.d.KNOWN_MODES),'comparison-refused')
    need(value['completeGeneratedInventory']==(not missing and counts['generatedState']==51),'comparison-refused')
    expected=value['installedPackageInventoryMatches'] and value['completeGeneratedInventory'] and max(size['expected'],size['observed'])<=size['aggregateLimit'] and counts['unresolvedMaterial']==0
    need(value['materialProjectionMatches']==expected,'comparison-refused')
    return {'entries':value['entries'],'counts':counts,'packagesMatch':value['installedPackageInventoryMatches'],'materialProjectionMatches':value['materialProjectionMatches'],'generatedComplete':value['completeGeneratedInventory']}

def collect(output,environment,read_json,file_pin):
    value=empty()
    try:
        temporary=Path(environment['RUNNER_TEMP']);need(temporary.is_absolute() and temporary==temporary.resolve() and output==temporary/'gcc-sdk-reconstruction','provenance-refused')
        if not output.exists():return value
        need(output.is_dir() and not output.is_symlink(),'provenance-refused')
        if not (output/'ADMISSION.json').exists():return value
        root_info=output.stat();admission=read_json(output/'ADMISSION.json',MAX_JSON);carrier=read_json(output/'SDK-CARRIER.json',MAX_JSON);attempt=read_json(output/'ATTEMPT.json',MAX_JSON)
        selected=admission['resources']['context'];clock=admission['service']['clock']
        for key in ['GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB']:need(type(environment[key]) is str and selected[key]==environment[key],'provenance-refused')
        need(re.fullmatch('[a-f0-9]{40}',environment['GITHUB_SHA']) and re.fullmatch('[1-9][0-9]*',environment['GITHUB_RUN_ID']) and re.fullmatch('[1-9][0-9]*',environment['GITHUB_RUN_ATTEMPT']) and environment['GITHUB_JOB']==sdk.h.capacity.base.JOB,'provenance-refused')
        need(type(clock['runId']) is int and clock['runId']==int(environment['GITHUB_RUN_ID']) and type(clock['runAttempt']) is int and clock['runAttempt']==int(environment['GITHUB_RUN_ATTEMPT']) and clock['headSha']==environment['GITHUB_SHA'] and carrier['source']['headSha']==environment['GITHUB_SHA'],'provenance-refused')
        need(re.fullmatch('[a-f0-9]{64}',admission['container']['ownedContainer']) and attempt['nativePhase']=='sdk-reconstruction','provenance-refused')
        start=(output/'ADMISSION.json').stat().st_mtime_ns;end=(output/'ATTEMPT.json').stat().st_mtime_ns
        need(start<=end<=(output/'SDK-CARRIER.json').stat().st_mtime_ns,'stale-record')
        def bound(path,maximum=MAX_JSON):
            before=path.lstat();need(stat.S_ISREG(before.st_mode) and not path.is_symlink() and before.st_uid==root_info.st_uid and before.st_dev==root_info.st_dev and start<=before.st_mtime_ns<=end,'stale-record')
            pin=file_pin(path,maximum);return pin
        root=output/'checkpoint/CHECKPOINT-ROOT.json';need(file_pin(root,MAX_JSON)==sdk.PREDECESSOR['members']['CHECKPOINT-ROOT.json'],'provenance-refused')
        typed=read_json(root,MAX_JSON);original_path=output/'predecessor/__carrier_work/external-sdk-before.json';original=read_json(original_path,MAX_EXPANDED)
        need(digest(sdk.stage.canonical(original))==typed['externalSdkSha256']==sdk.PREDECESSOR['externalSdkSha256'],'provenance-refused')
        expected=d.d.material.inventory(original);policy=json.loads((HERE/'gcc-sdk-receipt-policy.v1.json').read_bytes())
        commands=catalog(expected,policy['originalOfflineAptCommand']);observations=output/'observations'
        need(observations.is_dir() and not observations.is_symlink(),'provenance-refused')
        terminal={}
        path=observations/FILES['journal']
        if path.exists():
            pin=bound(path,MAX_JOURNAL);raw=path.read_bytes();need(len(raw)==pin['bytes'] and digest(raw)==pin['sha256'],'journal-refused')
            value['hashes']['journal']=pin['sha256'];value['journal'],terminal=journal(raw,commands)
        for key in ['sdk','generation','validation']:
            path=observations/FILES[key]
            if not path.exists():continue
            pin=bound(path);record=read_json(path,MAX_JSON);value['hashes'][key]=pin['sha256'];need(type(record) is dict)
            if key=='sdk':
                need(record['state'] in SDK_STATES-{'unobserved'} and type(record['packageInventoryMatches']) is bool)
                path=observations/FILES['comparison'];pin=bound(path);need(pin=={name:record['comparison'][name] for name in ['bytes','sha256']},'comparison-refused')
                with gzip.open(path,'rb') as stream:raw=stream.read(MAX_EXPANDED+1)
                need(len(raw)<=MAX_EXPANDED and len(raw)==record['comparison']['expandedBytes'] and digest(raw)==record['comparison']['expandedSha256'],'comparison-refused')
                projected=comparison(json.loads(raw));need(record['comparisonCounts']==projected['counts'] and record['packageInventoryMatches']==projected['packagesMatch'],'comparison-refused')
                value['sdk']={'state':record['state'],**projected};value['hashes']['comparison']=pin['sha256']
            elif key=='generation':
                need(record['state'] in GEN_STATES-{'unobserved'});completed=record['generatorCommands'];need(type(completed) is list and len(completed)<=17)
                for index,row in enumerate(completed):need(row==terminal.get(index+20) and row['exitCode']==0 and row['stdoutComplete'] is True)
                need(type(record['toolIdentities']) is dict and set(record['toolIdentities'])<=set(d.KNOWN_PROGRAMS))
                need(type(record['newlyGeneratedOutputs']) is dict and set(record['newlyGeneratedOutputs'])<=set(row['outputPath'] for row in d.FORMAT_MAP.values()))
                removed=record['removedOwnedFreshOutputs'];need(type(removed) is list and (not removed or removed==list(d.d.KNOWN_MODES)))
                if 'effectiveMappingNativeOutput' in record or 'effectiveMappingCommand' in record:
                    need(type(record.get('effectiveMappingNativeOutput')) is str and record.get('effectiveMappingCommand')==terminal.get(19) and 19 in terminal)
                    witness=terminal[19];raw=record['effectiveMappingNativeOutput'].encode()
                    need(witness['exitCode']==0 and witness['terminalObserved'] is True and witness['stdoutComplete'] is True and len(raw)==witness['stdoutBytesRetained'] and digest(raw)==witness['stdoutSha256'])
                    _,shape=d.mapping_layout(raw);shape['sourceBound']=True;value['mapping']=shape
                    projected_rows=unrecognized_mapping_rows(raw);projected_rows['sourceBound']=True;value['nonRecordMappingRows']=projected_rows
                value[key]={'state':record['state'],'toolIdentities':len(record['toolIdentities']),'removedOutputs':len(removed),'completedGenerators':len(completed),'freshFormats':len(record['newlyGeneratedOutputs']),'errorSha256':error_hash(record.get('error'))}
            else:
                need(record['state'] in VALIDATION_STATES-{'unobserved'});events=record['validators'];need(type(events) is list and len(events)<=37)
                for index,event in enumerate(events):need(type(event) is dict and event['command']==terminal.get(index+37) and event['command']['exitCode']==0 and event['command']['stdoutComplete'] is True)
                final=record.get('finalGeneratedIdentities',{});need(type(final) is dict and set(final)<=set(d.d.KNOWN_MODES))
                value[key]={'state':record['state'],'completedValidators':len(events),'finalGeneratedOutputs':len(final),'errorSha256':error_hash(record.get('error'))}
        value['state']='unobserved' if not any(value['hashes'].values()) else 'incomplete' if value['journal']['state'] in {'unobserved','pending','partial'} else 'observed'
        last=value['journal']['lastTerminal']
        if value['state']=='observed' and last is not None:
            if last['exitCode'] not in [None,0] or last['signal'] is not None:value['cause']='recorded-command-nonzero'
            elif last['errorSha256'] is not None:value['cause']='recorded-wrapper-error'
        if value['sdk']['state']!='unobserved':
            need(0 in terminal and terminal[0]['exitCode']==0 and terminal[0]['terminalObserved'] is True)
            if value['sdk']['materialProjectionMatches'] is False:need(value['journal']['requested']==1)
        if value['generation']['state']!='unobserved':need(value['sdk']['materialProjectionMatches'] is True)
        if value['validation']['state']!='unobserved':
            need(value['generation']['state']=='derived-sdk-outputs-generated-not-yet-finally-validated' and
                 value['generation']['completedGenerators']==17 and value['generation']['freshFormats']==13 and value['generation']['errorSha256'] is None)
        if value['sdk']['state']=='sdk-material-reconstructed-and-physically-verified':
            need(value['journal']['state']=='complete' and value['validation']['state']=='derived-sdk-outputs-finally-validated' and
                 value['validation']['completedValidators']==37 and value['validation']['finalGeneratedOutputs']==51 and value['validation']['errorSha256'] is None)
        if value['state']=='observed':
            if value['cause']=='unestablished' and value['sdk']['materialProjectionMatches'] is False:value['cause']='recorded-material-comparison-false'
            if value['cause']=='unestablished' and value['generation']['errorSha256'] is not None:value['cause']='generation-reported-error'
            if value['cause']=='unestablished' and value['validation']['errorSha256'] is not None:value['cause']='validation-reported-error'
        return validate(value)
    except BaseException as error:
        value=empty();value.update(state='invalid',errorId=error.identifier if type(error) is Bad and error.identifier in ERRORS else 'record-unavailable')
        return validate(value)
