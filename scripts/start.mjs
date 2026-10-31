import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { startCaptions } from './captions.mjs';
const occupied = await new Promise(resolve => {
  const socket = createConnection({host:'127.0.0.1',port:5178});
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',()=>resolve(false));
});
if(occupied) { console.error('Port 5178 is already occupied. Check the existing process before starting another instance.'); process.exit(1); }
if(!existsSync('.dev.vars')) {
  let template=readFileSync('.dev.vars.example','utf8');
  template=template.replace('replace-with-a-random-32-byte-secret',randomBytes(32).toString('hex'))
    .replace('replace-with-a-separate-random-secret',randomBytes(32).toString('hex'));
  writeFileSync('.dev.vars',template,{mode:0o600});
}
for(const args of [['run','build'],['run','db:migrate']]){
  const result=spawnSync('npm',args,{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
const captions=startCaptions();
const worker=spawn('npx',['wrangler','dev','--port','5178','--test-scheduled'],{stdio:['inherit','pipe','inherit']});
let opened=false;
worker.stdout.on('data',chunk=>{
  process.stdout.write(chunk);
  if(!opened && chunk.toString().includes('Ready on http://')){
    opened=true;
    spawn('open',['http://127.0.0.1:5178'],{stdio:'ignore'});
  }
});
worker.on('exit',code=>{captions?.kill('SIGTERM');process.exit(code||0);});
process.on('SIGINT',()=>{worker.kill('SIGINT');captions?.kill('SIGINT');});
process.on('SIGTERM',()=>{worker.kill('SIGTERM');captions?.kill('SIGTERM');});
