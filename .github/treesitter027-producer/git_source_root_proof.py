import hashlib
from pathlib import PurePosixPath
class ProofRefusal(RuntimeError):pass
def need(c,m):
 if not c:raise ProofRefusal(m)
def git_blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def git_tree(entries):
 root={'files':{},'dirs':{}}
 for path,(mode,sha) in entries.items():
  parts=path.split('/');need(all(x not in ('','.','..') for x in parts),'Git path segments');node=root
  for parent in parts[:-1]:need(parent not in node['files'],'Git file/directory collision');node=node['dirs'].setdefault(parent,{'files':{},'dirs':{}})
  name=parts[-1];need(name not in node['dirs'] and name not in node['files'],'duplicate Git leaf');node['files'][name]=(mode,sha)
 def visit(node):
  rows=[(name,mode,sha,False) for name,(mode,sha) in node['files'].items()]+[(name,'40000',visit(child),True) for name,child in node['dirs'].items()];rows.sort(key=lambda r:r[0].encode('utf-8','surrogateescape')+(b'/' if r[3] else b''));data=b''.join(mode.encode()+b' '+name.encode('utf-8','surrogateescape')+b'\0'+bytes.fromhex(sha) for name,mode,sha,_ in rows);return hashlib.sha1(b'tree '+str(len(data)).encode()+b'\0'+data).hexdigest()
 return visit(root)
def proof(raw,records,expected):
 roots={r['path'].split('/',1)[0] for r in records if r['path']};need(len(roots)==1,'one observed source archive root');root=next(iter(roots));entries={};rows=[]
 for r in records:
  path=r['path']
  if path==root:need(r['kind']=='directory','source archive root directory');continue
  need(path.startswith(root+'/'),'source archive root containment');rel=path[len(root)+1:]
  if r['kind']=='directory':continue
  need(r['kind'] in ('regular','symlink'),'source hardlink/special unsupported; no root proof')
  if r['kind']=='symlink':body=r['linkName'].encode('utf-8','surrogateescape');sha=git_blob(body);mode='120000';n=len(body)
  else:
   n=r['size'];h=hashlib.sha1(b'blob '+str(n).encode()+b'\0');remaining=n
   with raw.open('rb') as f:
    f.seek(r['offsetData'])
    while remaining:
     b=f.read(min(1024*1024,remaining));need(bool(b),'source physical blob read');h.update(b);remaining-=len(b)
   sha=h.hexdigest();mode='100755' if int(r['mode'],8)&0o111 else '100644'
  need(rel not in entries,'duplicate source path');entries[rel]=(mode,sha);rows.append({'path':rel,'mode':mode,'blobSHA1':sha,'bytes':n})
 observed=git_tree(entries);return {'complete':observed==expected,'expectedGitTree':expected,'observedGitTree':observed,'observedArchiveRoot':root,'allSourceBlobModeRows':rows,'GitBlobCount':len(rows),'GitWorkingTreeOrObjectsWritten':False,'signatureVerificationOrHistoricalConsumptionClaimed':False}
