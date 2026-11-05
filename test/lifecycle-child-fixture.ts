// Publish readiness only after the complete child identity has been written.
export const lifecycleChildBody =
  "const fs=require('node:fs'),marker=process.argv[1],pending=marker+'.partial';fs.writeFileSync(pending,String(process.pid));fs.renameSync(pending,marker);setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);";
