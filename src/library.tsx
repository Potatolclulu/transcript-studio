import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, Circle, Clock3, Library, Loader2, Play, Plus, Search, Settings2, StickyNote, Tag, Trash2, X } from 'lucide-react';
import { tagKey, uniqueTags, platformName, type LibraryVideo, type NotesPage, type LibraryNote, type SearchResult } from '../shared/learning';
import { learningApi } from './learning-api';

const time=(s:number)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const statusLabel=(s:string)=>({new:'Not started',learning:'Learning',complete:'Completed',queued:'Waiting for captions',importing:'Importing captions',ready:'Captions ready',partial:'Partial captions',none:'No captions available',error:'Import needs attention'}[s]||s);
const date=(n:number)=>new Date(n*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
function excerpt(text:string,q:string){const at=Math.max(0,text.toLowerCase().indexOf(q.toLowerCase())-80);return(at?'…':'')+text.slice(at,at+260)+(text.length>at+260?'…':'');}

export function OrganizationDialog({title,close,children}:{title:string;close:()=>void;children:React.ReactNode}){
  const box=useRef<HTMLElement>(null),onClose=useRef(close);onClose.current=close;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement;
    const first=()=>box.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    first();
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();onClose.current();}
      if(e.key==='Tab'){
        const nodes=Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')||[]);
        if(!nodes.length)return;
        if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus();}
        else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}
      }
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.isConnected&&previous.focus();};
  },[]);
  return <div className="ll-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}>
    <section ref={box} className="ll-modal ll-organize-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <button className="ll-modal-close ll-icon" aria-label={`Close ${title}`} onClick={close}><X size={20}/></button>
      <h2>{title}</h2>{children}
    </section>
  </div>;
}
export function TagEditor({ids,tags,options,changed}:{ids:string[];tags:string[];options:string[];changed:()=>Promise<void>}){
  const [value,setValue]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function update(action:'add'|'remove',tag:string){
    setBusy(true);setError('');setNotice('');
    try{await learningApi('/library/tags',{action,ids,tag});await changed();setValue('');setNotice(action==='add'?'Tag added.':'Tag removed.');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const suggestions=options.filter(t=>tagKey(t).includes(tagKey(value))&&(ids.length>1||!tags.some(s=>tagKey(s)===tagKey(t))));
  return <div className="ll-tag-editor">
    <p>{ids.length===1?'Use tags to group videos by topic.':`Add or remove tags on ${ids.length} selected videos.`}</p>
    <div className="ll-edit-tags">{tags.map(t=><span key={t}>#{t}<button disabled={busy} aria-label={`Remove tag ${t}`} onClick={()=>void update('remove',t)}><X size={12}/></button></span>)}{!tags.length&&<small>No tags yet.</small>}</div>
    <form className="ll-tag-form" onSubmit={e=>{e.preventDefault();void update('add',value);}}>
      <label htmlFor="ll-tag-name">Add or create a tag</label><div><input id="ll-tag-name" autoComplete="off" maxLength={64} value={value} onChange={e=>setValue(e.target.value)} placeholder="e.g. AI, Philosophy, Writing" disabled={busy}/><button className="ll-button ll-solid" disabled={busy||!value.trim()}>{busy?<Loader2 size={15} className="ll-spin"/>:<Plus size={15}/>}Add tag</button></div>
    </form>
    {!!suggestions.length&&<div className="ll-tag-suggestions"><small>From your library</small><div>{suggestions.slice(0,12).map(t=><button disabled={busy} key={t} onClick={()=>void update('add',t)}>#{t}<Plus size={12}/></button>)}</div></div>}
    {error&&<p className="ll-inline-error" role="alert">{error}</p>}<p className="ll-tag-feedback" role="status">{notice}</p>
  </div>;
}
type Shelf={videos:LibraryVideo[];noteCounts:Record<string,number>};
export function LibraryPage({navigate,path,config}:{navigate:(s:string)=>void;path:string;config:{captions:boolean}}){
  const params=new URLSearchParams(path.split('?')[1]||''),mode=path.split('?')[0]==='/library/notes'?'notes':'videos';
  const query=params.get('q')||'',filter=params.get('status')||'all',tag=params.get('tag')||'',untagged=params.get('untagged')==='1';
  const [shelf,setShelf]=useState<Shelf>({videos:[],noteCounts:{}}),[loaded,setLoaded]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [input,setInput]=useState(query),[results,setResults]=useState<SearchResult[]>([]),[notes,setNotes]=useState<LibraryNote[]>([]),[total,setTotal]=useState(0),[cursor,setCursor]=useState<string|null>(null),[searching,setSearching]=useState(false),[more,setMore]=useState(false);
  const [selection,setSelection]=useState<string[]>([]),[selecting,setSelecting]=useState(false),[editing,setEditing]=useState<string[]|null>(null),[manage,setManage]=useState(false),[from,setFrom]=useState(''),[to,setTo]=useState(''),[version,setVersion]=useState(0);
  const {videos,noteCounts}=shelf;
  const scope=new URLSearchParams();
  if(tag)scope.set('tag',tag);if(untagged)scope.set('untagged','1');if(filter!=='all')scope.set('status',filter);if(query)scope.set('q',query);
  const scopeKey=scope.toString(),activeRequest=useRef(0);
  function route(patch:Record<string,string|null>,nextMode=mode,replace=false){
    const p=new URLSearchParams(scope);for(const [k,v] of Object.entries(patch)){if(v)p.set(k,v);else p.delete(k);}
    const next=`/library${nextMode==='notes'?'/notes':''}${p.size?'?'+p.toString():''}`;
    if(replace){history.replaceState({},'',next);window.dispatchEvent(new PopStateEvent('popstate'));}
    else navigate(next);
  }
  async function load(){const data=await learningApi<Shelf>('/library');setShelf(data);setLoaded(true);}
  async function changed(){await load();setVersion(n=>n+1);}
  useEffect(()=>{let alive=true;const refresh=()=>learningApi<Shelf>('/library').then(s=>{if(alive){setShelf(s);setLoaded(true);}}).catch(e=>{if(alive)setError(e.message);});
    void refresh();const timer=setInterval(refresh,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  useEffect(()=>{setInput(query);},[query]);
  useEffect(()=>{
    if(input===query)return;
    const timer=setTimeout(()=>route({q:input.trim()||null},mode,true),300);
    return()=>clearTimeout(timer);
  },[input,query,mode,tag,untagged,filter]);
  useEffect(()=>{
    const request=++activeRequest.current;setResults([]);setNotes([]);setCursor(null);
    if(mode==='videos'&&query.trim().length<2){setSearching(false);return;}
    setSearching(true);
    void learningApi<NotesPage&{results:SearchResult[]}>(`/library/${mode==='notes'?'notes':'search'}?${scopeKey}`).then(r=>{
      if(request!==activeRequest.current)return;
      if(mode==='notes'){setNotes(r.notes);setTotal(r.total);setCursor(r.nextCursor);}else setResults(r.results);
    }).catch(e=>{if(request===activeRequest.current)setError(e.message);}).finally(()=>{if(request===activeRequest.current)setSearching(false);});
    return()=>{activeRequest.current++;};
  },[scopeKey,mode,version]);
  useEffect(()=>{setSelection([]);setSelecting(false);},[mode,tag,untagged,filter,query]);
  const tags=uniqueTags(videos.flatMap(v=>v.tags)).sort((a,b)=>a.localeCompare(b));
  const tagged=(v:LibraryVideo)=>!tag||v.tags.some(t=>tagKey(t)===tagKey(tag));
  const visible=videos.filter(v=>(filter==='all'||v.learning_status===filter)&&tagged(v)&&(!untagged||!v.tags.length));
  const editingVideos=videos.filter(v=>editing?.includes(v.id));
  const noteTotal=Object.values(noteCounts).reduce((a,b)=>a+b,0);
  const scoped=!!tag||untagged||filter!=='all';
  async function loadMore(){
    if(!cursor||more)return;const request=activeRequest.current;setMore(true);
    try{const r=await learningApi<NotesPage>(`/library/notes?${scopeKey}&cursor=${encodeURIComponent(cursor)}`);if(request===activeRequest.current){setNotes(n=>[...n,...r.notes.filter(v=>!n.some(x=>x.id===v.id))]);setCursor(r.nextCursor);}}
    catch(e){setError((e as Error).message);}finally{setMore(false);}
  }
  return <main className="ll-library">
    <aside className="ll-shelf-nav"><div className="ll-kicker">Library</div>
      <button className={`ll-shelf-destination ${mode==='videos'?'active':''}`} aria-current={mode==='videos'?'page':undefined} onClick={()=>route({},'videos')}><Library size={16}/>All videos<span>{videos.length}</span></button>
      <button className={`ll-shelf-destination ${mode==='notes'?'active':''}`} aria-current={mode==='notes'?'page':undefined} onClick={()=>route({},'notes')}><StickyNote size={16}/>All notes<span>{noteTotal}</span></button>
      <div className="ll-shelf-divider"/><div className="ll-kicker">Learning status</div>
      {(['all','new','learning','complete'] as const).map(s=><button className={filter===s?'active':''} aria-pressed={filter===s} key={s} onClick={()=>route({status:s==='all'?null:s})}>{s==='complete'?<Check size={16}/>:s==='learning'?<Clock3 size={16}/>:<Circle size={16}/>} {s==='all'?'Any status':statusLabel(s)}</button>)}
      <div className="ll-shelf-divider"/><div className="ll-topics-heading"><div className="ll-kicker">Tags</div><button className="ll-icon" aria-label="Manage tags" onClick={()=>{setFrom(tags[0]||'');setTo('');setManage(true);}}><Settings2 size={16}/></button></div>
      <button className={!tag&&!untagged?'active':''} onClick={()=>route({tag:null,untagged:null})}>All tags</button>
      <button className={untagged?'active':''} onClick={()=>route({tag:null,untagged:'1'})}>Untagged<span>{videos.filter(v=>!v.tags.length).length}</span></button>
      {tags.map(t=><button key={t} className={tagKey(tag)===tagKey(t)?'active':''} onClick={()=>route({tag:t,untagged:null})}><span className="ll-tag-nav-name"># {t}</span><span>{videos.filter(v=>v.tags.some(s=>tagKey(s)===tagKey(t))).length}</span></button>)}
    </aside>
    <section className="ll-shelf-content">
      <div className="ll-shelf-heading"><div><h1>{mode==='notes'?'Your notes, together':'Your learning library'}</h1><p>{mode==='notes'?'Search your saved notes and return to the original passage.':'Read your videos, organize topics and pick up where you left off.'}</p></div></div>
      {mode==='videos'&&<><form className="ll-add-video" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const r=await learningApi('/library',{url});navigate(`/library/${r.id}`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Plus size={18}/><input aria-label="Video or podcast URL" value={url} onChange={e=>setUrl(e.target.value)} placeholder="Paste a YouTube, bilibili or Xiaoyuzhou link…"/><button className="ll-button ll-solid" disabled={busy||!url.trim()}>{busy?<Loader2 size={16} className="ll-spin"/>:'Add to library'}<ArrowRight size={15}/></button></form><p className="ll-muted">YouTube · bilibili · Xiaoyuzhou. Public videos and podcast episodes.</p>
        {!config.captions&&<p className="ll-inline-notice">Links can be saved. Caption import needs a configured acquisition service.</p>}</>}
      {error&&<div className="ll-inline-error" role="alert">{error}<button onClick={()=>{setError('');void changed().catch(e=>setError(e.message));}}>Retry</button><button aria-label="Dismiss library error" onClick={()=>setError('')}><X size={14}/></button></div>}
      <div className="ll-shelf-tools"><span>{mode==='notes'?`${searching?'…':total} saved ${total===1?'note':'notes'} · Recently edited`:query.trim().length>=2?'Search videos, transcripts and records':`${visible.length} ${visible.length===1?'video':'videos'} · Recently learned`}</span><label><Search size={16}/><input aria-label={mode==='notes'?'Search all notes':'Search your library'} placeholder={mode==='notes'?'Search notes and quoted passages…':'Search your learning…'} value={input} onChange={e=>setInput(e.target.value)}/>{input&&<button className="ll-icon" aria-label="Clear search" onClick={()=>setInput('')}><X size={12}/></button>}</label>
        {mode==='videos'&&query.trim().length<2&&!!visible.length&&<button className="ll-link" onClick={()=>{setSelecting(!selecting);setSelection([]);}}>{selecting?'Done':'Select videos'}</button>}
      </div>
      {scoped&&<div className="ll-active-scope"><span>{tag?'# '+tag:untagged?'Untagged':'All tags'}{filter!=='all'?' · '+statusLabel(filter):''}</span><button onClick={()=>route({tag:null,untagged:null,status:null})}>Clear filters <X size={12}/></button></div>}
      {selecting&&<div className="ll-bulk-tools"><label><input type="checkbox" aria-label="Select all visible videos" checked={!!visible.length&&visible.every(v=>selection.includes(v.id))} onChange={e=>setSelection(e.target.checked?visible.map(v=>v.id):[])}/>Select all</label><span>{selection.length} selected</span><button className="ll-button" disabled={!selection.length} onClick={()=>setEditing(selection)}><Tag size={14}/>Edit tags</button></div>}
      {(!loaded||searching)?<div className="ll-empty" role="status"><Loader2 size={24} className="ll-spin"/>Loading your {mode==='notes'?'notes':'library'}…</div>:
        mode==='notes'?<div className="ll-all-notes">
          {notes.map(n=><article className="ll-saved-note" key={n.id}><div className="ll-note-meta"><span>{date(n.updated_at)}</span>{n.source_question_id&&<span>Saved from AI Q&amp;A</span>}</div><p className="ll-note-body">{n.body}</p>{n.anchor&&<blockquote>{n.anchor.quote}</blockquote>}
            <button className="ll-note-source" aria-label={`Open source for note ${n.body.slice(0,40)}`} onClick={()=>navigate(`/library/${n.video_id}?${n.anchor?`cue=${n.anchor.firstCue}&`:''}record=${n.id}`)}><BookOpen size={14}/><span>{n.title}</span>{n.anchor&&<time>{time(n.anchor.start)}</time>}<ArrowRight size={14}/></button>
            <div className="ll-note-tags">{n.tags.map(t=><button key={t} onClick={()=>route({tag:t,untagged:null})}>#{t}</button>)}</div>
          </article>)}
          {!notes.length&&<div className="ll-first-video"><StickyNote size={34}/><h2>{query||scoped?'No notes in this view.':'Your thoughts will find a home here.'}</h2><p>{query||scoped?'Try another keyword or clear your filters.':'Save a note beside a video passage. It will appear here with its source.'}</p>{query||scoped?<button className="ll-link" onClick={()=>route({q:null,tag:null,untagged:null,status:null})}>Show all notes</button>:<button className="ll-link" onClick={()=>route({},'videos')}>Go to your videos <ArrowRight size={14}/></button>}</div>}
          {cursor&&<button className="ll-button ll-load-more" disabled={more} onClick={()=>void loadMore()}>{more?'Loading…':'Load more notes'}</button>}
        </div>:
        query.trim().length>=2?<div className="ll-search-results">{results.map(r=><button key={`${r.kind}:${r.id}`} onClick={()=>navigate(`/library/${r.video_id}?${r.cue!==null?`cue=${r.cue}&`:''}${r.record_id?`record=${r.record_id}`:''}`)}><small>{r.kind==='transcript'?'Original transcript':r.kind==='question'?'AI question':r.kind==='video'?'Video':'Your '+r.kind}{r.start!==null&&` · ${time(r.start)}`}</small><h3>{r.title}</h3><p>{excerpt(r.body,query)}</p><ChevronRight size={16}/></button>)}{!results.length&&<div className="ll-empty"><Search size={26}/><p>No matches in this view.</p></div>}</div>:
        <div className="ll-video-list">{visible.map(v=><article className="ll-video-row ll-organized-row" key={v.id}>
          {selecting&&<input className="ll-video-select" type="checkbox" aria-label={`Select ${v.title}`} checked={selection.includes(v.id)} onChange={e=>setSelection(s=>e.target.checked?[...s,v.id]:s.filter(id=>id!==v.id))}/>}
          <button className="ll-video-open" onClick={()=>navigate(`/library/${v.id}`)}><div className="ll-video-number"><Play size={20}/>{v.duration>0&&<span>{Math.ceil(v.duration/60)} min</span>}</div><div className="ll-video-copy"><div className="ll-video-meta">{platformName(v.platform)}{v.author&&<> <span>·</span> {v.author}</>} <span>·</span> {statusLabel(v.learning_status)}</div><h2>{v.title}</h2><div className="ll-video-bottom"><span className={v.caption_status==='error'?'ll-error-text':''}>{v.caption_status==='error'?statusLabel(v.caption_status):v.import_progress||statusLabel(v.caption_status)}</span><span>{noteCounts[v.id]||0} notes</span></div></div><ArrowRight size={16}/></button>
          <div className="ll-row-tags">{v.tags.map(t=><button key={t} onClick={()=>route({tag:t,untagged:null})}>#{t}</button>)}<button aria-label={`Edit tags for ${v.title}`} onClick={()=>setEditing([v.id])}><Plus size={12}/>{v.tags.length?'Edit tags':'Add tag'}</button></div>
          <button className="ll-icon ll-delete-video" aria-label={`Delete ${v.title}`} onClick={async()=>{if(!confirm('Delete this video and all of your notes, highlights and AI questions?'))return;try{await learningApi(`/library/${v.id}`,undefined,'DELETE');await changed();setSelection(s=>s.filter(id=>id!==v.id));}catch(e){setError((e as Error).message);}}}><Trash2 size={15}/></button>
        </article>)}
          {!visible.length&&<div className="ll-first-video"><BookOpen size={40}/><h2>{videos.length?'No recordings in this view.':'Start with an idea that stays with you.'}</h2><p>{videos.length?'Clear your filters or organize more recordings with this tag.':'Paste a public YouTube, bilibili or Xiaoyuzhou link above. The transcript becomes a place to read, highlight and think.'}</p>{videos.length?<button className="ll-link" onClick={()=>route({tag:null,untagged:null,status:null})}>Show all recordings</button>:<button className="ll-link" onClick={()=>setUrl('https://www.youtube.com/watch?v=arj7oStGLkU')}>Use a real English TED talk link →</button>}</div>}
        </div>}
    </section>
    {editing&&<OrganizationDialog title={editing.length===1?'Video tags':`Tags for ${editing.length} videos`} close={()=>setEditing(null)}><TagEditor ids={editing} tags={uniqueTags(editingVideos.flatMap(v=>v.tags))} options={tags} changed={changed}/></OrganizationDialog>}
    {manage&&<OrganizationDialog title="Manage tags" close={()=>setManage(false)}>{tags.length?<form className="ll-manage-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await learningApi('/library/tags',{action:'rename',from,to});await changed();if(tagKey(tag)===tagKey(from))route({tag:to.trim()});setManage(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><p>Rename a tag across your library. Choosing an existing name merges the two tags.</p><label>Current tag<select aria-label="Current tag" value={from} onChange={e=>setFrom(e.target.value)}>{tags.map(t=><option key={t}>{t}</option>)}</select></label><label>New or existing name<input aria-label="New tag name" value={to} onChange={e=>setTo(e.target.value)} maxLength={64} placeholder="Enter a tag name"/></label>{error&&<p role="alert" className="ll-inline-error">{error}</p>}<button className="ll-button ll-solid" disabled={busy||!to.trim()}>{busy?'Saving…':tags.some(t=>tagKey(t)===tagKey(to)&&tagKey(t)!==tagKey(from))?'Merge tags':'Rename tag'}</button></form>:<p>Add a tag to a video first. Your tags will appear here.</p>}</OrganizationDialog>}
  </main>;
}
