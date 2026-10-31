import { Hono } from 'hono';
import { z } from 'zod';
import { tagsInput, mediaInput, platformName } from '../shared/learning';
import { AppError, now, row, rows, run, uid, type Env, type User } from './env';
import { auth, rateLimit } from './security';
import { aiEnabled } from './learning-ai';
import { captionFor, enqueueLearning, learningDetail, ownVideo, recordSearch, touchVideo, validAnchor, visibleVideo, type VideoRow } from './learning-store';
import { type Anchor } from '../shared/learning';
import { escapeLike, libraryScope, organizationInput, organize, visibleNote } from './library-organize';
import { readingTools, requestReading } from './reading-tools';
import { processImport } from './learning-import';
import { mediaEndpoint } from './platform-media';

async function noteSource(env: Env, video: VideoRow, questionId: string | undefined, anchor: Anchor | null) {
  if (!questionId) return null;
  const question = await row<{anchor_json:string;status:string}>(env,
    'SELECT anchor_json,status FROM learning_questions WHERE id=? AND video_id=? AND user_id=?', questionId, video.id, video.user_id);
  if (!question || question.status !== 'complete') throw new AppError(400, 'Choose a completed answer from your own video.');
  const source: Anchor = JSON.parse(question.anchor_json);
  if (!anchor || JSON.stringify(source) !== JSON.stringify(anchor))
    throw new AppError(400, 'The note must keep the source answer’s original passage.');
  return questionId;
}

export const learning = new Hono<{Bindings:Env;Variables:{user:User}}>();
learning.use('*', async (c,next) => {
  const user = await auth(c.env,c.req.header('Cookie'));
  c.set('user',user);
  await next();
});
learning.get('/',async c => {
  const videos = await rows<VideoRow>(c.env,'SELECT * FROM library WHERE user_id=? ORDER BY updated_at DESC LIMIT 200',c.get('user').id);
  const counts=await rows<{video_id:string;count:number}>(c.env,`SELECT r.video_id,COUNT(*) AS count FROM library v
    JOIN learning_records r ON r.video_id=v.id WHERE v.user_id=? AND r.user_id=v.user_id AND r.kind='note' GROUP BY r.video_id`,c.get('user').id);
  return c.json({videos:videos.map(visibleVideo),noteCounts:Object.fromEntries(counts.map(r=>[r.video_id,r.count]))});
});
learning.post('/tags',async c=>{
  await organize(c.env,c.get('user').id,organizationInput.parse(await c.req.json()));
  return c.json({ok:true});
});
learning.get('/notes',async c=>{
  const scope=libraryScope(c.req.query()),user=c.get('user').id,q=(c.req.query('q')||'').trim().slice(0,150);
  const where=`r.user_id=? AND v.user_id=? AND r.kind='note'${scope.sql}`+
    (q?" AND (r.body LIKE ? ESCAPE '\\' OR json_extract(r.anchor_json,'$.quote') LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\')":'');
  const args:unknown[]=[user,user,...scope.args,...(q?[escapeLike(q),escapeLike(q),escapeLike(q)]:[])];
  let cursorSql='';const cursorArgs:unknown[]=[];
  if(c.req.query('cursor')){
    let cursor:unknown;try{cursor=JSON.parse(c.req.query('cursor')!);}catch{throw new AppError(400,'Invalid notes page.');}
    const [updated,id]=z.tuple([z.number().int().nonnegative(),z.string().uuid()]).parse(cursor);
    cursorSql=' AND (r.updated_at<? OR (r.updated_at=? AND r.id<?))';cursorArgs.push(updated,updated,id);
  }
  const found=await rows<Parameters<typeof visibleNote>[0]>(c.env,`SELECT r.id,r.video_id,r.kind,r.body,r.anchor_json,
    r.source_question_id,r.revision,r.created_at,r.updated_at,v.title,v.author,v.tags_json
    FROM learning_records r JOIN library v ON v.id=r.video_id WHERE ${where}${cursorSql}
    ORDER BY r.updated_at DESC,r.id DESC LIMIT 41`,...args,...cursorArgs);
  const count=await row<{total:number}>(c.env,`SELECT COUNT(*) AS total FROM learning_records r JOIN library v ON v.id=r.video_id WHERE ${where}`,...args);
  const notes=found.slice(0,40).map(visibleNote),last=notes.at(-1);
  return c.json({notes,total:count?.total||0,nextCursor:found.length>40&&last?JSON.stringify([last.updated_at,last.id]):null});
});
learning.get('/search',async c => {
  const q = (c.req.query('q')||'').trim().slice(0,150);
  if (q.length < 2) return c.json({results:[]});
  const escaped = escapeLike(q), userId = c.get('user').id,scope=libraryScope(c.req.query());
  const results = await rows(c.env, `SELECT s.*,v.title FROM learning_search s JOIN library v ON v.id=s.video_id
    WHERE s.user_id=? AND v.user_id=? AND s.body LIKE ? ESCAPE '\\'
    AND (s.kind!='transcript' OR v.caption_status IN ('ready','partial'))${scope.sql}
    ORDER BY v.updated_at DESC LIMIT 60`,userId,userId,escaped,...scope.args);
  const titles = await rows(c.env, `SELECT v.id,v.id AS video_id,v.title,'video' AS kind,v.title AS body,NULL AS start,NULL AS cue,NULL AS record_id
    FROM library v WHERE v.user_id=? AND (v.title LIKE ? ESCAPE '\\' OR v.tags_json LIKE ? ESCAPE '\\')${scope.sql}
    ORDER BY v.updated_at DESC LIMIT 20`,userId,escaped,escaped,...scope.args);
  return c.json({results:[...titles,...results]});
});
learning.post('/',async c => {
  const userId = c.get('user').id;
  const {url} = z.object({url:z.string().max(2000)}).parse(await c.req.json());
  let input: ReturnType<typeof mediaInput>;
  try { input = mediaInput(url); } catch(e) { throw new AppError(400,(e as Error).message); }
  const existing = await row<{id:string}>(c.env,'SELECT id FROM library WHERE user_id=? AND youtube_id=?',userId,input.identity);
  if(existing) return c.json({id:existing.id,existing:true});
  await rateLimit(c.env,`learning-import:${userId}`,20,86400);
  const count = await row<{count:number}>(c.env,'SELECT COUNT(*) AS count FROM library WHERE user_id=?',userId);
  if((count?.count||0)>=200) throw new AppError(422,'The preview library limit is 200 videos.');
  const id=uid();
  await run(c.env,`INSERT OR IGNORE INTO library(id,user_id,youtube_id,url,title,platform,source_id,media_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id,userId,input.identity,input.url,`${platformName(input.platform)} · ${input.id}`,input.platform,input.id,input.mediaKind,now(),now());
  const created = (await row<{id:string}>(c.env,'SELECT id FROM library WHERE user_id=? AND youtube_id=?',userId,input.identity))!;
  if(created.id===id) await enqueueLearning(c.env,id,'learning');
  return c.json({id:created.id,existing:created.id!==id},202);
});
learning.get('/:id',async c => {
  const detail=await learningDetail(c.env,c.get('user').id,c.req.param('id'));
  if(detail.video.platform!=='youtube'&&['queued','importing'].includes(detail.video.caption_status))
    c.executionCtx.waitUntil(processImport(c.env,detail.video.id));
  return c.json(detail);
});
learning.on(['GET','HEAD'],'/:id/media',async c=>{
  const video=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  if(video.platform==='youtube'||!video.media_key)throw new AppError(404,'Media is not ready yet.');
  const headers=new Headers({Authorization:`Bearer ${c.env.CAPTION_SERVICE_SECRET}`});
  const range=c.req.header('Range');
  if(range){if(!/^bytes=\d*-\d*$/.test(range))throw new AppError(416,'Use a single byte range.');headers.set('Range',range);}
  const upstream=await fetch(mediaEndpoint(c.env,`/media/${video.media_key}`),{
    method:c.req.method,headers,redirect:'manual',signal:c.req.raw.signal,
  });
  if(![200,206,416].includes(upstream.status)){await upstream.body?.cancel();throw new AppError(502,'Media playback is unavailable. Please retry shortly.');}
  const output=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges']){
    const value=upstream.headers.get(name);if(value)output.set(name,value);
  }
  return new Response(c.req.method==='HEAD'?null:upstream.body,{status:upstream.status,headers:output});
});
learning.get('/:id/reading',async c=>{
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  return c.json(await readingTools(c.env,v));
});
learning.post('/:id/reading',async c=>{
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const input=z.object({kind:z.enum(['chapters','translation']),cue:z.number().int().min(0).max(11999).default(0),ai:z.boolean().default(false)}).parse(await c.req.json());
  await rateLimit(c.env,`reading-tools:${v.user_id}`,40,86400);
  return c.json(await requestReading(c.env,v,input.kind,input.cue,input.ai),202);
});
learning.patch('/:id',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const body=z.object({
    tags:tagsInput.optional(),
    status:z.enum(['new','learning','complete']).optional(),
    activity:z.literal('playback').optional(),
    playback:z.number().finite().min(0).max(14400).optional(),
    readingCue:z.number().int().min(0).max(12000).optional(),
  }).parse(await c.req.json());
  const captions=await captionFor(c.env,v.id,v.selected_track);
  if(body.readingCue !== undefined && captions && body.readingCue>=captions.cues.length) throw new AppError(400,'Reading position is outside this transcript.');
  const sets=['updated_at=?'],args:unknown[]=[now()];
  if(body.tags!==undefined){sets.push('tags_json=?');args.push(JSON.stringify(body.tags));}
  if(body.status!==undefined){sets.push('learning_status=?');args.push(body.status);}
  else if(body.activity==='playback')sets.push("learning_status=CASE WHEN learning_status='new' THEN 'learning' ELSE learning_status END");
  if(body.playback!==undefined){sets.push('playback_position=?');args.push(Math.min(body.playback,v.duration||14400));}
  if(body.readingCue!==undefined){sets.push('reading_cue=?');args.push(body.readingCue);}
  await run(c.env,`UPDATE library SET ${sets.join(',')} WHERE id=? AND user_id=?`,...args,v.id,v.user_id);
  return c.json({ok:true});
});
learning.post('/:id/import',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  if(['queued','importing'].includes(v.caption_status)) return c.json({ok:true});
  const {trackId}=z.object({trackId:z.string().max(120).optional()}).parse(await c.req.json());
  if(trackId&&!JSON.parse(v.tracks_json).some((t:{id:string})=>t.id===trackId)) throw new AppError(400,'Select an available caption track.');
  await rateLimit(c.env,`learning-retry:${v.user_id}`,30,86400);
  const cached=trackId?await captionFor(c.env,v.id,trackId):null;
  if(cached){
    const entries=[c.env.DB.prepare("DELETE FROM learning_search WHERE video_id=? AND kind='transcript'").bind(v.id)];
    for(let i=0;i<cached.cues.length;i+=12)entries.push(
      c.env.DB.prepare('INSERT INTO learning_search VALUES(?,?,?,?,?,?,?,NULL)')
        .bind(`${v.id}:caption:${i}`,v.user_id,v.id,'transcript',cached.cues.slice(i,i+12).map(c=>c.text).join('\n'),cached.cues[i].start,i));
    for(let i=0;i<entries.length;i+=50)await c.env.DB.batch(entries.slice(i,i+50));
    await run(c.env,"UPDATE library SET selected_track=?,caption_status=?,reading_cue=MIN(reading_cue,?),error=NULL WHERE id=?",
      trackId,cached.completeness==='complete'?'ready':'partial',Math.max(0,cached.cues.length-1),v.id);
    return c.json({ok:true});
  }
  await run(c.env,"UPDATE library SET caption_status='queued',selected_track=?,error=NULL,import_attempt=import_attempt+1,lease_until=0,import_token=NULL WHERE id=?",trackId??v.selected_track,v.id);
  await enqueueLearning(c.env,v.id,'learning');
  return c.json({ok:true},202);
});
learning.delete('/:id',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const keys=await rows<{object_key:string}>(c.env,'SELECT object_key FROM caption_tracks WHERE video_id=?',v.id);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM learning_outbox WHERE id=? OR id IN (SELECT id FROM learning_questions WHERE video_id=?) OR id IN (SELECT id FROM reading_tasks WHERE video_id=?)').bind(v.id,v.id,v.id),
    c.env.DB.prepare('DELETE FROM library WHERE id=?').bind(v.id),
  ]);
  if(keys.length) await c.env.MEDIA.delete(keys.map(k=>k.object_key));
  return c.json({ok:true});
});
learning.put('/:id/drafts/:draftId',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const id=z.string().uuid().parse(c.req.param('draftId'));
  const input=z.object({
    body:z.string().max(12000),anchor:z.unknown().optional(),
    recordId:z.string().uuid().optional(),recordRevision:z.number().int().positive().optional(),sourceQuestionId:z.string().uuid().optional(),
  }).parse(await c.req.json());
  const anchor=input.anchor?await validAnchor(c.env,v,input.anchor):null;
  let source=await noteSource(c.env,v,input.sourceQuestionId,anchor);
  if(input.recordId){
    if(!input.recordRevision)throw new AppError(400,'Keep the note revision when saving an edit draft.');
    const record=await row<{anchor_json:string|null;source_question_id:string|null}>(c.env,
      "SELECT anchor_json,source_question_id FROM learning_records WHERE id=? AND video_id=? AND user_id=? AND kind='note'",input.recordId,v.id,v.user_id);
    if(!record)throw new AppError(404,'Note not found.');
    if(record.anchor_json!==(anchor?JSON.stringify(anchor):null))throw new AppError(400,'Keep the note’s original passage.');
    source=record.source_question_id;
  }
  // An autosave finishing after a new note was saved must not recreate its draft.
  if(!input.recordId&&await row(c.env,'SELECT id FROM learning_records WHERE id=? AND video_id=? AND user_id=?',id,v.id,v.user_id))
    return c.json({ok:true,saved:true});
  const count=await row<{n:number}>(c.env,'SELECT COUNT(*) AS n FROM learning_drafts WHERE video_id=? AND user_id=?',v.id,v.user_id);
  if((count?.n||0)>=100&&!await row(c.env,'SELECT id FROM learning_drafts WHERE id=? AND video_id=? AND user_id=?',id,v.id,v.user_id))
    throw new AppError(422,'Save or discard an existing draft before starting another.');
  const result=await run(c.env,`INSERT INTO learning_drafts(id,user_id,video_id,record_id,record_revision,source_question_id,body,anchor_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at
    WHERE learning_drafts.user_id=excluded.user_id AND learning_drafts.video_id=excluded.video_id
    AND learning_drafts.record_id IS excluded.record_id AND learning_drafts.anchor_json IS excluded.anchor_json
    AND learning_drafts.record_revision IS excluded.record_revision
    AND learning_drafts.source_question_id IS excluded.source_question_id`,
    id,v.user_id,v.id,input.recordId||null,input.recordRevision||null,source,input.body,anchor?JSON.stringify(anchor):null,now());
  if(!result.meta.changes)throw new AppError(409,'This draft belongs to a different passage. Reopen it before editing.');
  return c.json({ok:true});
});
learning.delete('/:id/drafts/:draftId',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  await run(c.env,'DELETE FROM learning_drafts WHERE id=? AND video_id=? AND user_id=?',c.req.param('draftId'),v.id,v.user_id);
  return c.json({ok:true});
});
learning.post('/:id/records',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const input=z.object({id:z.string().uuid(),kind:z.enum(['highlight','note']),body:z.string().trim().max(12000).default(''),anchor:z.unknown().optional(),sourceQuestionId:z.string().uuid().optional()}).parse(await c.req.json());
  const prior=await row<{id:string}>(c.env,'SELECT id FROM learning_records WHERE id=? AND user_id=? AND video_id=?',input.id,v.user_id,v.id);
  if(prior)return c.json({ok:true,id:prior.id});
  const anchor=input.anchor?await validAnchor(c.env,v,input.anchor):null;
  if(input.kind==='highlight'&&!anchor)throw new AppError(400,'Select text to highlight.');
  if(input.kind==='note'&&!input.body)throw new AppError(400,'Write a note before saving.');
  if(input.kind!=='note'&&input.sourceQuestionId)throw new AppError(400,'Only notes can be saved from an AI answer.');
  const source=await noteSource(c.env,v,input.sourceQuestionId,anchor);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO learning_records(id,user_id,video_id,kind,body,anchor_json,source_question_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(input.id,v.user_id,v.id,input.kind,input.body,anchor?JSON.stringify(anchor):null,source,now(),now()),
    recordSearch(c.env,input.id,v.user_id,v.id,input.kind,`${anchor?.quote||''}\n${input.body}`,anchor),
    c.env.DB.prepare('DELETE FROM learning_drafts WHERE id=? AND video_id=? AND user_id=?').bind(input.id,v.id,v.user_id),
  ]);
  await touchVideo(c.env,v.id);
  return c.json({ok:true,id:input.id});
});
learning.patch('/:id/records/:recordId',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const record=await row<{kind:string;anchor_json:string|null;revision:number}>(c.env,'SELECT * FROM learning_records WHERE id=? AND video_id=? AND user_id=?',c.req.param('recordId'),v.id,v.user_id);
  if(!record)throw new AppError(404,'Note not found.');
  const {body,revision,draftId}=z.object({body:z.string().trim().min(1).max(12000),revision:z.number().int().positive(),draftId:z.string().uuid().optional()}).parse(await c.req.json());
  if(record.kind!=='note')throw new AppError(400,'Highlights have no editable note text.');
  const updated=await run(c.env,'UPDATE learning_records SET body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',body,now(),c.req.param('recordId'),revision);
  if(!updated.meta.changes)throw new AppError(409,'This note changed in another tab. Reload it before saving.');
  const anchor=record.anchor_json?JSON.parse(record.anchor_json):null;
  const statements=[recordSearch(c.env,c.req.param('recordId'),v.user_id,v.id,'note',`${anchor?.quote||''}\n${body}`,anchor)];
  if(draftId)statements.push(c.env.DB.prepare('DELETE FROM learning_drafts WHERE id=? AND record_id=? AND user_id=?').bind(draftId,c.req.param('recordId'),v.user_id));
  await c.env.DB.batch(statements);
  await touchVideo(c.env,v.id);
  return c.json({ok:true});
});
learning.delete('/:id/records/:recordId',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const id=c.req.param('recordId');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM learning_records WHERE id=? AND video_id=? AND user_id=?').bind(id,v.id,v.user_id),
    c.env.DB.prepare('DELETE FROM learning_search WHERE id=? AND video_id=? AND user_id=?').bind(id,v.id,v.user_id),
  ]);
  return c.json({ok:true});
});
learning.post('/:id/questions',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  const input=z.object({id:z.string().uuid(),question:z.string().trim().min(2).max(2000),anchor:z.unknown(),conversationId:z.string().uuid().optional()}).parse(await c.req.json());
  const prior=await row(c.env,'SELECT id FROM learning_questions WHERE id=? AND user_id=? AND video_id=?',input.id,v.user_id,v.id);
  if(prior)return c.json({id:input.id});
  if(!aiEnabled(c.env))throw new AppError(503,'AI is not configured yet. Your reading and notes are available.');
  const anchor=await validAnchor(c.env,v,input.anchor);
  if(input.conversationId&&!await row(c.env,'SELECT id FROM learning_questions WHERE conversation_id=? AND user_id=? AND video_id=?',input.conversationId,v.user_id,v.id))
    throw new AppError(404,'Conversation not found.');
  if(await row(c.env,"SELECT id FROM learning_questions WHERE user_id=? AND status IN ('queued','running')",v.user_id))
    throw new AppError(409,'Wait for your current AI answer or stop it before sending another question.');
  await rateLimit(c.env,`learning-ai:${v.user_id}`,20,86400);
  const conversation=input.conversationId||input.id;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO learning_questions(id,user_id,video_id,conversation_id,question,anchor_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(input.id,v.user_id,v.id,conversation,input.question,JSON.stringify(anchor),now(),now()),
    recordSearch(c.env,input.id,v.user_id,v.id,'question',input.question,anchor),
  ]);
  await enqueueLearning(c.env,input.id,'ai');
  return c.json({id:input.id},202);
});
learning.post('/:id/questions/:questionId/stop',async c => {
  const v=await ownVideo(c.env,c.get('user').id,c.req.param('id'));
  await run(c.env,"UPDATE learning_questions SET status='cancelled',error='Stopped. A request already sent to the AI service may still incur provider costs.',updated_at=? WHERE id=? AND video_id=? AND user_id=? AND status IN ('queued','running')",now(),c.req.param('questionId'),v.id,v.user_id);
  return c.json({ok:true});
});
