"""Operator CI preparation for one pinned SDK; never run its upstream installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import platform
import posixpath
import shutil
import subprocess
import tempfile
import tarfile

MANIFEST=Path(__file__).with_name('python-ubuntu26-arm64.json')
PROBE="""import ast,bz2,ctypes,hashlib,json,lzma,os,platform,readline,sqlite3,ssl,sys,sysconfig,unittest,venv,zlib
from pathlib import Path
assert sys.version_info[:3]==(3,13,5)
assert sys.implementation.name=='cpython' and platform.machine()=='aarch64'
assert Path(sys.prefix).resolve()==Path(sys.argv[1]).resolve()
assert Path(sys.executable).resolve()==(Path(sys.argv[1])/'bin/python3.13').resolve()
assert isinstance(ast.parse('value = 21 * 2'),ast.Module)
try:ast.parse('value =')
except SyntaxError:pass
else:raise AssertionError('Broken Python source was accepted')
print(json.dumps({'version':platform.python_version(),'machine':platform.machine(),'prefix':sys.prefix,'executable':sys.executable,'openssl':ssl.OPENSSL_VERSION,'sqlite':sqlite3.sqlite_version,'libc':platform.libc_ver(),'stdlibControlsPassed':True}))
"""

def need(value,message):
    if not value:raise ValueError(message)

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as stream:
        while True:
            block=stream.read(65536)
            if not block:break
            h.update(block)
    return h.hexdigest()

def host_admission(cache,manifest):
    need(platform.system()=='Linux' and platform.machine()=='aarch64','Python compatibility preparation requires native Linux ARM64')
    release=platform.freedesktop_os_release()
    need(release.get('ID')=='ubuntu' and release.get('VERSION_ID')=='26.04','Python compatibility preparation requires Ubuntu26.04')
    need(str(cache)==manifest['toolCacheRoot'] and cache==cache.resolve(strict=True),'Expected canonical hosted Python tool cache')

def inspect(archive,manifest):
    need(archive.is_file() and not archive.is_symlink() and archive.stat().st_size==manifest['bytes'] and digest(archive)==manifest['sha256'],'Pinned Python SDK archive differs')
    rows={};expanded=0
    with tarfile.open(archive,'r:gz') as stream:
        for member in stream:
            need(len(rows)<manifest['maximumMembers'],'Python SDK member bound')
            name=member.name
            while name.startswith('./'):name=name[2:]
            if name in ('','.'):need(member.isdir(),'Python SDK root must be directory');continue
            need(name and not name.startswith('/') and '\\' not in name and '\0' not in name and all(x not in ('','.','..') for x in name.split('/')),'Unsafe Python SDK path')
            need(name not in rows and (member.isdir() or member.isfile() or member.issym()),'Duplicate or unsupported Python SDK member')
            need(not member.mode & 0o7000,'Privileged Python SDK mode')
            expanded+=member.size;need(expanded<=manifest['maximumExpandedBytes'],'Python SDK expansion bound')
            row={'name':name,'kind':'directory' if member.isdir() else 'file' if member.isfile() else 'symlink','mode':member.mode & 0o777,'size':member.size}
            if member.issym():
                link=member.linkname
                need(link and not link.startswith('/') and '\\' not in link and '\0' not in link,'Unsafe Python SDK link')
                target=posixpath.normpath(posixpath.join(posixpath.dirname(name),link))
                need(target not in ('..','.') and not target.startswith('../'),'Python SDK link escapes install root')
                row.update(link=link,target=target)
            rows[name]=row
        for name,row in rows.items():
            for parent in PurePosixPath(name).parents:
                if str(parent)=='.':continue
                need(str(parent) in rows and rows[str(parent)]['kind']=='directory','Python SDK parent is missing or a link')
            if row['kind']=='symlink':need(row['target'] in rows,'Python SDK link target missing')
    need(rows.get('bin/python3.13',{}).get('kind')=='file' and rows.get('lib/libpython3.13.so.1.0',{}).get('kind')=='file','Python SDK executable/runtime library missing')
    return rows

def prepare(archive,cache,manifest,runner=subprocess.run):
    rows=inspect(archive,manifest)
    parent=cache/'Python'/manifest['version'];target=parent/'arm64';complete=parent/'arm64.complete'
    need(not os.path.lexists(target) and not os.path.lexists(complete),'Refusing to overwrite an existing Python SDK')
    parent.mkdir(parents=True,exist_ok=True)
    need(parent==parent.resolve(strict=True),'Python SDK install parent must be physical')
    stage=Path(tempfile.mkdtemp(prefix='arm64-stage-',dir=parent));installed=False
    try:
        for row in sorted(rows.values(),key=lambda r:(r['name'].count('/'),r['name'])):
            if row['kind']=='directory':(stage/row['name']).mkdir(mode=0o700)
        with tarfile.open(archive,'r:gz') as stream:
            for member in stream:
                name=member.name
                while name.startswith('./'):name=name[2:]
                if name not in rows or rows[name]['kind']!='file' or name=='setup.sh':continue
                dest=stage/name;descriptor=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,rows[name]['mode'])
                length=0
                with os.fdopen(descriptor,'wb') as sink,stream.extractfile(member) as source:
                    while length<member.size:
                        block=source.read(min(65536,member.size-length));need(block,'Short Python SDK member')
                        sink.write(block);length+=len(block)
        for row in rows.values():
            if row['kind']=='symlink':(stage/row['name']).symlink_to(row['link'])
        for relative,link in [('python','bin/python3.13'),('bin/python','python3.13'),('bin/python313','python3.13')]:
            if not os.path.lexists(stage/relative):(stage/relative).symlink_to(link)
        for relative in ['python','bin/python','bin/python3','bin/python313']:
            need((stage/relative).resolve(strict=True)==stage/'bin/python3.13','Python SDK entrypoint differs')
        for row in rows.values():
            if row['kind']=='directory':(stage/row['name']).chmod(row['mode'])
        need(digest(stage/'bin/python3.13')==manifest['interpreterSHA256'],'Pinned installed Python executable differs')
        need(digest(archive)==manifest['sha256'],'Python archive changed during installation')
        os.rename(stage,target);installed=True
        with tempfile.TemporaryDirectory(prefix='python-sdk-home-') as home:
            env={'PATH':str(target/'bin')+':/usr/bin:/bin','HOME':home,'LC_ALL':'C.UTF-8','LD_LIBRARY_PATH':str(target/'lib')}
            native=runner([str(target/'bin/python3.13'),'-I','-B','-c',PROBE,str(target)],env=env,cwd=home,capture_output=True,text=True,timeout=30,check=False)
        need(native.returncode==0,'Python3.13.5 native compatibility probe failed: '+native.stderr[:4096])
        need(len(native.stdout)<=65536,'Python SDK probe output bound')
        evidence=json.loads(native.stdout)
        need(evidence.get('version')==manifest['version'] and evidence.get('machine')=='aarch64' and evidence.get('stdlibControlsPassed') is True and Path(evidence.get('prefix','')).resolve()==target.resolve(),'Python SDK runtime identity or stdlib controls differ')
        proof={'schemaVersion':1,'SDK':{k:manifest[k] for k in ['version','architecture','producerOS','asset','bytes','sha256']},'hostOS':manifest['hostOS'],'nativeCompatibility':evidence,'upstreamInstallerExecuted':False,'pipUpgradeInvoked':False,'publisherUbuntu26SupportClaimed':False,'upstreamBuildReproduced':False}
        (parent/'arm64-preparation.json').write_text(json.dumps(proof,indent=2)+'\n')
        descriptor=os.open(complete,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(descriptor)
        return proof
    except BaseException:
        if installed:shutil.rmtree(target)
        else:shutil.rmtree(stage)
        if complete.exists():complete.unlink()
        raise

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('archive');parser.add_argument('cache');args=parser.parse_args()
    manifest=json.loads(MANIFEST.read_text());cache=Path(args.cache);host_admission(cache,manifest)
    print(json.dumps(prepare(Path(args.archive),cache,manifest)))

if __name__=='__main__':main()
