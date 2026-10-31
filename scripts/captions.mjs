import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function startCaptions() {
  const content = readFileSync('.dev.vars','utf8');
  const get = name => content.match(new RegExp(`^${name}=(.*)$`,'m'))?.[1]?.trim().replace(/^["']|["']$/g,'');
  if (get('APP_ENV') !== 'development') return null;
  let secret = get('CAPTION_SERVICE_SECRET');
  const additions = [];
  if (!secret) { secret = randomBytes(32).toString('hex'); additions.push(`CAPTION_SERVICE_SECRET=${secret}`); }
  if (!get('CAPTION_SERVICE_URL')) additions.push('CAPTION_SERVICE_URL=http://127.0.0.1:8791/extract');
  if (additions.length) appendFileSync('.dev.vars', `\n# Local public YouTube captions; never commit this file.\n${additions.join('\n')}\n`);
  if (get('CAPTION_SERVICE_URL') && get('CAPTION_SERVICE_URL') !== 'http://127.0.0.1:8791/extract') return null;
  const helper = join(homedir(),'.local/share/qiaomu-clipper/tools/base/bin/yt-dlp');
  const executable = process.env.YT_DLP || (existsSync(helper) ? helper : 'yt-dlp');
  const child = spawn('python3',['probe/captions.py'],{
    stdio:['ignore','inherit','inherit'],
    env:{...process.env,CAPTION_SERVICE_SECRET:secret,YT_DLP:executable,
      DOUBAO_API_KEY:get('DOUBAO_API_KEY')||'',MEDIA_ASR_DAILY_MINUTES:get('MEDIA_ASR_DAILY_MINUTES')||'180',
      HOST:'127.0.0.1',PORT:'8791'},
  });
  return child;
}
if (process.argv[1]?.endsWith('/captions.mjs')) {
  const child = startCaptions();
  if (!child) throw new Error('The local caption service is only started in development with the default local endpoint.');
  child.on('exit', code => process.exit(code || 0));
  process.on('SIGINT',()=>child.kill('SIGINT'));
  process.on('SIGTERM',()=>child.kill('SIGTERM'));
}
