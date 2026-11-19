"""Fixed original-SDK generated-state production and validation, operator-only.

Called only by the reviewed original SDK body after its authenticated package,
software and input-time prechecks. No CLI, import execution, caller-selected
command, historical cache body copy or GCC project target is provided.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import selectors
import signal
import subprocess
import sys
import time


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


d=load('gcc-sdk-derived.py')
stage=load('gcc-hosted-stage.py')
require=stage.require
KNOWN_PROGRAMS=('/usr/bin/fc-cache','/usr/bin/fc-cat','/usr/bin/fc-list','/usr/sbin/ldconfig',
 '/usr/bin/fmtutil-sys','/usr/bin/fmtutil','/usr/bin/updmap-sys','/usr/bin/updmap','/usr/bin/mktexlsr',
 '/usr/bin/kpsewhich','/usr/bin/luahbtex','/usr/bin/luatex','/usr/bin/mf-nowin','/usr/bin/pdftex','/usr/bin/tex',
 '/usr/bin/perl','/usr/bin/dash','/usr/bin/dpkg-query')
COMMAND_SECONDS=120
TOTAL_SECONDS=600
STDOUT_BYTES=16*1024**2


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def file_pin(path):
    require(path.is_absolute() and path.resolve()==path and not path.is_symlink(),'Physical generated SDK file required')
    before=path.lstat();require(path.is_file() and 0<=before.st_size<=d.MEMBER_LIMIT,'Bounded physical SDK file required')
    sha=hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            raw=stream.read(65536)
            if not raw:break
            sha.update(raw)
    after=path.lstat()
    require((before.st_mode,before.st_uid,before.st_gid,before.st_size,before.st_mtime_ns,before.st_ino)==
            (after.st_mode,after.st_uid,after.st_gid,after.st_size,after.st_mtime_ns,after.st_ino),'SDK file changed while hashing')
    return {'path':str(path),'kind':'file','uid':after.st_uid,'gid':after.st_gid,'mode':after.st_mode & 0o7777,
            'mtimeNs':after.st_mtime_ns,'bytes':after.st_size,'sha256':sha.hexdigest()}


def generated_pins():
    pins={path:file_pin(Path(path)) for path in d.KNOWN_MODES}
    require(all(d.typed_pair(path,row,row) for path,row in pins.items()) and
            sum(row['bytes'] for row in pins.values())<=d.AGGREGATE_LIMIT,'Generated SDK output identity/aggregate differs')
    return pins


def expected_leaf(path,rows):
    current=path;chain=[]
    for step in range(16):
        parts=Path(current).parts;changed=False
        for index in range(1,len(parts)):
            prefix='/'+('/'.join(parts[1:index+1]));row=rows.get(prefix)
            require(row is not None,'Original generator link ancestry missing: '+prefix)
            if row['kind']=='symlink':
                chain.append(row)
                target=row['target'];target=target if target.startswith('/') else posixpath.join(posixpath.dirname(prefix),target)
                current=posixpath.normpath(posixpath.join(target,*parts[index+1:]));changed=True;break
        if changed:continue
        row=rows[current];require(row['kind']=='file','Original generator executable missing');return current,[*chain,row]
    raise ValueError('Original generator symlink chain bound')


def package_rows(raw):
    result={}
    for line in raw.decode().splitlines():
        fields=line.split('\t');require(len(fields)==3 and all(fields),'Original package record shape differs')
        key=(fields[0],fields[2]);require(key not in result,'Duplicate original package identity')
        result[key]=fields[1]
    return result


def run(command,label,records,deadline):
    require(command[0] in KNOWN_PROGRAMS and all(isinstance(arg,str) and '\0' not in arg for arg in command),
            'Unknown fixed SDK generator/validator command')
    remaining=deadline-time.monotonic();require(remaining>0,'Generated SDK operation deadline')
    started=time.monotonic();request={'label':label,'command':command,'cwd':'/work','state':'requested'}
    with records.open('ab') as sink:sink.write(canonical(request)+b'\n');sink.flush();os.fsync(sink.fileno())
    child=None;selector=None;limit=min(COMMAND_SECONDS,remaining);output=bytearray();error=None;code=None;cleanup_errors=[]
    try:
        child=subprocess.Popen(command,cwd='/work',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
        selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
        while selector.get_map():
            require(time.monotonic()-started<limit,'SDK tool timeout')
            for key,_ in selector.select(timeout=min(0.25,max(0,limit-(time.monotonic()-started)))):
                chunk=os.read(key.fileobj.fileno(),65536)
                if not chunk:selector.unregister(key.fileobj);continue
                require(len(output)+len(chunk)<=STDOUT_BYTES,'SDK tool stdout retention bound')
                output.extend(chunk);sys.stdout.buffer.write(chunk);sys.stdout.buffer.flush()
        # EOF is not a terminal process observation. Waiting for the child
        # consumes the SAME command/whole-operation budget as reading its pipe.
        remaining_wait=min(limit-(time.monotonic()-started),deadline-time.monotonic())
        require(remaining_wait>0,'SDK tool timeout')
        try:code=child.wait(timeout=remaining_wait)
        except subprocess.TimeoutExpired:raise ValueError('SDK tool timeout')
        require(time.monotonic()-started<=limit and time.monotonic()<=deadline,'SDK tool timeout')
    except BaseException as caught:
        error=caught
        if child is not None:
            # A zero-exited wrapper may leave descendants holding its pipe.
            # Terminate the owned group even when the direct child exited.
            if child.returncode is None:
                # The retained unreaped Popen child reserves this session leader PID.
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                except OSError as cleanup_error:
                    cleanup_errors.append({'operation':'signal-group','kind':type(cleanup_error).__name__,'errno':cleanup_error.errno})
                try:code=child.wait(timeout=5)
                except (OSError,subprocess.TimeoutExpired) as cleanup_error:
                    cleanup_errors.append({'operation':'wait-child','kind':type(cleanup_error).__name__,'errno':getattr(cleanup_error,'errno',None)})
            else:
                # A late deadline refusal after wait must not signal a reused PID/PGID.
                code=child.returncode
                cleanup_errors.append({'operation':'signal-group','kind':'LeaderAlreadyReaped','errno':None})

    finally:
        if selector is not None:selector.close()
        if child is not None and child.stdout is not None:child.stdout.close()
    terminal={**request,'state':'terminal','elapsedSeconds':time.monotonic()-started,'exitCode':code if code is not None and code>=0 else None,
              'signal':-code if code is not None and code<0 else None,'terminalObserved':code is not None,'stdoutBytesRetained':len(output),
              'stdoutSha256':hashlib.sha256(output).hexdigest(),'stdoutComplete':error is None,'error':str(error)[:1000] if error else None}
    if cleanup_errors:terminal['error']=str(error)[:500]+'; cleanup='+canonical(cleanup_errors).decode()[:480]
    with records.open('ab') as sink:sink.write(canonical(terminal)+b'\n');sink.flush();os.fsync(sink.fileno())
    if error is not None:raise error
    require(code==0,'SDK generator/validator failed: '+label)
    return bytes(output),terminal


FORMAT_MAP = {'dvilualatex': {'configuredEngine': 'luatex',
                 'extension': '.fmt',
                 'format': 'dvilualatex',
                 'generatorArguments': ['dvilualatex.ini'],
                 'hyphenInput': 'language.dat,language.dat.lua',
                 'lookupEngine': 'luatex',
                 'outputPath': '/var/lib/texmf/web2c/luatex/dvilualatex.fmt',
                 'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-latex-base.cnf',
                 'sourceConfigSha256': '93a51404983a34aa93d1057cdc2573f571b83ad46a19d411949fefb3b2744f47'},
 'dviluatex': {'configuredEngine': 'luatex',
               'extension': '.fmt',
               'format': 'dviluatex',
               'generatorArguments': ['dviluatex.ini'],
               'hyphenInput': 'language.def,language.dat.lua',
               'lookupEngine': 'luatex',
               'outputPath': '/var/lib/texmf/web2c/luatex/dviluatex.fmt',
               'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
               'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'etex': {'configuredEngine': 'pdftex',
          'extension': '.fmt',
          'format': 'etex',
          'generatorArguments': ['-translate-file=cp227.tcx', '*etex.ini'],
          'hyphenInput': 'language.def',
          'lookupEngine': 'pdftex',
          'outputPath': '/var/lib/texmf/web2c/pdftex/etex.fmt',
          'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
          'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'latex': {'configuredEngine': 'pdftex',
           'extension': '.fmt',
           'format': 'latex',
           'generatorArguments': ['-translate-file=cp227.tcx', '*latex.ini'],
           'hyphenInput': 'language.dat',
           'lookupEngine': 'pdftex',
           'outputPath': '/var/lib/texmf/web2c/pdftex/latex.fmt',
           'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-latex-base.cnf',
           'sourceConfigSha256': '93a51404983a34aa93d1057cdc2573f571b83ad46a19d411949fefb3b2744f47'},
 'luahbtex': {'configuredEngine': 'luahbtex',
              'extension': '.fmt',
              'format': 'luahbtex',
              'generatorArguments': ['luatex.ini'],
              'hyphenInput': 'language.def,language.dat.lua',
              'lookupEngine': 'luahbtex',
              'outputPath': '/var/lib/texmf/web2c/luahbtex/luahbtex.fmt',
              'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
              'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'lualatex': {'configuredEngine': 'luahbtex',
              'extension': '.fmt',
              'format': 'lualatex',
              'generatorArguments': ['lualatex.ini'],
              'hyphenInput': 'language.dat,language.dat.lua',
              'lookupEngine': 'luahbtex',
              'outputPath': '/var/lib/texmf/web2c/luahbtex/lualatex.fmt',
              'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-latex-base.cnf',
              'sourceConfigSha256': '93a51404983a34aa93d1057cdc2573f571b83ad46a19d411949fefb3b2744f47'},
 'luatex': {'configuredEngine': 'luatex',
            'extension': '.fmt',
            'format': 'luatex',
            'generatorArguments': ['luatex.ini'],
            'hyphenInput': 'language.def,language.dat.lua',
            'lookupEngine': 'luatex',
            'outputPath': '/var/lib/texmf/web2c/luatex/luatex.fmt',
            'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
            'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'mf': {'configuredEngine': 'mf-nowin',
        'extension': '.base',
        'format': 'mf',
        'generatorArguments': ['-translate-file=cp227.tcx', 'mf.ini'],
        'hyphenInput': '-',
        'lookupEngine': 'metafont',
        'outputPath': '/var/lib/texmf/web2c/metafont/mf.base',
        'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
        'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'mptopdf': {'configuredEngine': 'pdftex',
             'extension': '.fmt',
             'format': 'mptopdf',
             'generatorArguments': ['-translate-file=cp227.tcx', 'mptopdf.tex'],
             'hyphenInput': '-',
             'lookupEngine': 'pdftex',
             'outputPath': '/var/lib/texmf/web2c/pdftex/mptopdf.fmt',
             'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-latex-base.cnf',
             'sourceConfigSha256': '93a51404983a34aa93d1057cdc2573f571b83ad46a19d411949fefb3b2744f47'},
 'pdfetex': {'configuredEngine': 'pdftex',
             'extension': '.fmt',
             'format': 'pdfetex',
             'generatorArguments': ['-translate-file=cp227.tcx', '*pdfetex.ini'],
             'hyphenInput': 'language.def',
             'lookupEngine': 'pdftex',
             'outputPath': '/var/lib/texmf/web2c/pdftex/pdfetex.fmt',
             'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
             'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'pdflatex': {'configuredEngine': 'pdftex',
              'extension': '.fmt',
              'format': 'pdflatex',
              'generatorArguments': ['-translate-file=cp227.tcx', '*pdflatex.ini'],
              'hyphenInput': 'language.dat',
              'lookupEngine': 'pdftex',
              'outputPath': '/var/lib/texmf/web2c/pdftex/pdflatex.fmt',
              'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-latex-base.cnf',
              'sourceConfigSha256': '93a51404983a34aa93d1057cdc2573f571b83ad46a19d411949fefb3b2744f47'},
 'pdftex': {'configuredEngine': 'pdftex',
            'extension': '.fmt',
            'format': 'pdftex',
            'generatorArguments': ['-translate-file=cp227.tcx', '*pdfetex.ini'],
            'hyphenInput': 'language.def',
            'lookupEngine': 'pdftex',
            'outputPath': '/var/lib/texmf/web2c/pdftex/pdftex.fmt',
            'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
            'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'},
 'tex': {'configuredEngine': 'tex',
         'extension': '.fmt',
         'format': 'tex',
         'generatorArguments': ['tex.ini'],
         'hyphenInput': '-',
         'lookupEngine': 'tex',
         'outputPath': '/var/lib/texmf/web2c/tex/tex.fmt',
         'sourceConfigPath': '/var/lib/tex-common/fmtutil-cnf/texlive/texlive-base.cnf',
         'sourceConfigSha256': '2aac945fee9cf297b50cb58d6150e31a251d88333bc609bfa75acf46b50875b5'}}


MAPPING_STATUS0_TRAILER='fmtutil [INFO]: exiting with status 0'
MAPPING_EMPTY_FALSE_TRAILER='fmtutil [INFO]: exiting with status '
MAPPING_SUCCESS_TRAILERS={MAPPING_STATUS0_TRAILER,MAPPING_EMPTY_FALSE_TRAILER}

def empty_mapping_shape():
    return {'state':'unobserved','layout':'unobserved','separatorScope':'document-and-complete-record-boundaries','sourceBound':False,'stdoutSha256':None,'layoutCompatible':None,
            **{key:None for key in ['totalLines','blankLines','headerLines','prefixLines','bodyLines','boundaryBlankLines',
                                   'documentBlankLines','misplacedBlankLines','unknownLines','recognizedRecords','unknownRecords','duplicateRecords',
                                   'missingRecords','semanticMismatchRecords','separatorBoundaries','status0TrailerLines','misplacedStatus0TrailerLines']}}


def mapping_fields(block):
    if len(block)!=3:return None,None,None
    return (re.fullmatch(r'([A-Za-z0-9_-]+) \(engine=([A-Za-z0-9_-]+)\) (enabled|disabled)',block[0]),
            re.fullmatch(r'  hyphen=(.*), args=(.*)',block[1]),
            re.fullmatch(r'  origin=(/[^\0\r\n]+)',block[2]))


def mapping_layout(raw):
    """Local parser blocks plus CLOSED shape counts; never export the blocks.

    Only exact empty lines at the document boundary after the unique header
    or AFTER a complete three-line record are separators.
    Either exact optional success trailer is accepted once, last nonempty, only
    after all13 matching complete records. Other nonempty rows are not ignored.
    Blank lines within fields are never discarded.
    Config/code identity remains the responsibility of parse_mapping below.
    """
    require(type(raw) is bytes and len(raw)<=STDOUT_BYTES,'Bounded native fmtutil listing required')
    shape=empty_mapping_shape();shape.update(stdoutSha256=hashlib.sha256(raw).hexdigest(),layout='unsupported',layoutCompatible=False)
    try:lines=raw.decode().splitlines()
    except UnicodeDecodeError:shape['state']='invalid';return [],shape
    headers=[i for i,line in enumerate(lines) if line=='List of all formats:']
    shape.update(state='observed',totalLines=len(lines),blankLines=sum(line=='' for line in lines),headerLines=len(headers))
    if len(headers)!=1:return [],shape
    body=lines[headers[0]+1:];blocks=[];seen=set();boundary=False;document=True;gap=0
    shape.update(prefixLines=headers[0],bodyLines=len(body),boundaryBlankLines=0,documentBlankLines=0,misplacedBlankLines=0,unknownLines=0,
                 recognizedRecords=0,unknownRecords=0,duplicateRecords=0,missingRecords=len(FORMAT_MAP),semanticMismatchRecords=0,separatorBoundaries=0,
                 status0TrailerLines=0,misplacedStatus0TrailerLines=sum(line in MAPPING_SUCCESS_TRAILERS for line in lines))
    offset=0
    while offset<len(body):
        if body[offset]=='':
            shape['documentBlankLines' if document else 'boundaryBlankLines' if boundary else 'misplacedBlankLines']+=1
            if boundary:gap+=1
            offset+=1;continue
        document=False
        if (body[offset] in MAPPING_SUCCESS_TRAILERS and boundary and len(blocks)==len(FORMAT_MAP) and seen==set(FORMAT_MAP) and
            shape['recognizedRecords']==len(FORMAT_MAP) and shape['unknownRecords']==shape['duplicateRecords']==shape['semanticMismatchRecords']==0 and
            shape['unknownLines']==shape['misplacedBlankLines']==0 and all(line=='' for line in body[offset+1:])):
            shape['status0TrailerLines']+=1;shape['misplacedStatus0TrailerLines']-=1;offset+=1;continue
        block=body[offset:offset+3];header,details,origin=mapping_fields(block)
        if header is not None and details is not None and origin is not None:
            if blocks and gap:shape['separatorBoundaries']+=1
            blocks.append(block);name,engine,status=header.groups()
            if name in seen:shape['duplicateRecords']+=1
            seen.add(name)
            if name in FORMAT_MAP:
                shape['recognizedRecords']+=1;expected=FORMAT_MAP[name]
                if not (engine==expected['configuredEngine'] and status=='enabled' and details[1]==expected['hyphenInput'] and details[2].split()==expected['generatorArguments']):shape['semanticMismatchRecords']+=1
            else:shape['unknownRecords']+=1
            boundary=True;gap=0;offset+=3
        else:
            shape['unknownLines']+=1;boundary=False;gap=0;offset+=1
    shape['missingRecords']=len(set(FORMAT_MAP)-seen)
    require(3*len(blocks)+shape['boundaryBlankLines']+shape['documentBlankLines']+shape['misplacedBlankLines']+shape['unknownLines']+shape['status0TrailerLines']==len(body),'Native fmtutil shape counts do not reconcile')
    shape['layoutCompatible']=shape['misplacedBlankLines']==shape['unknownLines']==shape['misplacedStatus0TrailerLines']==0
    if shape['layoutCompatible']:
        separated=shape['separatorBoundaries'];shape['layout']='compact' if not separated else 'separated' if separated==len(blocks)-1 else 'mixed'
    return blocks,shape


def parse_mapping(raw,expected_rows):
    for entry in FORMAT_MAP.values():
        path=entry['sourceConfigPath'];row=expected_rows.get(path)
        require(row is not None and row['kind']=='file' and row['sha256']==entry['sourceConfigSha256'],
                'Pinned original format configuration identity differs')
        require(file_pin(Path(path))==row,'Physical original format configuration differs')
    blocks,shape=mapping_layout(raw)
    require(shape['headerLines']==1,'Exact native fmtutil mapping header required')
    require(shape['layoutCompatible'] and len(blocks)==len(FORMAT_MAP),'Complete13-format native mapping required')
    result={}
    for block in blocks:
        header,details,origin=mapping_fields(block)
        require(header is not None and details is not None and origin is not None,'Unsupported native fmtutil mapping entry')
        name,engine,status=header.groups();require(name in FORMAT_MAP and name not in result,'Unknown/duplicate original format')
        expected=FORMAT_MAP[name]
        require(engine==expected['configuredEngine'] and status=='enabled' and
                details[1]==expected['hyphenInput'] and details[2].split()==expected['generatorArguments'],
                'Original effective format engine/arguments/enablement differs: '+name)
        leaf,chain=expected_leaf(origin[1],expected_rows)
        require(leaf.startswith('/var/lib/texmf/fmtutil.cnf-'),'Unknown original fmtutil effective configuration origin')
        pin=file_pin(Path(leaf));require(pin==expected_rows[leaf],'Effective fmtutil configuration differs from original bytes/metadata')
        result[name]={'engine':engine,'hyphen':details[1],'arguments':details[2],'origin':origin[1],
                      'effectiveConfigIdentity':pin,'outputPath':expected['outputPath']}
    require(set(result)==set(FORMAT_MAP),'A selected original format is missing')
    return result


def ownership_index(expected,packages):
    wanted={};records={};identity_rows={}
    for requested in KNOWN_PROGRAMS:
        leaf,chain=expected_leaf(requested,expected)
        actual=Path(requested).resolve();require(str(actual)==leaf,'Original generator link target changed')
        pin=file_pin(actual);require(pin==expected[leaf] and pin['bytes']>0 and pin['mode'] & 0o111,'Original generator code bytes/owner/mode/time changed')
        aliases={leaf}
        for original,merged in [('/bin/','/usr/bin/'),('/sbin/','/usr/sbin/')]:
            if leaf.startswith(merged):
                alias=original+leaf[len(merged):]
                try:other,_=expected_leaf(alias,expected)
                except ValueError:continue
                if other==leaf:aliases.add(alias)
        wanted[requested]=(leaf,aliases)
        identity_rows[requested]={'requestedPath':requested,'physicalCode':pin,'originalLinkChain':chain}
    for path,row in expected.items():
        if not (path.startswith('/var/lib/dpkg/info/') and path.endswith('.list') and row['kind']=='file'):continue
        tag=Path(path).name[:-5]
        if ':' in tag:name,arch=tag.rsplit(':',1);keys=[(name,arch)]
        else:keys=[key for key in packages if key[0]==tag]
        require(len(keys)==1 and keys[0] in packages,'Unambiguous original package file-list identity required')
        actual=file_pin(Path(path));require(actual==row,'Original package file list differs')
        payload=Path(path).read_bytes();require(hashlib.sha256(payload).hexdigest()==row['sha256'],'Package list changed while reading')
        listed=set(payload.decode().splitlines())
        for requested,(leaf,aliases) in wanted.items():
            matches=sorted(listed & aliases)
            if matches:
                name,arch=keys[0]
                records.setdefault(requested,[]).append({'package':name,'architecture':arch,'version':packages[(name,arch)],
                    'packageFileListIdentity':actual,'registeredPaths':matches})
    require(set(records)==set(KNOWN_PROGRAMS),'A generator/validator lacks original package ownership')
    return {path:{**identity_rows[path],'originalPackageOwners':records[path]} for path in KNOWN_PROGRAMS}


def validate_ownership(identities,records,deadline):
    proof={}
    for requested,identity in identities.items():
        query=identity['originalPackageOwners'][0]['registeredPaths'][0]
        raw,terminal=run(['/usr/bin/dpkg-query','--search','--',query],'sdk-package-owner-'+Path(requested).name,records,deadline)
        expected={(r['package'],r['architecture']) for r in identity['originalPackageOwners']}
        owners=set()
        for line in raw.decode().splitlines():
            parts=line.split(': ',1);require(len(parts)==2 and parts[1]==query,'Unexpected exact package ownership response')
            tag=parts[0]
            if ':' in tag:name,arch=tag.rsplit(':',1);key=(name,arch)
            else:
                matches=[key for key in expected if key[0]==tag];require(len(matches)==1,'Ambiguous unqualified SDK package owner');key=matches[0]
            require(key in expected,'Generator package ownership changed');owners.add(key)
        require(owners,'Empty package ownership response is not a witness')
        proof[requested]={**identity,'ownershipQuery':terminal,'observedOwners':[list(value) for value in sorted(owners)]}
    return proof


def generate(expected_inventory,package_payload,output,records):
    require(output==Path('/controller/observations') and output.is_dir() and not output.is_symlink(),
            'Fixed original SDK observation mount required')
    expected=d.material.inventory(expected_inventory);packages=package_rows(package_payload)
    started=time.monotonic();deadline=started+TOTAL_SECONDS
    before=generated_pins()
    result={'schemaVersion':1,'policy':d.POLICY,'state':'derived-sdk-generation-incomplete','before':before,
            'originalPackageManifestSha256':hashlib.sha256(package_payload).hexdigest(),'toolIdentities':{},
            'effectiveMapping':{},'startedMonotonic':started,'removedOwnedFreshOutputs':[],
            'generatorCommands':[],'newlyGeneratedOutputs':{},'historicalCacheBodiesCopiedOrExamined':False,
            'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,'gateAComplete':False}
    try:
        identities=ownership_index(expected,packages)
        result['toolIdentities']=validate_ownership(identities,records,deadline)
        raw,mapping_terminal=run(['/usr/bin/fmtutil-sys','--listcfg'],'sdk-effective-format-mapping',records,deadline)
        result.update(effectiveMappingNativeOutput=raw.decode(),effectiveMappingCommand=mapping_terminal)
        result['effectiveMapping']=parse_mapping(raw,expected)
        ready=stage.external_inventory()
        ready_comparison=d.compare_software(expected_inventory,ready,hashlib.sha256(package_payload).hexdigest(),hashlib.sha256(package_payload).hexdigest())
        result['preGenerationInputComparison']={key:value for key,value in ready_comparison.items() if key!='categories'}
        require(ready_comparison['materialProjectionMatches'] and not ready_comparison['categories']['timestampOnlyMaterial'],
                'Generator metadata queries changed an original input identity/time before regeneration')
        # Preflight ALL51 physical outputs and identities before removing ANY.
        # They belong solely to this fresh owned SDK container layer. Historical
        # original cache bodies were not retained and are never restored/copied.
        require(generated_pins()==before,'Generated state changed before planned regeneration')
        for path in d.KNOWN_MODES:Path(path).unlink()
        require(all(not Path(path).exists() and not Path(path).is_symlink() for path in d.KNOWN_MODES),
                'Complete owned generated-output absence was not physically observed')
        result['removedOwnedFreshOutputs']=list(d.KNOWN_MODES)
        commands=[(['/usr/bin/fc-cache','--force','--system-only'],'fontconfig'),
                  (['/usr/sbin/ldconfig','--ignore-aux-cache'],'ldconfig')]
        commands += [(['/usr/bin/fmtutil-sys','--byfmt',name],'format-'+name) for name in sorted(FORMAT_MAP)]
        commands += [(['/usr/bin/updmap-sys'],'fontmaps'),(['/usr/bin/mktexlsr','/var/lib/texmf'],'filename-index')]
        for command,label in commands:
            _,terminal=run(command,'sdk-regenerate-'+label,records,deadline);result['generatorCommands'].append(terminal)
            if label.startswith('format-'):
                name=label[len('format-'):];path=FORMAT_MAP[name]['outputPath'];pin=file_pin(Path(path))
                require(d.typed_pair(path,pin,pin),'Exact fresh original format output missing/type/owner/mode differs')
                result['newlyGeneratedOutputs'][path]=pin
        result.update(state='derived-sdk-outputs-generated-not-yet-finally-validated',afterGeneration=generated_pins(),
                      generatedSeconds=time.monotonic()-started,remainingOperationSeconds=max(0,deadline-time.monotonic()))
        require(len(result['newlyGeneratedOutputs'])==13,'Every selected format must be freshly generated')
        return result
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:
        (output/'SDK-DERIVED-GENERATION.json').write_bytes(canonical(result))


def validate(expected_inventory,generation,output,records):
    require(generation['state']=='derived-sdk-outputs-generated-not-yet-finally-validated' and
            len(generation['newlyGeneratedOutputs'])==13,'Complete fresh native format generation required')
    expected=d.material.inventory(expected_inventory)
    deadline=generation['startedMonotonic']+TOTAL_SECONDS
    current=generated_pins();events=[];result={'schemaVersion':1,'state':'derived-sdk-final-validation-incomplete',
        'validators':events,'timestampWritesAfterValidation':False,'historicalCacheBodyEqualityClaimed':False,
        'originalGccTargetInvoked':False,'originalPhaseAdvanced':False,'gateAComplete':False}
    fonts=[path for path in d.KNOWN_MODES if path.startswith('/var/cache/fontconfig/')]
    commands=[(['/usr/bin/fc-list','--format=%{file}\\n'],'font-inputs',None)]
    commands += [(['/usr/bin/fc-cat',path],'font-cache-'+str(index),None) for index,path in enumerate(fonts)]
    commands += [(['/usr/sbin/ldconfig','--print-cache'],'loader-cache',None)]
    commands += [(['/usr/bin/kpsewhich','--engine='+entry['lookupEngine'],'--format='+('base' if entry['extension']=='.base' else 'fmt'),Path(entry['outputPath']).name],
                  'format-lookup-'+name,entry['outputPath']) for name,entry in sorted(FORMAT_MAP.items())]
    try:
        for command,label,expected_path in commands:
            before=current;raw,terminal=run(command,'sdk-validate-'+label,records,deadline)
            detail={}
            if label=='font-inputs':
                paths=raw.decode().splitlines();require(paths and len(paths)<=500000,'Nonempty bounded font input witness required')
                identities={}
                for path in set(paths):
                    require(path.startswith('/'),'Absolute font input path required')
                    leaf,_=expected_leaf(path,expected);pin=file_pin(Path(path).resolve())
                    require(pin==expected[leaf],'Validator selected a changed/unrecognized font input')
                    identities[path]=pin
                detail={'uniqueFontInputs':len(identities),'fontInputIdentities':identities}
            elif label=='loader-cache':
                require(raw.strip(),'Empty loader cache listing is not a validator witness')
                pin=file_pin(Path('/etc/ld.so.cache'))
                require(pin==expected['/etc/ld.so.cache'],'Selected loader cache must remain byte/metadata exact')
                detail={'originalLoaderCacheIdentity':pin}
            elif expected_path is not None:
                require(raw.decode().strip()==expected_path,'Native format lookup selected a missing/different exact output')
                pin=file_pin(Path(expected_path));require(d.typed_pair(expected_path,pin,pin),'Final format output identity differs')
                detail={'exactFormatPath':expected_path,'validatedIdentity':pin}
            current=generated_pins();changed=[path for path in current if current[path]!=before[path]]
            events.append({'command':terminal,'validation':detail,'changedGeneratedPaths':changed,
                           'beforeGeneratedStateSha256':hashlib.sha256(canonical(before)).hexdigest(),
                           'afterGeneratedStateSha256':hashlib.sha256(canonical(current)).hexdigest()})
            # fc-list is explicitly allowed to repair its own22 font caches.
            # The subsequent fc-cat calls validate those final cache bodies.
            require(not changed or label=='font-inputs' and set(changed)<=set(fonts),
                    'Unexpected validator state mutation; final retained state was not validated')
        require(time.monotonic()<=deadline,'Generated SDK operation deadline after final validators')
        result.update(state='derived-sdk-outputs-finally-validated',finalGeneratedIdentities=current,
                      actualAll13FreshFormatsValidated=True,allFinalValidatorsTerminalZero=True)
        return result
    except BaseException as error:
        result['error']=str(error)[:2000];raise
    finally:
        (output/'SDK-DERIVED-VALIDATION.json').write_bytes(canonical(result))


def verify_final_inventory(inventory,validation):
    require(validation['state']=='derived-sdk-outputs-finally-validated' and validation['actualAll13FreshFormatsValidated'] is True,
            'Actual complete final generated-state validation missing')
    rows=d.material.inventory(inventory)
    require(set(validation['finalGeneratedIdentities'])==set(d.KNOWN_MODES),'Exact final validated51-file set missing')
    for path,pin in validation['finalGeneratedIdentities'].items():
        require(rows.get(path)==pin,'Retained final inventory differs from actual validator hashes/modes: '+path)
    return {'exactFinalValidatorIdentitiesMatchRetainedInventory':True,'files':len(d.KNOWN_MODES),
            'historicalCacheBodyEqualityClaimed':False,'gateAComplete':False}
