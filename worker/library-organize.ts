import { z } from 'zod';
import { tagKey, tagName, uniqueTags, type LibraryNote } from '../shared/learning';
import { AppError, now, rows, run, type Env } from './env';
import { type VideoRow } from './learning-store';

export const organizationInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('add'),ids:z.array(z.string().uuid()).min(1).max(200),tag:tagName}),
  z.object({action:z.literal('remove'),ids:z.array(z.string().uuid()).min(1).max(200),tag:tagName}),
  z.object({action:z.literal('rename'),from:tagName,to:tagName}),
]);
export async function organize(env:Env,userId:string,input:z.infer<typeof organizationInput>) {
  const library=await rows<VideoRow>(env,'SELECT * FROM library WHERE user_id=? LIMIT 200',userId);
  const ids='ids' in input?[...new Set(input.ids)]:null;
  if(ids?.some(id=>!library.some(v=>v.id===id)))throw new AppError(404,'Choose videos from your own library.');
  const existing=uniqueTags(library.flatMap(v=>JSON.parse(v.tags_json) as string[]));
  const target=input.action==='rename'?input.to:input.tag;
  const canonical=existing.find(t=>tagKey(t)===tagKey(target))||target;
  const changes=library.filter(v=>ids?ids.includes(v.id):input.action==='rename'&&(JSON.parse(v.tags_json) as string[]).some(t=>tagKey(t)===tagKey(input.from))).map(v=>{
    const before=JSON.parse(v.tags_json) as string[];
    const tags=uniqueTags(input.action==='add'?[...before,canonical]:
      input.action==='remove'?before.filter(t=>tagKey(t)!==tagKey(input.tag)):
      before.map(t=>tagKey(t)===tagKey(input.from)?(tagKey(input.from)===tagKey(input.to)?input.to:canonical):t));
    if(tags.length>12)throw new AppError(422,'A video can have up to 12 tags. Remove a tag before adding another.');
    return {id:v.id,before:v.tags_json,tags};
  });
  if(!changes.length)return;
  // One conditional statement: concurrent edits abort the whole operation.
  // JSON payload also keeps parameter count below D1's binding limit.
  const result=await run(env,`WITH changes AS (
    SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.before') AS before,
      json_extract(value,'$.tags') AS tags FROM json_each(?)),
    valid AS MATERIALIZED (SELECT NOT EXISTS (
      SELECT 1 FROM changes LEFT JOIN library v ON v.id=changes.id AND v.user_id=?
      WHERE v.id IS NULL OR v.tags_json!=changes.before) AS ok)
    UPDATE library SET tags_json=(SELECT tags FROM changes WHERE changes.id=library.id),updated_at=?
    WHERE user_id=? AND id IN (SELECT id FROM changes)
    AND (SELECT ok FROM valid)`,
    JSON.stringify(changes),userId,now(),userId);
  if(result.meta.changes!==changes.length)throw new AppError(409,'Tags changed in another tab. Refresh and try again.');
}
export function libraryScope(query:{tag?:string;untagged?:string;status?:string},alias='v') {
  const conditions:string[]=[],args:unknown[]=[];
  if(query.tag){conditions.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags_json) WHERE lower(value)=lower(?))`);args.push(tagName.parse(query.tag));}
  if(query.untagged==='1')conditions.push(`json_array_length(${alias}.tags_json)=0`);
  if(query.status&&query.status!=='all'){conditions.push(`${alias}.learning_status=?`);args.push(z.enum(['new','learning','complete']).parse(query.status));}
  return {sql:conditions.length?' AND '+conditions.join(' AND '):'',args};
}
export const escapeLike=(q:string)=>`%${q.replace(/[\\%_]/g,'\\$&')}%`;
export function visibleNote(r:{anchor_json:string|null;tags_json:string}&Omit<LibraryNote,'anchor'|'tags'>):LibraryNote {
  const {anchor_json,tags_json,...note}=r;
  return {...note,anchor:anchor_json?JSON.parse(anchor_json):null,tags:JSON.parse(tags_json)};
}
