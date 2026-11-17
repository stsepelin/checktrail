"""Original6070 native build-stage composition for an operator-reviewed carrier.

Imports and planning execute no SDK/project code. This module is not an MCP trust
switch. Only the separately reviewed manual operator controller may invoke run.
"""
import hashlib,importlib.util,json,os,re,shutil,stat,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PRIMITIVES=HERE/'reused-native-v5'
for name,expected in [('controller.py','fc38cf99a77eaa8ed06e38514b3123e4659d5ec6ea0fa92c716213ba06e13861'),('capsule.py','d12ce716bfd076de740769a4db1e67a38bee55a38a93751b15ececf108b7b283')]:
 if hashlib.sha256((PRIMITIVES/name).read_bytes()).hexdigest()!=expected:raise ValueError('Reviewed macOS native primitive differs')
spec=importlib.util.spec_from_file_location('reviewed_native_mac',PRIMITIVES/'controller.py');N=importlib.util.module_from_spec(spec);spec.loader.exec_module(N)
CFLAGS='-g -Werror -Wall -Wextra -Wshadow -Wpedantic -Werror=incompatible-pointer-types -Werror=strict-aliasing -Wstrict-aliasing=2'
CARGO=['cargo','build','--release','--target=aarch64-apple-darwin','--features=wasm']


def need(value,message):
 if not value:raise ValueError(message)

def profiles(source,emsdk):
 return [
  {'id':'original-emsdk-install','cwd':str(emsdk),'argv':['./emsdk','install','4.0.15'],'env':{'EMSDK_KEEP_DOWNLOADS':'1'},'seconds':300},
  {'id':'original-emsdk-activate','cwd':str(emsdk),'argv':['./emsdk','activate','4.0.15'],'env':{},'seconds':120},
  {'id':'original-wasmtime-version','cwd':str(source),'argv':['/bin/bash','-euo','pipefail','-c','cargo metadata --format-version=1 --locked --features wasm | jq -r \'.packages[] | select(.name == "wasmtime-c-api-impl") | .version\' > "$CHECKTRAIL_WASMTIME_VERSION_RECEIPT"'],'env':{},'seconds':180},
  {'id':'original-c-make','cwd':str(source),'argv':['/bin/bash','-euo','pipefail','-c','make -j CFLAGS="$CFLAGS" CC=$CC AR=$AR'],'env':{'CFLAGS':CFLAGS,'CC':'gcc','AR':'ar','PLATFORM':'macos-arm64'},'seconds':180},
  {'id':'original-cmake-static-configure','cwd':str(source),'argv':['cmake','-S','.','-B','build/static','-DBUILD_SHARED_LIBS=OFF','-DCMAKE_BUILD_TYPE=Debug','-DCMAKE_COMPILE_WARNING_AS_ERROR=ON','-DTREE_SITTER_FEATURE_WASM=ON'],'env':{'CC':'','WASM':'ON'},'seconds':180},
  {'id':'original-cmake-static-build','cwd':str(source),'argv':['cmake','--build','build/static','--verbose'],'env':{'CC':'','WASM':'ON'},'seconds':180},
  {'id':'original-cmake-shared-configure','cwd':str(source),'argv':['cmake','-S','.','-B','build/shared','-DBUILD_SHARED_LIBS=ON','-DCMAKE_BUILD_TYPE=Debug','-DCMAKE_COMPILE_WARNING_AS_ERROR=ON','-DTREE_SITTER_FEATURE_WASM=ON'],'env':{'CC':'','WASM':'ON'},'seconds':180},
  {'id':'original-cmake-shared-build','cwd':str(source),'argv':['cmake','--build','build/shared','--verbose'],'env':{'CC':'','WASM':'ON'},'seconds':180},
  {'id':'original-npm-ci','cwd':str(source/'lib/binding_web'),'argv':['npm','ci'],'env':{},'seconds':300},
  {'id':'original-cjs-release','cwd':str(source/'lib/binding_web'),'argv':['npm','run','build'],'env':{'CJS':'true'},'seconds':600},
  {'id':'original-cjs-debug','cwd':str(source/'lib/binding_web'),'argv':['npm','run','build:debug'],'env':{'CJS':'true'},'seconds':600},
  {'id':'original-esm-release','cwd':str(source/'lib/binding_web'),'argv':['npm','run','build'],'env':{},'seconds':600},
  {'id':'original-esm-debug','cwd':str(source/'lib/binding_web'),'argv':['npm','run','build:debug'],'env':{},'seconds':600},
  {'id':'original-rust-cli','cwd':str(source),'argv':CARGO.copy(),'env':{'PACKAGE':''},'seconds':1800},
 ]

def clean_environment(work,inputs,host,emsdk,emsdk_node,emcache):
 # Node24/Rust are activated for consumer phases after original Emsdk installation.
 paths=[str(inputs/'node24/bin'),str(inputs/'rust/bin'),str(emsdk),str(emsdk/'upstream/emscripten')]
 paths.extend(str(Path(host['tools'][key]['path']).parent) for key in ['cmake','git','python3'])
 paths.extend(['/usr/bin','/bin','/usr/sbin','/sbin'])
 return {'PATH':':'.join(dict.fromkeys(paths)),'HOME':host['buildHome'],'TMPDIR':str(work/'tmp'),'XDG_CACHE_HOME':str(work/'cache'),'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','DEVELOPER_DIR':host['developerDir'],'SDKROOT':host['sdk'],'CARGO_HOME':str(work/'cargo-home'),'CARGO_TARGET_DIR':str(work/'source/target'),'CARGO_BUILD_JOBS':'2','CARGO_NET_OFFLINE':'true','CARGO_TERM_COLOR':'always','RUSTFLAGS':'-D warnings','npm_config_cache':str(work/'npm-cache'),'npm_config_offline':'true','npm_config_audit':'false','npm_config_fund':'false','CMAKE_PREFIX_PATH':str(inputs/'wasmtime'),'EMSDK':str(emsdk),'EMSDK_NODE':str(emsdk_node),'EM_CACHE':str(emcache),'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(work/'control/git-empty.config')}

def immutable_sdk_tree(root):
 need(root==root.resolve(strict=True) and root.is_dir(),'Physical new SDK tree required')
 for folder,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   path=Path(folder)/name;before=path.lstat();need(before.st_uid in (0,4294967294),'Unexpected new SDK owner')
   if path.is_symlink():need(root==path.resolve(strict=True) or root in path.resolve(strict=True).parents,'Installed SDK link escapes');os.lchown(path,0,0)
   else:need(stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode),'Installed SDK special file');os.chown(path,0,0);path.chmod(0o555 if stat.S_ISDIR(before.st_mode) or before.st_mode&0o111 else 0o444)
 os.chown(root,0,0);root.chmod(0o555)

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  while True:
   body=stream.read(65536)
   if not body:break
   h.update(body)
 return h.hexdigest()

def run(native,source,emsdk,environment,freeze_emsdk,checkpoint):
 need(environment.get('RUSTFLAGS')=='-D warnings' and environment.get('CARGO_NET_OFFLINE')=='true','Original warnings/offline control differs')
 need('CC' not in environment and 'CFLAGS' not in environment and 'AR' not in environment and 'CJS' not in environment,'Phase-local original flags leaked into base environment')
 lock=source/'Cargo.lock';web_lock=source/'lib/binding_web/package-lock.json';need(digest(lock)=='bf2323906cebdc3c72d307d70c0b5da58d83098590a842ee3deb7f5a7af5db82','Original Cargo.lock differs');need(digest(web_lock)=='79e6bf76f4898222e1359af392c9f49504987a4061f5c9dd57dea203dfe97980','Original web lock differs')
 observed=[]
 for stage in profiles(source,emsdk):
  current={**environment,**stage['env']}
  if stage['id'] in ('original-emsdk-install','original-emsdk-activate'):
   current['PATH']=':'.join(p for p in current['PATH'].split(':') if p not in (str(source.parent/'inputs/node24/bin'),str(source.parent/'inputs/rust/bin')))
   current.pop('EM_CACHE',None)
  receipt=native.run(stage['id'],stage['argv'],current,Path(stage['cwd']),stage['seconds']);observed.append(receipt)
  if stage['id']=='original-emsdk-activate':
   activated=freeze_emsdk();need(set(activated)=={'EMSDK_NODE'},'Only the original activated Node binding may be added');environment={**environment,**activated}
  if stage['id']=='original-wasmtime-version':
   # Preserve the original stdout-only jq selection despite combined diagnostic logs.
   version=Path(environment['CHECKTRAIL_WASMTIME_VERSION_RECEIPT']);need(version.is_file() and not version.is_symlink() and version.stat().st_size<=128 and version.read_bytes()==b'48.0.1\n','Original Wasmtime selector must yield exactly one48.0.1 package')
  if stage['id']=='original-esm-debug':
   checkpoint({'conditionalEmbeddedInputs':[{'path':p,'exists':(source/p).is_file(),'sha256':digest(source/p) if (source/p).is_file() else None} for p in ['docs/src/assets/js/playground.js','lib/binding_web/web-tree-sitter.js','lib/binding_web/web-tree-sitter.wasm']],'differentWebOutputsReused':False})
 need(digest(lock)=='bf2323906cebdc3c72d307d70c0b5da58d83098590a842ee3deb7f5a7af5db82' and digest(web_lock)=='79e6bf76f4898222e1359af392c9f49504987a4061f5c9dd57dea203dfe97980','Original lock bytes changed during source build')
 return {'allOriginalSelectedBuildStagesObserved':True,'phases':observed,'originalRunTests':False,'upstreamTestsPassedClaimed':False,'sourceBuildCompilerSDKLegalOrGateAComplete':False}
