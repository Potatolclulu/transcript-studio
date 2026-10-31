import { z } from 'zod';
import { AppError, type Env } from './env';
import { boundedJson, captionsEnabled, type VideoRow } from './learning-store';

export function mediaEndpoint(env:Env,path:string) {
  if(!captionsEnabled(env))throw new AppError(503,'Media import is not configured. Your link is saved.');
  const base=new URL(env.CAPTION_SERVICE_URL!);
  if(base.protocol!=='https:'&&!(env.APP_ENV==='development'&&['127.0.0.1','localhost'].includes(base.hostname)))
    throw new AppError(503,'The media service needs a secure HTTPS endpoint.');
  return new URL(path,base);
}
const jobSchema=z.object({
  key:z.string().regex(/^[a-f0-9]{64}$/),status:z.enum(['queued','running','complete','failed']),
  progress:z.string().max(300),error:z.string().max(300).nullable(),
  title:z.string().max(500).optional(),duration:z.number().positive().max(7200).optional(),result:z.unknown().optional(),
});
export async function mediaJob(env:Env,video:VideoRow,fetcher:typeof fetch){
  const response=await fetcher(mediaEndpoint(env,'/jobs'),{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.CAPTION_SERVICE_SECRET}`},
    body:JSON.stringify({platform:video.platform,sourceId:video.source_id,attempt:`${video.id}:${video.import_attempt}`}),
  });
  const data=await boundedJson(response);
  if(!response.ok)throw new AppError(422,typeof data==='object'&&data&&'error' in data?String(data.error).slice(0,300):'The media service is unavailable. Please retry.');
  const job=jobSchema.parse(data);
  if(job.status==='complete'){
    const complete=await fetcher(mediaEndpoint(env,`/jobs/${job.key}`),{
      redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${env.CAPTION_SERVICE_SECRET}`},
    });
    if(!complete.ok)throw new AppError(502,'The completed media job could not be read.');
    return jobSchema.parse(await boundedJson(complete));
  }
  return job;
}
