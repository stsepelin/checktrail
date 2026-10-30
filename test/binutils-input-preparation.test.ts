import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const failures: string[] = [];
const python = ["python3", "python"].find((executable) => {
  const result = spawnSync(
    executable,
    ["-I", "-c", "import sys; print(sys.version_info.major)"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 65536 },
  );
  if (
    !result.error &&
    result.status === 0 &&
    result.signal === null &&
    result.stdout?.trim() === "3"
  )
    return true;
  failures.push(
    `${executable}: ${result.error?.message ?? `status=${result.status};signal=${result.signal};stderr=${result.stderr ?? ""}`}`,
  );
  return false;
});
const optionalPython = {
  skip: python
    ? false
    : "Verified Python3 input-transform collector unavailable: " +
      failures.join("; "),
};

test(
  "producer input transformations reject archive links duplicates traversal truncation and unbound signed hashes",
  optionalPython,
  () => {
    const program = String.raw`
import hashlib, importlib.util, io, json, lzma, sys, tarfile
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('checktrail_prepare',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
raw=b'original synthetic public keyring'
pin={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
name='usr/share/keyrings/debian-keyring.gpg'
def archive(entries):
 output=io.BytesIO()
 with tarfile.open(fileobj=output,mode='w:xz') as target:
  for filename,kind,data in entries:
   info=tarfile.TarInfo(filename); info.type=kind
   if kind==tarfile.REGTYPE:info.size=len(data)
   elif kind in (tarfile.SYMTYPE,tarfile.LNKTYPE):info.linkname=name
   target.addfile(info,io.BytesIO(data) if kind==tarfile.REGTYPE else None)
 return output.getvalue()
def package(payload):
 header=b'data.tar.xz/    '.ljust(16)+b'0'.ljust(12)+b'0'.ljust(6)+b'0'.ljust(6)+b'100644'.ljust(8)+str(len(payload)).encode().ljust(10)+b'\x60\n'
 return b'!<arch>\n'+header+payload+(b'\n' if len(payload)%2 else b'')
def rejected(call):
 try:call()
 except (AssertionError,KeyError,ValueError,tarfile.TarError,EOFError,lzma.LZMAError):return
 raise AssertionError('Malformed input was accepted')
valid=package(archive([(name,tarfile.REGTYPE,raw)]))
assert module.extract_keyring(valid,name,pin)==raw
cases=[
 package(archive([(name,tarfile.SYMTYPE,b'')])),
 package(archive([(name,tarfile.LNKTYPE,b'')])),
 package(archive([(name,tarfile.REGTYPE,raw),(name,tarfile.REGTYPE,raw)])),
 package(archive([('../escape',tarfile.REGTYPE,b'x'),(name,tarfile.REGTYPE,raw)])),
 package(archive([('/absolute',tarfile.REGTYPE,b'x'),(name,tarfile.REGTYPE,raw)])),
 package(archive([('unrelated',tarfile.REGTYPE,raw)])),
 valid[:-17],
 b'bad ar header'+valid[13:],
]
for candidate in cases:rejected(lambda:module.extract_keyring(candidate,name,pin))
rejected(lambda:module.extract_keyring(valid,name,dict(pin,sha256='0'*64)))
rejected(lambda:module.extract_keyring(valid,name,dict(pin,bytes=pin['bytes']+1)))
canonical={'bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
text='SHA256:\n '+canonical['sha256']+' 3 main/binary-amd64/Packages\n'
module.signed_payload_contains(text,canonical,'main/binary-amd64/Packages')
rejected(lambda:module.signed_payload_contains(text,dict(canonical,bytes=4),'main/binary-amd64/Packages'))
rejected(lambda:module.signed_payload_contains(text,dict(canonical,sha256='0'*64),'main/binary-amd64/Packages'))
rejected(lambda:module.signed_payload_contains(text+text,canonical,'main/binary-amd64/Packages'))
rejected(lambda:module.signed_payload_contains(text,canonical,'main/binary-amd64/Packages.xz'))
assert module.stream_identity(io.BytesIO(b'abc'),3)==canonical
rejected(lambda:module.stream_identity(io.BytesIO(b'abcd'),3))
print(json.dumps({'archiveBrokenCases':10,'signedPayloadBrokenCases':4,'expansionBrokenCases':1,'validKeyring':True,'validSignedPayload':True,'validExpansion':True}))
`;
    assert.ok(python);
    const result = spawnSync(
      python,
      [
        "-I",
        "-c",
        program,
        path.join(
          repository,
          "scripts/producer-qualification/binutils-prepare-inputs.py",
        ),
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(
      result.error,
      undefined,
      result.error?.message ?? "Input guard control could not start",
    );
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      0,
      result.stderr ?? "Python collector returned no diagnostic",
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      archiveBrokenCases: 10,
      signedPayloadBrokenCases: 4,
      expansionBrokenCases: 1,
      validKeyring: true,
      validSignedPayload: true,
      validExpansion: true,
    });
  },
);

test(
  "bounded producer evidence export preserves original bytes and refuses missing or existing targets",
  optionalPython,
  () => {
    const program = String.raw`
import hashlib,importlib.util,json,pathlib,sys,tempfile,zipfile
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('checktrail_export',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary).resolve();inputs=root/'inputs';result=root/'result';inputs.mkdir();result.mkdir()
 (inputs/'receipt.json').write_text('{"state":"synthetic-input-only"}\n')
 (result/'build.log').write_bytes(b'Original synthetic failed build\n')
 output=root/'evidence.zip';report=module.export(inputs,result,output)
 assert report['files']==2 and report['gateAComplete'] is False and report['qualificationComplete'] is False
 with zipfile.ZipFile(output) as archive:
  manifest=json.loads(archive.read('manifest.json'))
  assert len(manifest['rawFiles'])==2 and manifest['nativeWorktreeArchiveUploaded'] is False
  for row in manifest['rawFiles']:
   data=archive.read(row['file']);assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256']
 before=output.read_bytes()
 try:module.export(inputs,result,output)
 except AssertionError:pass
 else:raise AssertionError('Existing output was overwritten')
 assert output.read_bytes()==before
 empty=root/'empty';empty.mkdir()
 try:module.export(empty,empty,root/'missing.zip')
 except AssertionError:pass
 else:raise AssertionError('Missing evidence was exported as complete')
 if sys.platform!='win32':
  (result/'build.log').unlink();(result/'build.log').symlink_to(inputs/'receipt.json')
  try:module.export(inputs,result,root/'linked.zip')
  except AssertionError:pass
  else:raise AssertionError('Linked evidence was exported')
 with (root/'limited').open('wb') as handle:
  writer=module.BoundedWriter(handle,4);writer.write(b'abcd')
  try:writer.write(b'e')
  except AssertionError:pass
  else:raise AssertionError('Output byte ceiling was bypassed')
 assert (root/'limited').read_bytes()==b'abcd'
print(json.dumps({'originalBytesPreserved':True,'existingDestinationPreserved':True,'emptyExportRefused':True,'boundedWriterEnforced':True,'linkedPathControlExecuted':sys.platform!='win32'}))
`;
    assert.ok(python);
    const result = spawnSync(
      python,
      [
        "-I",
        "-c",
        program,
        path.join(
          repository,
          "scripts/producer-qualification/binutils-export-evidence.py",
        ),
      ],
      { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
    assert.equal(
      result.error,
      undefined,
      result.error?.message ?? "Evidence control could not start",
    );
    assert.equal(result.signal, null);
    assert.equal(
      result.status,
      0,
      result.stderr ?? "Evidence control has no diagnostic",
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      originalBytesPreserved: true,
      existingDestinationPreserved: true,
      emptyExportRefused: true,
      boundedWriterEnforced: true,
      linkedPathControlExecuted: process.platform !== "win32",
    });
  },
);
