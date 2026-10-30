import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
const labels = Object.freeze({
  owner: "checktrail.consumer.capture-owner",
  attempt: "checktrail.consumer.capture-attempt",
  task: "checktrail.consumer.capture-task",
});
export function consumerCaptureLabels(context) {
  assert.ok(uuid(context.attemptId));
  assert.match(context.task, /^[A-Za-z0-9_.-]{1,128}$/);
  return {
    [labels.owner]: "native-acceptance-v1",
    [labels.attempt]: context.attemptId,
    [labels.task]: context.task,
  };
}
export function requireOwnedConsumerCaptureResource(value, context, name) {
  const observed = value?.Labels ?? value?.Config?.Labels;
  assert.ok(observed && typeof observed === "object");
  for (const [key, expected] of Object.entries(consumerCaptureLabels(context)))
    assert.equal(
      observed[key],
      expected,
      "Foreign native capture resource owner",
    );
  assert.equal(
    value.Name?.replace(/^\//, ""),
    name,
    "Foreign native capture resource name",
  );
  return value;
}
const booleans = new Set([
  "--rm",
  "--init",
  "--read-only",
  "--interactive",
  "--tty",
]);
const values = new Set([
  "--network",
  "--cpus",
  "--memory",
  "--pids-limit",
  "--tmpfs",
  "--label",
  "--mount",
  "--workdir",
  "--env",
  "--user",
  "--entrypoint",
  "--platform",
  "--hostname",
  "--name",
  "--stop-timeout",
]);
/** Parse only real Docker run options. Command arguments are preserved verbatim after the image. */
export function consumerDockerRunDescription(args) {
  assert.ok(
    Array.isArray(args) &&
      args.every((value) => typeof value === "string" && !value.includes("\0")),
  );
  if (args[0] !== "run") return null;
  let user = null,
    name = null,
    remove = false,
    imageIndex = -1;
  const optionValues = [],
    removeIndexes = [];
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("-")) {
      imageIndex = index;
      break;
    }
    const equal = value.indexOf("="),
      key = equal < 0 ? value : value.slice(0, equal);
    if (booleans.has(key)) {
      assert.ok(
        equal < 0 || ["true", "false"].includes(value.slice(equal + 1)),
      );
      if (key === "--rm") {
        remove = equal < 0 || value.slice(equal + 1) === "true";
        if (remove) removeIndexes.push(index);
      }
      continue;
    }
    assert.ok(values.has(key), "Unsupported native Docker run option: " + key);
    const data = equal < 0 ? args[++index] : value.slice(equal + 1);
    assert.ok(typeof data === "string" && data.length > 0);
    if (key === "--user") {
      assert.equal(user, null, "Duplicate native Docker user");
      user = data;
    }
    if (key === "--name") {
      assert.equal(name, null, "Duplicate native Docker container name");
      assert.match(data, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
      name = data;
    }
    if (key === "--env")
      assert.ok(
        ![
          "CHECKTRAIL_CONSUMER_CAPTURE_ROOT",
          "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY",
          "CHECKTRAIL_CONSUMER_WITNESS_DIR",
        ].includes(data.split("=")[0]),
        "Nested native capture storage is unsupported",
      );
    if (key === "--label")
      assert.ok(
        !Object.values(labels).includes(data.split("=")[0]),
        "Nested native capture owner is unsupported",
      );
    optionValues.push({ key, value: data });
  }
  assert.ok(
    imageIndex > 0 && imageIndex < args.length - 1,
    "Native Docker image and command must be explicit",
  );
  return {
    image: args[imageIndex],
    imageIndex,
    user,
    name,
    remove,
    removeIndexes,
    command: args.slice(imageIndex + 1),
    optionValues,
  };
}
export function capturedConsumerDockerArguments(
  args,
  description,
  volume,
  container,
  context,
) {
  assert.match(volume, /^checktrail-consumer-capture-[a-f0-9-]{36}$/);
  assert.equal(container, description.name ?? volume + "-body");
  assert.match(container, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  assert.deepEqual(consumerDockerRunDescription(args), description);
  const storage = [
    ...(description.name === null ? ["--name", container] : []),
    "--mount",
    "type=volume,source=" +
      volume +
      ",target=/operator-consumer-captures,volume-nocopy",
    "--env",
    "CHECKTRAIL_CONSUMER_CAPTURE_ROOT=/operator-consumer-captures",
    "--env",
    "CHECKTRAIL_CONSUMER_CAPTURE_REGISTRY=/operator-consumer-captures/capture-registry.jsonl",
  ];
  for (const [key, value] of Object.entries(consumerCaptureLabels(context)))
    storage.push("--label", key + "=" + value);
  const originalOptions = args
    .slice(1, description.imageIndex)
    .filter((value, index) => !description.removeIndexes.includes(index + 1));
  return [
    "run",
    ...storage,
    ...originalOptions,
    ...args.slice(description.imageIndex),
  ];
}
export function validateConsumerCaptureExport(value, expected) {
  assert.equal(value?.schemaVersion, 1);
  assert.equal(value.profile, "bounded-owned-native-capture-export-v1");
  assert.ok(
    Number.isSafeInteger(expected.uid) &&
      expected.uid >= 0 &&
      Number.isSafeInteger(expected.gid) &&
      expected.gid >= 0,
  );
  assert.deepEqual(value.owner, {
    uid: expected.uid,
    gid: expected.gid,
    mode: 0o700,
  });
  for (const field of ["dev", "ino", "birthtimeNs", "uid"])
    assert.match(value.rootIdentity[field], /^[0-9]+$/);
  assert.equal(value.rootIdentity.uid, String(expected.uid));
  assert.ok(
    Array.isArray(value.directories) &&
      value.directories.length <= 64 &&
      Array.isArray(value.files) &&
      value.files.length <= 1024,
  );
  const names = new Set(),
    directories = new Set();
  let total = 0;
  for (const directory of value.directories) {
    assert.match(
      directory.path,
      /^checktrail-consumer-witness-[A-Za-z0-9_-]+$/,
    );
    assert.equal(directories.has(directory.path), false);
    directories.add(directory.path);
    assert.equal(directory.uid, expected.uid);
    assert.equal(directory.gid, expected.gid);
    assert.equal(directory.mode, 0o700);
    assert.match(directory.dev, /^[0-9]+$/);
    assert.match(directory.ino, /^[0-9]+$/);
    assert.match(directory.birthtimeNs, /^[0-9]+$/);
  }
  for (const file of value.files) {
    assert.equal(names.has(file.path), false);
    names.add(file.path);
    const parts = file.path.split("/");
    assert.ok(parts.length === 1 || parts.length === 2);
    assert.ok(
      parts.every(
        (part) =>
          part && !/[\\:\0]/.test(part) && part !== "." && part !== "..",
      ),
    );
    if (parts.length === 2) assert.ok(directories.has(parts[0]));
    else
      assert.ok(
        ["capture-registry.jsonl", ".capture-registry.lock"].includes(parts[0]),
      );
    assert.equal(file.uid, expected.uid);
    assert.equal(file.gid, expected.gid);
    assert.equal(file.mode, 0o600);
    assert.equal(file.links, 1);
    assert.ok(
      Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= 32 * 1048576,
    );
    total += file.bytes;
    assert.ok(total <= 256 * 1048576);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    for (const field of ["dev", "ino", "birthtimeNs", "mtimeNs", "ctimeNs"])
      assert.match(file[field], /^[0-9]+$/);
  }
  assert.equal(value.bytes, total);
  assert.equal(
    value.manifestSha256,
    hash(
      JSON.stringify({
        rootIdentity: value.rootIdentity,
        directories: value.directories,
        files: value.files,
      }),
    ),
  );
  assert.equal(value.hostAttestationPerformed, false);
  assert.equal(value.gateAComplete, false);
  return value;
}
/** Built-ins only, no project/harness imports, no interpolation of paths into executable code. */
export const consumerCaptureUIDProgram = String.raw`console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}));`;
export const consumerCaptureExportProgram = String.raw`
import fs from'node:fs';import assert from'node:assert/strict';import{createHash}from'node:crypto';const r=JSON.parse(process.argv[1]),root='/operator-consumer-captures',hash=b=>createHash('sha256').update(b).digest('hex');
function directory(p){assert.equal(fs.realpathSync(p),p);const s=fs.lstatSync(p,{bigint:true});assert.equal(s.isDirectory(),true);assert.equal(s.isSymbolicLink(),false);assert.equal(s.uid,BigInt(r.uid));assert.equal(s.gid,BigInt(r.gid));assert.equal(s.mode&0o777n,0o700n);return s;}
function regular(relative,includeBytes=false){const p=root+'/'+relative;assert.equal(fs.realpathSync(p),p);const before=fs.lstatSync(p,{bigint:true});assert.equal(before.isFile(),true);assert.equal(before.isSymbolicLink(),false);assert.equal(before.nlink,1n);assert.equal(before.uid,BigInt(r.uid));assert.equal(before.gid,BigInt(r.gid));assert.equal(before.mode&0o777n,0o600n);assert.ok(before.size>=0n&&before.size<=32n*1048576n);const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),parts=[],digest=createHash('sha256');let count=0;try{const opened=fs.fstatSync(fd,{bigint:true});for(const k of['dev','ino','size','mtimeNs','ctimeNs'])assert.equal(opened[k],before[k]);for(;;){const b=Buffer.alloc(65536),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;count+=n;assert.ok(count<=32*1048576);digest.update(b.subarray(0,n));if(includeBytes)parts.push(b.subarray(0,n));}const after=fs.fstatSync(fd,{bigint:true}),linked=fs.lstatSync(p,{bigint:true});for(const k of['dev','ino','size','mtimeNs','ctimeNs']){assert.equal(after[k],before[k]);assert.equal(linked[k],before[k]);}assert.equal(BigInt(count),before.size);}finally{fs.closeSync(fd);}return{path:relative,bytes:count,sha256:digest.digest('hex'),uid:Number(before.uid),gid:Number(before.gid),mode:Number(before.mode&0o777n),links:Number(before.nlink),dev:String(before.dev),ino:String(before.ino),birthtimeNs:String(before.birthtimeNs),mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs),...(includeBytes?{base64:Buffer.concat(parts,count).toString('base64')}:{} )};}
const parent=directory(root);if(r.action==='read'){assert.equal(typeof r.file.path,'string');assert.ok(r.file.path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\\:\0]/.test(p)));const file=regular(r.file.path,true),{base64,...identity}=file;assert.deepEqual(identity,r.file);console.log(JSON.stringify(file));}else if(r.action==='read-batch'){assert.ok(Array.isArray(r.files)&&r.files.length>0&&r.files.length<=64);const names=new Set();for(const expected of r.files){assert.equal(typeof expected.path,'string');assert.ok(expected.path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\\:\0]/.test(p)));assert.equal(names.has(expected.path),false);names.add(expected.path);const file=regular(expected.path,true),{base64,...identity}=file;assert.deepEqual(identity,expected);process.stdout.write(JSON.stringify(file)+'\n');}}else{assert.equal(r.action,'inventory');const directories=[],files=[];let bytes=0;const names=fs.readdirSync(root).sort();assert.ok(names.length<=64);for(const name of names){const p=root+'/'+name,s=fs.lstatSync(p);if(s.isDirectory()){assert.match(name,/^checktrail-consumer-witness-[A-Za-z0-9_-]+$/);const stat=directory(p);directories.push({path:name,uid:Number(stat.uid),gid:Number(stat.gid),mode:Number(stat.mode&0o777n),dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)});const children=fs.readdirSync(p).sort();assert.ok(children.length<=1024);for(const child of children){assert.ok(child&&!/[\\/:\0]/.test(child)&&child!=='.'&&child!=='..');const value=regular(name+'/'+child);bytes+=value.bytes;assert.ok(bytes<=256*1048576);files.push(value);assert.ok(files.length<=1024);}assert.deepEqual(fs.readdirSync(p).sort(),children);const after=directory(p);for(const field of['dev','ino','mtimeNs','ctimeNs'])assert.equal(after[field],stat[field]);}else{assert.ok(['capture-registry.jsonl','.capture-registry.lock'].includes(name));const value=regular(name);bytes+=value.bytes;assert.ok(bytes<=256*1048576);files.push(value);}}const final=directory(root);assert.deepEqual(fs.readdirSync(root).sort(),names);for(const field of['dev','ino','mtimeNs','ctimeNs'])assert.equal(final[field],parent[field]);console.log(JSON.stringify({schemaVersion:1,profile:'bounded-owned-native-capture-export-v1',owner:{uid:r.uid,gid:r.gid,mode:0o700},rootIdentity:{dev:String(parent.dev),ino:String(parent.ino),birthtimeNs:String(parent.birthtimeNs),uid:String(parent.uid)},directories,files,bytes,manifestSha256:hash(JSON.stringify({rootIdentity:{dev:String(parent.dev),ino:String(parent.ino),birthtimeNs:String(parent.birthtimeNs),uid:String(parent.uid)},directories,files})),hostAttestationPerformed:false,gateAComplete:false}));}
`;
