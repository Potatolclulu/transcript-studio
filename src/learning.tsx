import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, ExternalLink, Highlighter, Library, Loader2, LogOut, MessageCircle, Plus, Search, Settings2, Sparkles, StickyNote, Trash2, X } from 'lucide-react';
import { cueAt, quoteFrom, type Anchor, type Cue, type LearningDetail, type LearningDraft, type LearningQuestion, type LearningRecord, type LibraryVideo } from '../shared/learning';
import { learningApi } from './learning-api';
import { LibraryPage, OrganizationDialog, TagEditor } from './library';
import './learning.css';
import './learning-ui.css';
import { ChapterNavigator, TranslationControl, readingTime, useReadingTools, type ReadingMode } from './reading-tools';

type User = { id:string; email:string };
type Config = { demo:boolean; captions:boolean; ai:boolean; aiModel:string|null };
const time=readingTime;
const readableAnswer=(q:LearningQuestion,text:string|null)=> (text||'').replace(/\[(\d+)\]/g,(match,id)=>q.citations.includes(Number(id))?'':match);
const label=(status:string)=>({new:'Not started',learning:'Learning',complete:'Completed',queued:'Waiting for captions',importing:'Importing captions',ready:'Captions ready',partial:'Partial captions',none:'No captions available',error:'Import needs attention'}[status]||status);
function Logo(){return <span className="ll-logo"><BookOpen size={24}/><span>margin<span className="ll-logo-dot">.</span></span></span>;}
export function LearningApp(){
  const [path,setPath]=useState(location.pathname+location.search);
  const [user,setUser]=useState<User|null>(null),[config,setConfig]=useState<Config>({demo:false,captions:false,ai:false,aiModel:null});
  const [loaded,setLoaded]=useState(false),[login,setLogin]=useState(false),[error,setError]=useState('');
  const guard=useRef<()=>boolean>(()=>true);
  function navigate(to:string){
    if(!guard.current())return;
    history.pushState({},'',to);setPath(to);window.scrollTo(0,0);
  }
  async function refresh(){const result=await learningApi('/me');setUser(result.user);}
  useEffect(()=>{
    void Promise.all([learningApi<Config>('/config'),learningApi('/me')]).then(([c,m])=>{setConfig(c);setUser(m.user);}).catch(e=>setError(e.message)).finally(()=>setLoaded(true));
    const pop=()=>{if(!guard.current()){history.go(1);return;}setPath(location.pathname+location.search);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[]);
  useEffect(()=>{document.title=path.startsWith('/library')?'Your learning library — Margin':'Margin — A reading room for YouTube';
    document.querySelector('meta[name="description"]')?.setAttribute('content','A personal learning library for YouTube. Read along, highlight ideas, keep notes and return to your questions.');
    const robots=document.querySelector('meta[name="robots"]')||document.head.appendChild(Object.assign(document.createElement('meta'),{name:'robots'}));
    robots.setAttribute('content',path.startsWith('/library')||path.startsWith('/auth')?'noindex, nofollow':'index, follow');
  },[path]);
  useEffect(()=>{
    if(path.startsWith('/auth/verify')){
      const token=new URLSearchParams(location.hash.slice(1)).get('token');
      if(token){history.replaceState({},'','/auth/verify');void learningApi('/auth/verify',{token}).then(refresh).then(()=>navigate('/library')).catch(e=>setError(e.message));}
      else setError('This sign-in link has no token. Request a new link.');
    }
  },[path]);
  async function localPreview(){
    try{
      await learningApi('/auth/learning-preview',{});await refresh();navigate('/library');
    }catch(e){setError((e as Error).message);}
  }
  const videoId=path.split('?')[0]==='/library/notes'?undefined:path.match(/^\/library\/([\w-]+)/)?.[1];
  return <div className="ll-root">
    <header className="ll-header"><button aria-label="Margin home" onClick={()=>navigate(user?'/library':'/')}><Logo/></button>
      <nav>{user?<><button className="ll-nav-link" onClick={()=>navigate('/library')}><Library size={16}/>My library</button><span className="ll-account">{user.email}</span><button className="ll-icon" aria-label="Sign out" onClick={async()=>{if(!guard.current())return;await learningApi('/auth/logout',{});setUser(null);navigate('/');}}><LogOut size={17}/></button></>:<><span className="ll-nav-note">Watch. Read. Keep a thought.</span><button className="ll-button" onClick={()=>setLogin(true)}>Sign in <ArrowRight size={15}/></button></>}</nav>
    </header>
    {error&&<div className="ll-alert" role="alert">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}
    {!loaded?<div className="ll-empty"><Loader2 className="ll-spin"/>Opening your library…</div>:
      path.startsWith('/auth/verify')?<div className="ll-empty">Verifying your sign-in link… <button onClick={()=>setLogin(true)}>Request another link</button></div>:
      path.startsWith('/library')?user?(videoId?<Reader key={videoId} id={videoId} path={path} navigate={navigate} config={config} guard={guard}/>:<LibraryPage navigate={navigate} path={path} config={config}/>):<div className="ll-empty"><BookOpen size={32}/><h2>Your library is private.</h2><p>Sign in to find your videos and learning records.</p><button className="ll-button ll-solid" onClick={()=>setLogin(true)}>Sign in</button>{config.demo&&<button className="ll-link" onClick={localPreview}>Open local preview</button>}</div>:
      <main className="ll-landing"><div className="ll-hero"><div className="ll-kicker">Your videos, with room to think</div><h1>A reading room<br/>for YouTube.</h1><p>Read the transcript beside the video. Highlight a passage, write a note or ask a question. Keep it all in your personal library.</p><button className="ll-button ll-solid" onClick={()=>user?navigate('/library'):setLogin(true)}>Start your library <ArrowRight size={17}/></button>{config.demo&&<button className="ll-link" onClick={localPreview}>Open local preview →</button>}<div className="ll-hero-foot">For lectures, interviews and ideas worth returning to.</div></div>
        <div className="ll-book-preview"><div className="ll-preview-label"><span className="ll-dot"/>Read, then make a note <span>Example</span></div><div className="ll-preview-title">A question worth keeping</div><p className="ll-preview-author">Original example text · not a video transcript</p><div className="ll-preview-passage"><span>01:24</span><p>Some ideas make sense when we first hear them. <mark>Understanding deepens when we pause to ask a question of our own.</mark> A note gives that question somewhere to stay.</p></div><div className="ll-preview-note"><StickyNote size={16}/><div><small>Your note</small><p>What would it look like to use this idea in my work?</p></div></div><div className="ll-preview-tabs"><span><Highlighter size={16}/>Highlight</span><span><StickyNote size={16}/>Add note</span><span><Sparkles size={16}/>Ask AI</span></div></div>
        <div className="ll-principles"><div><span>01</span><h3>Collect your videos</h3><p>Group lectures and interviews by topic on one shelf.</p></div><div><span>02</span><h3>Read beside the source</h3><p>Follow the transcript and keep your notes in the margin.</p></div><div><span>03</span><h3>Find the idea again</h3><p>Search across videos and notes. Return to the exact passage.</p></div></div>
        <footer className="ll-footer">Private learning library · YouTube captions first · Early preview</footer>
      </main>}
    {login&&<SignIn close={()=>setLogin(false)} config={config} local={async()=>{await localPreview();setLogin(false);}}/>}
  </div>;
}
function SignIn({close,config,local}:{close:()=>void;config:Config;local:()=>Promise<void>}){
  const [email,setEmail]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[link,setLink]=useState('');
  return <div className="ll-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className="ll-modal" role="dialog" aria-modal="true" aria-label="Sign in"><button className="ll-modal-close ll-icon" aria-label="Close sign in" onClick={close}><X size={20}/></button><BookOpen size={26}/><h2>A place for your learning.</h2><p>Sign in with a one-time email link. Your library is only visible to you.</p>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setStatus('');try{const result=await learningApi('/auth/start',{email});setLink(result.developmentLink||'');setStatus(result.developmentLink?'Local development: use the link below. No email was sent.':'Check your inbox for a sign-in link.');}catch(e){setStatus((e as Error).message);}finally{setBusy(false);}}}><label htmlFor="ll-email">Email address</label><input id="ll-email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoFocus/><button className="ll-button ll-solid" disabled={busy}>{busy?'Sending…':'Send sign-in link'}</button></form>
    <p role="status">{status}</p>{link&&<a className="ll-link" href={link}>Open development sign-in link</a>}{config.demo&&<button className="ll-link" onClick={local}>Open local preview account</button>}
  </section></div>;
}

type PlayerHandle={seek:(seconds:number)=>void};
type YTPlayer={seekTo:(s:number,allow:boolean)=>void;playVideo:()=>void;getCurrentTime:()=>number;getPlayerState:()=>number;destroy:()=>void};
declare global{interface Window{YT?:{Player:new(el:HTMLElement,opts:unknown)=>YTPlayer};onYouTubeIframeAPIReady?:()=>void}}
let youtubeReady:Promise<void>|null=null;
function loadYouTube(){
  if(window.YT?.Player)return Promise.resolve();
  if(!youtubeReady)youtubeReady=new Promise((resolve,reject)=>{
    const old=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{old?.();resolve();};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{youtubeReady=null;reject(new Error('YouTube player could not be loaded.'));};document.head.appendChild(script);
    setTimeout(()=>{if(!window.YT?.Player){youtubeReady=null;reject(new Error('YouTube player is unavailable in this browser.'));}},15000);
  });
  return youtubeReady;
}
function VideoPlayer({video,onTime,handle,start}:{video:LibraryVideo;onTime:(time:number,playing:boolean)=>void;handle:React.RefObject<PlayerHandle|null>;start?:number}){
  const frame=useRef<HTMLIFrameElement>(null),callback=useRef(onTime),[error,setError]=useState(''),[ready,setReady]=useState(false);
  callback.current=onTime;
  useEffect(()=>{
    let alive=true,player:YTPlayer|undefined,timer:ReturnType<typeof setInterval>|undefined;
    const readiness=setTimeout(()=>{if(alive)setError('The embedded player has not connected. You can keep reading or open the original video.');},18000);
    void loadYouTube().then(()=>{
      if(!alive||!frame.current||!window.YT)return;
      player=new window.YT.Player(frame.current,{
        events:{onReady:()=>{clearTimeout(readiness);if(!alive)return;setReady(true);setError('');handle.current={seek:s=>{player?.seekTo(s,true);callback.current(s,false);player?.playVideo();}};timer=setInterval(()=>{try{callback.current(player!.getCurrentTime(),player!.getPlayerState()===1);}catch{}},300);},
          onStateChange:()=>{if(alive&&player)callback.current(player.getCurrentTime(),player.getPlayerState()===1);},
          onError:()=>{if(alive){setError('This video cannot be played here. Your transcript and notes remain available.');setReady(false);handle.current=null;}}}});
    }).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;clearTimeout(readiness);clearInterval(timer);handle.current=null;player?.destroy();};
  },[video.youtube_id]);
  const initialStart=useRef(Math.floor(start??video.playback_position));
  return <><div className="ll-player-host"><iframe ref={frame} title={`YouTube: ${video.title}`} src={`https://www.youtube.com/embed/${video.youtube_id}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(location.origin)}&start=${initialStart.current}`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"/></div>{!ready&&!error&&<p className="ll-player-status"><Loader2 size={14} className="ll-spin"/>Connecting transcript sync to YouTube…</p>}{error&&<p className="ll-inline-notice">{error} Transcript synchronization is paused.</p>}</>;
}
function centerTranscript(container:HTMLDivElement|null,cue:number,behavior:ScrollBehavior='auto'){
  const entry=container?.querySelector<HTMLElement>(`.ll-cue[data-cue="${cue}"]`);
  if(!container||!entry)return;
  const viewport=container.getBoundingClientRect(),passage=entry.getBoundingClientRect();
  const top=Math.max(0,viewport.top+container.clientTop),bottom=Math.min(window.innerHeight,viewport.top+container.clientTop+container.clientHeight);
  if(bottom<=top)return;
  const visibleHeight=bottom-top;
  // Keep a normal bilingual passage centered; unusually tall passages start inside the viewport.
  const focus=passage.height>visibleHeight-32?passage.top+visibleHeight/2-16:passage.top+passage.height/2;
  const target=Math.max(0,Math.min(container.scrollHeight-container.clientHeight,container.scrollTop+focus-(top+bottom)/2));
  if(Math.abs(target-container.scrollTop)>1)container.scrollTo({top:target,behavior});
}
const readerLayoutKey='margin.reader-layout.v1';
type ReaderLayout = {videoRatio:number;notesWidth:number};
const defaultReaderLayout:ReaderLayout={videoRatio:.5,notesWidth:320};
function readReaderLayout():ReaderLayout {
  try{
    const value=JSON.parse(localStorage.getItem(readerLayoutKey)||'null');
    if(value&&Number.isFinite(value.videoRatio)&&Number.isFinite(value.notesWidth))
      return {videoRatio:Math.max(.1,Math.min(.9,value.videoRatio)),notesWidth:Math.max(220,Math.min(520,value.notesWidth))};
  }catch{}
  return {...defaultReaderLayout};
}
function useReaderLayout(open:boolean,loaded:boolean,reader:React.RefObject<HTMLDivElement|null>){
  const columns=useRef<HTMLDivElement>(null);
  const [preference,setPreference]=useState(readReaderLayout),[width,setWidth]=useState(0),[resizing,setResizing]=useState(false);
  const drag=useRef<{kind:'video'|'notes';pointer:number;x:number;video:number;notes:number;budget:number}|null>(null);
  const readingPosition=useRef<{cue:HTMLElement;offset:number}|null>(null);
  function fitViewport(){
    const element=columns.current;
    if(element){
      const top=element.getBoundingClientRect().top+parseFloat(getComputedStyle(element).paddingTop||'0');
      element.style.setProperty('--ll-reader-height',`${Math.max(0,window.innerHeight-top-24)}px`);
    }
  }
  useLayoutEffect(fitViewport);
  function rememberReading(){
    const container=reader.current;if(!container)return;
    const top=container.getBoundingClientRect().top;
    const cue=Array.from(container.querySelectorAll<HTMLElement>('.ll-cue')).find(c=>c.getBoundingClientRect().bottom>top+1);
    if(cue)readingPosition.current={cue,offset:cue.getBoundingClientRect().top-top};
  }
  useLayoutEffect(()=>{
    const element=columns.current;if(!element)return;
    const observer=new ResizeObserver(()=>{
      fitViewport();rememberReading();setWidth(element.getBoundingClientRect().width);
    });
    observer.observe(element);window.addEventListener('resize',fitViewport);
    return()=>{observer.disconnect();window.removeEventListener('resize',fitViewport);};
  },[loaded]);
  function restoreReading(){
    const position=readingPosition.current,container=reader.current;
    if(position&&container&&position.cue.isConnected)
      container.scrollTop+=position.cue.getBoundingClientRect().top-container.getBoundingClientRect().top-position.offset;
    readingPosition.current=null;
  }
  useLayoutEffect(restoreReading,[width,preference,open]);
  useEffect(()=>{
    try{localStorage.setItem(readerLayoutKey,JSON.stringify(preference));}catch{}
  },[preference]);
  const available=width||1000;
  const watchMin=available<900?180:available<1100?240:300,readMin=available<900?260:320;
  const notesMin=available<900?220:260,notesMax=Math.max(notesMin,Math.min(520,available-36-watchMin-readMin));
  const notes=open?Math.max(notesMin,Math.min(notesMax,preference.notesWidth)):36;
  const budget=Math.max(watchMin+readMin,available-notes-(open?36:28));
  const video=Math.max(watchMin,Math.min(budget-readMin,budget*preference.videoRatio));
  const style={'--ll-video-width':`${video}px`,'--ll-notes-width':`${notes}px`} as React.CSSProperties;
  function reset(){
    rememberReading();setPreference({...defaultReaderLayout});
  }
  function separator(kind:'video'|'notes'):React.HTMLAttributes<HTMLDivElement>{
    return {
      role:'separator',tabIndex:0,'aria-orientation':'vertical',
      'aria-label':kind==='video'?'Resize video and transcript':'Resize transcript and notes',
      'aria-valuemin':Math.round(kind==='video'?watchMin:notesMin),
      'aria-valuemax':Math.round(kind==='video'?budget-readMin:notesMax),
      'aria-valuenow':Math.round(kind==='video'?video:notes),
      'aria-valuetext':`${Math.round(kind==='video'?video:notes)} pixels`,
      title:'Drag to resize · Arrow keys to adjust · Double-click to reset',
      onDoubleClick:reset,
      onPointerDown:event=>{
        if(event.button!==0||drag.current)return;
        event.preventDefault();event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);
        rememberReading();drag.current={kind,pointer:event.pointerId,x:event.clientX,video,notes,budget};setResizing(true);
      },
      onPointerMove:event=>{
        const start=drag.current;if(!start||start.pointer!==event.pointerId)return;
        const delta=event.clientX-start.x;
        rememberReading();
        if(kind==='video')setPreference(previous=>({...previous,videoRatio:Math.max(watchMin,Math.min(start.budget-readMin,start.video+delta))/start.budget}));
        else{
          const notesWidth=Math.max(notesMin,Math.min(notesMax,start.notes-delta));
          const newBudget=available-36-notesWidth;
          setPreference({notesWidth,videoRatio:Math.max(watchMin,Math.min(newBudget-readMin,start.video))/newBudget});
        }
      },
      onPointerUp:event=>{
        if(drag.current?.pointer!==event.pointerId)return;
        drag.current=null;setResizing(false);
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel:()=>{drag.current=null;setResizing(false);},
      onLostPointerCapture:()=>{drag.current=null;setResizing(false);},
      onKeyDown:event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();rememberReading();
        const min=kind==='video'?watchMin:notesMin,max=kind==='video'?budget-readMin:notesMax;
        const delta=(event.shiftKey?50:16)*(event.key==='ArrowRight'?1:-1);
        const value=event.key==='Home'?min:event.key==='End'?max:Math.max(min,Math.min(max,(kind==='video'?video:notes)+(kind==='video'?delta:-delta)));
        setPreference(previous=>kind==='video'?{...previous,videoRatio:value/budget}:
          {...previous,notesWidth:value,videoRatio:Math.max(watchMin,Math.min(available-36-value-readMin,video))/(available-36-value)});
      },
    };
  }
  return {columns,style,resizing,rememberReading,restoreReading,separator,reset};
}
function Reader({id,path,navigate,config,guard}:{id:string;path:string;navigate:(to:string)=>void;config:Config;guard:React.RefObject<()=>boolean>}){
  const [detail,setDetail]=useState<LearningDetail|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [panel,setPanelState]=useState<'records'|'passage'|'note'|'ai'|null>(null),[selected,setSelected]=useState<Anchor|null>(null);
  const [selectionPosition,setSelectionPosition]=useState<{left:number;top:number}|null>(null),[groupAnchor,setGroupAnchor]=useState<Anchor|null>(null);
  const [preview,setPreview]=useState<{anchor:Anchor;left:number;top:number}|null>(null);
  const [draftStatus,setDraftStatus]=useState<'idle'|'saving'|'saved'|'error'>('idle'),[sourceQuestion,setSourceQuestion]=useState<string|null>(null);
  const [note,setNote]=useState(''),[noteAnchor,setNoteAnchor]=useState<Anchor|null>(null),[editing,setEditing]=useState<LearningRecord|null>(null),[saving,setSaving]=useState(false);
  const [question,setQuestion]=useState(''),[conversation,setConversation]=useState<string|undefined>(),[aiAnchor,setAiAnchor]=useState<Anchor|null>(null),[recordFilter,setRecordFilter]=useState('all');
  const [find,setFind]=useState(''),[follow,setFollow]=useState(true),[current,setCurrent]=useState(-1),[settings,setSettings]=useState(false);
  const [tagEditor,setTagEditor]=useState(false),[tagOptions,setTagOptions]=useState<string[]>([]);
  const [playhead,setPlayhead]=useState(0),[mode,setMode]=useState<ReadingMode>('original');
  const readingTools=useReadingTools(id,detail?.video.selected_track||null,!!detail?.transcript);
  const wheelIntent=useRef({distance:0,at:0}),lastCentered=useRef(-1);
  const reader=useRef<HTMLDivElement>(null),player=useRef<PlayerHandle|null>(null),progress=useRef({playback:0,readingCue:0}),lastSave=useRef(0),initialized=useRef(false);
  const layout=useReaderLayout(panel!==null,detail!==null,reader);
  useLayoutEffect(()=>layout.restoreReading(),[mode]);
  useLayoutEffect(()=>{
    const container=reader.current,content=container?.querySelector<HTMLElement>('.ll-transcript-content');
    if(!container||!content)return;
    const enabled=follow&&!selected&&!panel&&current>=0;
    const entry=content.querySelector<HTMLElement>(`.ll-cue[data-cue="${current}"]`);
    let frame=0;
    const dimensions=()=>`${container.clientHeight}:${content.offsetHeight}:${entry?.offsetHeight||0}`;
    container.style.setProperty('--ll-follow-tail',`${container.clientHeight/2}px`);
    let geometry=dimensions();
    if(enabled){
      centerTranscript(container,current,lastCentered.current===current?'auto':'smooth');
      lastCentered.current=current;
    }
    const observer=new ResizeObserver(()=>{
      container.style.setProperty('--ll-follow-tail',`${container.clientHeight/2}px`);
      const next=dimensions();if(next===geometry)return;geometry=next;
      cancelAnimationFrame(frame);
      if(enabled)frame=requestAnimationFrame(()=>centerTranscript(container,current));
    });
    observer.observe(container);observer.observe(content);if(entry)observer.observe(entry);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[current,follow,selected,panel,mode,readingTools.tools.lines]);
  function setPanel(next:typeof panel){layout.rememberReading();setPanelState(next);}
  const marginScroll=useRef<HTMLDivElement>(null),noteField=useRef<HTMLTextAreaElement>(null),questionField=useRef<HTMLTextAreaElement>(null);
  const draftId=useRef<string>(crypto.randomUUID()),questionId=useRef<string>(crypto.randomUUID()),queryJump=useRef(''),detailRef=useRef<LearningDetail|null>(null),pendingJump=useRef<Anchor|null>(null);
  const draftWrites=useRef<Promise<unknown>>(Promise.resolve()),savedDraft=useRef(''),hoverTimer=useRef<ReturnType<typeof setTimeout>|null>(null),leaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const draftDirty=note.trim()!==(editing?.body||'');
  const draftSnapshot={id:draftId.current,body:note,anchor:noteAnchor,recordId:editing?.id,recordRevision:editing?.revision,sourceQuestionId:sourceQuestion||undefined};
  const snapshotKey=JSON.stringify(draftSnapshot);
  detailRef.current=detail;
  async function reload(){const result=await learningApi<LearningDetail>(`/library/${id}`);setDetail(result);}
  function flash(message:string){setNotice(message);}
  useEffect(()=>{
    let alive=true;
    const refresh=async()=>{try{const result=await learningApi<LearningDetail>(`/library/${id}`);if(!alive)return;setDetail(result);
      if(!initialized.current){initialized.current=true;progress.current={playback:result.video.playback_position,readingCue:result.video.reading_cue};}
    }catch(e){if(alive)setError((e as Error).message);}};
    void refresh();const timer=setInterval(refresh,3000);
    return()=>{alive=false;clearInterval(timer);};
  },[id]);
  useEffect(()=>{
    const dirty=()=>draftDirty&&savedDraft.current!==snapshotKey;
    guard.current=()=>!dirty()||confirm('Your latest draft has not reached your account yet. Leave without it?');
    const before=(e:BeforeUnloadEvent)=>{if(dirty()){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',before);
    return()=>{guard.current=()=>true;window.removeEventListener('beforeunload',before);};
  },[snapshotKey,draftDirty]);
  function writeDraft(snapshot:typeof draftSnapshot){
    const key=JSON.stringify(snapshot);
    const write=draftWrites.current.catch(()=>{}).then(()=>learningApi(`/library/${id}/drafts/${snapshot.id}`,{
      body:snapshot.body,anchor:snapshot.anchor||undefined,recordId:snapshot.recordId,recordRevision:snapshot.recordRevision,sourceQuestionId:snapshot.sourceQuestionId,
    },'PUT'));
    draftWrites.current=write;
    return write.then(()=>{savedDraft.current=key;setDraftStatus('saved');}).catch(e=>{setDraftStatus('error');throw e;});
  }
  useEffect(()=>{
    if(panel!=='note'||saving||!draftDirty||savedDraft.current===snapshotKey)return;
    setDraftStatus('saving');
    const timer=setTimeout(()=>{void writeDraft(draftSnapshot).catch(e=>setError(`Draft could not be saved: ${e.message}`));},650);
    return()=>clearTimeout(timer);
  },[snapshotKey,panel,saving,draftDirty]);
  useEffect(()=>()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);if(leaveTimer.current)clearTimeout(leaveTimer.current);},[]);
  useEffect(()=>{
    if(layout.resizing){cancelPreview();setPreview(null);setSelected(null);setFollow(false);window.getSelection()?.removeAllRanges();}
  },[layout.resizing]);
  useEffect(()=>{
    if(marginScroll.current)marginScroll.current.scrollTop=0;
    if(panel==='note')noteField.current?.focus({preventScroll:true});
    if(panel==='ai'&&!conversation)questionField.current?.focus({preventScroll:true});
  },[panel,editing?.id,conversation,groupAnchor]);
  async function keepDraft(){
    try{
      if(panel==='note'&&draftDirty&&savedDraft.current!==snapshotKey)await writeDraft(draftSnapshot);
      await draftWrites.current;
      return true;
    }catch(e){setError(`Your draft is still open. ${(e as Error).message}`);return false;}
  }
  async function closePanel(){
    if(!await keepDraft())return;
    cancelPreview();
    window.getSelection()?.removeAllRanges();wheelIntent.current={distance:0,at:0};
    setPanel(null);setFollow(true);setNote('');setEditing(null);setSelected(null);setPreview(null);await reload();
  }
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||tagEditor)return;
      if(selected){setSelected(null);window.getSelection()?.removeAllRanges();}
      else if(preview)setPreview(null);
      else if(panel)void closePanel();
    };
    window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);
  },[panel,selected,preview,snapshotKey,tagEditor]);
  useEffect(()=>{
    const save=()=>{
      if(!initialized.current)return;
      void fetch(`/api/library/${id}`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(progress.current),keepalive:true})
        .then(r=>{if(!r.ok)throw new Error('Progress could not be saved.');}).catch(()=>setError('Progress could not be saved. Check your connection.'));
    };
    const timer=setInterval(save,15000);window.addEventListener('pagehide',save);
    return()=>{clearInterval(timer);window.removeEventListener('pagehide',save);save();};
  },[id]);
  useEffect(()=>{
    if(!detail||queryJump.current===path)return;
    const params=new URLSearchParams(path.split('?')[1]||''),cue=params.get('cue'),record=params.get('record');
    queryJump.current=path;
    const saved=detail.records.find(r=>r.id===record)?.anchor;
    const position=saved?.firstCue??(cue!==null?Number(cue):detail.video.reading_cue);
    if(saved&&saved.trackId!==detail.transcript?.track.id)void locate(saved);
    else if(detail.transcript&&Number.isInteger(position)&&position>=0){requestAnimationFrame(()=>centerTranscript(reader.current,position));setCurrent(position);setFollow(cue===null&&!record);progress.current.readingCue=position;setPlayhead(detail.video.playback_position);}
    if(record){setPanel('records');requestAnimationFrame(()=>document.getElementById(`record-${record}`)?.scrollIntoView({block:'center'}));}
  },[detail,path]);
  useEffect(()=>{if(pendingJump.current&&detail?.transcript?.track.id===pendingJump.current.trackId){const a=pendingJump.current;pendingJump.current=null;jump(a.firstCue,a.start);}},[detail?.transcript?.track.id]);
  function jump(cue:number,seconds:number){
    setCurrent(cue);setFollow(panel===null);setPlayhead(seconds);progress.current.readingCue=cue;
    centerTranscript(reader.current,cue,'smooth');
    if(player.current){player.current.seek(seconds);progress.current.playback=seconds;}else flash('Passage located. The embedded player is unavailable; open the original video to play.');
  }
  async function locate(anchor:Anchor){
    if(detail?.transcript?.track.id!==anchor.trackId){
      pendingJump.current=anchor;try{await learningApi(`/library/${id}/import`,{trackId:anchor.trackId});flash('Switching to the caption track used by this record…');await reload();}catch(e){pendingJump.current=null;setError((e as Error).message);}return;
    }
    jump(anchor.firstCue,anchor.start);
  }
  function onTime(seconds:number,playing:boolean){
    const d=detailRef.current;if(!d?.transcript)return;
    progress.current.playback=seconds;
    setPlayhead(Math.floor(seconds));
    const cues=d.transcript.cues,i=cueAt(cues,seconds);
    setCurrent(i);
    if(follow&&i>=0&&!selected&&!panel)progress.current.readingCue=i;
    if(playing&&Date.now()-lastSave.current>15000&&d.video.learning_status==='new'){lastSave.current=Date.now();void learningApi(`/library/${id}`,{status:'learning'} , 'PATCH').catch(e=>setError(e.message));}
  }
  function captureSelection(){
    const sel=window.getSelection();if(!sel||sel.isCollapsed||!detail?.transcript)return;
    cancelPreview();setPreview(null);
    const range=sel.getRangeAt(0);
    const paragraph=(n:Node)=>(n.nodeType===Node.ELEMENT_NODE?n as Element:n.parentElement)?.closest<HTMLElement>('.ll-cue-text, .ll-cue-translation');
    let first=paragraph(range.startContainer),last=paragraph(range.endContainer);
    // Native line/paragraph selection may end at the enclosing cue's boundary.
    if(!first||!last){
      const touched=Array.from(reader.current?.querySelectorAll<HTMLElement>('.ll-cue-text')||[]).filter(p=>range.intersectsNode(p));
      first=first||touched[0];last=last||touched[touched.length-1];
    }
    if(!first||!last||!reader.current?.contains(first)||!reader.current?.contains(last))return;
    const prefix=(p:HTMLElement,node:Node,offset:number)=>{const r=document.createRange();r.selectNodeContents(p);r.setEnd(node,offset);return r.toString().length;};
    const translated=first.classList.contains('ll-cue-translation')||last.classList.contains('ll-cue-translation');
    const firstCue=Number(first.dataset.cue),lastCue=Number(last.dataset.cue),
      startOffset=!translated&&first.contains(range.startContainer)?prefix(first,range.startContainer,range.startOffset):0,
      endOffset=translated?detail.transcript.cues[lastCue].text.length:last.contains(range.endContainer)?prefix(last,range.endContainer,range.endOffset):last.textContent?.length||0;
    if(firstCue===lastCue&&endOffset<=startOffset)return;
    try{const cues=detail.transcript.cues;const quote=quoteFrom(cues,{firstCue,lastCue,startOffset,endOffset});if(quote.length>6000)throw new Error('Select a shorter passage (up to 6,000 characters).');
      setSelected({trackId:detail.transcript.track.id,firstCue,lastCue,startOffset,endOffset,quote,start:cues[firstCue].start,end:cues[lastCue].end});
      positionActions(range.getBoundingClientRect());setFollow(false);
    }catch(e){setError((e as Error).message);}
  }
  async function openNote(anchor:Anchor|null,record:LearningRecord|null=null,fromAI?:LearningQuestion){
    if(!await keepDraft())return;
    cancelPreview();
    const at=record?.anchor||anchor;
    const existingDraft=record?detailRef.current?.drafts.find(d=>d.record_id===record.id):undefined;
    setEditing(record&&existingDraft?.record_revision?{...record,revision:existingDraft.record_revision}:record);
    setNote(existingDraft?.body??record?.body??(fromAI?readableAnswer(fromAI,fromAI.answer||fromAI.supplement):'').slice(0,12000));
    setNoteAnchor(at);setGroupAnchor(at);setSourceQuestion(record?.source_question_id||fromAI?.id||null);
    draftId.current=existingDraft?.id||crypto.randomUUID();savedDraft.current='';setDraftStatus('idle');
    setPanel('note');setSelected(null);setPreview(null);setNotice('');setFollow(false);
    window.getSelection()?.removeAllRanges();
  }
  async function openDraft(draft:LearningDraft){
    if(!await keepDraft())return;
    cancelPreview();
    const record=detailRef.current?.records.find(r=>r.id===draft.record_id)||null;
    draftId.current=draft.id;setEditing(record&&draft.record_revision?{...record,revision:draft.record_revision}:record);setNote(draft.body);setNoteAnchor(draft.anchor);setGroupAnchor(draft.anchor);
    setSourceQuestion(draft.source_question_id);savedDraft.current='';setDraftStatus('saved');setPanel('note');setPreview(null);setSelected(null);setFollow(false);
  }
  async function openPassage(anchor:Anchor){
    if(!await keepDraft())return;
    cancelPreview();
    setNote('');setEditing(null);setGroupAnchor(anchor);setPanel('passage');setPreview(null);setSelected(null);setFollow(false);
    window.getSelection()?.removeAllRanges();await reload();
  }
  async function openAI(anchor:Anchor,thread?:string){
    if(!await keepDraft())return;
    cancelPreview();
    setNote('');setEditing(null);
    if(conversation!==thread||aiAnchor?.quote!==anchor.quote)setQuestion('');
    setAiAnchor(anchor);setGroupAnchor(anchor);setConversation(thread);setPanel('ai');setSelected(null);setPreview(null);setNotice('');setFollow(false);
    window.getSelection()?.removeAllRanges();
  }
  function positionActions(rect:DOMRect){
    const width=Math.min(330,window.innerWidth-24);
    setSelectionPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.top-52,window.innerHeight-60))});
  }
  function selectSaved(anchor:Anchor,event:React.MouseEvent){
    if(!window.getSelection()?.isCollapsed)return;
    const cue=Number((event.target as HTMLElement).closest<HTMLElement>('.ll-cue-text')?.dataset.cue);
    const passage=detailRef.current?.records.find(r=>r.kind==='note'&&r.anchor?.trackId===anchor.trackId&&r.anchor.firstCue===cue)?.anchor||
      detailRef.current?.questions.find(q=>q.anchor.trackId===anchor.trackId&&q.anchor.firstCue===cue)?.anchor;
    if(passage){void openPassage(passage);return;}
    setSelected(anchor);setFollow(false);positionActions((event.target as HTMLElement).getBoundingClientRect());
  }
  function cancelPreview(){
    if(hoverTimer.current)clearTimeout(hoverTimer.current);
    if(leaveTimer.current)clearTimeout(leaveTimer.current);
  }
  function previewPassage(anchor:Anchor,target:HTMLElement){
    cancelPreview();
    if(!window.getSelection()?.isCollapsed)return;
    const rect=target.getBoundingClientRect();
    hoverTimer.current=setTimeout(()=>setPreview({anchor,
      left:Math.max(12,Math.min(rect.right+12,window.innerWidth-332)),top:Math.max(12,Math.min(rect.top,window.innerHeight-330))}),350);
  }
  function leavePreview(){
    if(hoverTimer.current)clearTimeout(hoverTimer.current);
    leaveTimer.current=setTimeout(()=>setPreview(null),160);
  }
  async function discardDraft(){
    await draftWrites.current.catch(()=>{});
    try{await learningApi(`/library/${id}/drafts/${draftId.current}`,undefined,'DELETE');setNote('');setEditing(null);setPanel(groupAnchor?'passage':'records');await reload();}
    catch(e){setError((e as Error).message);}
  }
  async function saveNote(){
    setSaving(true);setError('');
    try{
      if(!await keepDraft())return;
      if(editing)await learningApi(`/library/${id}/records/${editing.id}`,{body:note,revision:editing.revision,draftId:draftId.current},'PATCH');
      else await learningApi(`/library/${id}/records`,{id:draftId.current,kind:'note',body:note,anchor:noteAnchor||undefined,sourceQuestionId:sourceQuestion||undefined});
      setNote('');setEditing(null);draftId.current=crypto.randomUUID();
      setPanel(noteAnchor?'passage':'records');setDraftStatus('idle');setSourceQuestion(null);
      await reload();flash('Annotation saved beside the passage.');
    }catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  async function highlight(){
    if(!selected)return;setSaving(true);
    try{await learningApi(`/library/${id}/records`,{id:draftId.current,kind:'highlight',anchor:selected});draftId.current=crypto.randomUUID();setSelected(null);window.getSelection()?.removeAllRanges();await reload();flash('Highlight saved to your library.');}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  if(!detail)return <div className="ll-empty">{error||'Opening this video…'}</div>;
  const {video,transcript,records,questions}=detail;
  const sourceParams=new URLSearchParams(path.split('?')[1]||'');
  const sourceStart=records.find(r=>r.id===sourceParams.get('record'))?.anchor?.start??
    transcript?.cues[Number(sourceParams.get('cue')??-1)]?.start;
  const active=questions.find(q=>['queued','running'].includes(q.status));
  const displayed=questions.filter(q=>q.conversation_id===conversation);
  const samePassage=(a:Anchor|null|undefined,b:Anchor|null|undefined)=>!!a&&!!b&&a.trackId===b.trackId&&a.firstCue===b.firstCue;
  const passageNotes=records.filter(r=>r.kind==='note'&&samePassage(r.anchor,groupAnchor));
  const passageDrafts=detail.drafts.filter(d=>samePassage(d.anchor,groupAnchor));
  const passageThreads=questions.filter(q=>samePassage(q.anchor,groupAnchor))
    .filter((q,i,all)=>all.findIndex(other=>other.conversation_id===q.conversation_id)===i);
  const groupList=<div className="ll-passage-list">
    <div className="ll-passage-list-head"><span>{passageNotes.length} saved {passageNotes.length===1?'note':'notes'}</span><button className="ll-link" onClick={()=>openNote(groupAnchor)}><Plus size={13}/>Add another note</button></div>
    {passageNotes.map(r=><button className={`ll-note-summary ${editing?.id===r.id?'active':''}`} key={r.id} onClick={()=>openNote(r.anchor,r)}><span><StickyNote size={12}/>{r.source_question_id?'From AI · saved by you':'Your note'}<small>{new Date(r.created_at*1000).toLocaleDateString()}</small></span><p>{r.body.slice(0,110)}{r.body.length>110?'…':''}</p></button>)}
    {passageDrafts.filter(d=>panel!=='note'||d.id!==draftId.current).map(d=><button key={d.id} className="ll-note-summary ll-draft-summary" onClick={()=>openDraft(d)}><span>Draft · not yet a saved note</span><p>{d.body.slice(0,100)||'Continue your draft'}</p></button>)}
    {panel==='passage'&&passageThreads.map(q=><button className="ll-note-summary" key={q.conversation_id} onClick={()=>openAI(q.anchor,q.conversation_id)}><span><MessageCircle size={12}/>AI conversation · separate from notes</span><p>{q.question}</p></button>)}
  </div>;
  const noteEditor=<div className="ll-note-editor">
    <label htmlFor="ll-note-text">{sourceQuestion?'Make this answer your own':editing?'Edit your note':'A new note'}</label>
    {sourceQuestion&&<p className="ll-muted">From an AI answer. Edit the draft, then save it as your note.</p>}
    <textarea id="ll-note-text" ref={noteField} maxLength={12000} placeholder="Write your thought about this passage…" value={note} onChange={e=>setNote(e.target.value)}/>
    <div className="ll-note-save"><span role="status">{saving?'Saving note…':draftStatus==='saving'?'Saving draft…':draftStatus==='error'?'Draft not saved':draftStatus==='saved'?'Draft kept in your account':'Only saved notes appear in your margin'}</span><button className="ll-button ll-solid" disabled={saving||!note.trim()} onClick={saveNote}>Save note <Check size={14}/></button></div>
    <div className="ll-note-secondary"><button className="ll-link" onClick={discardDraft}>Discard draft</button>{sourceQuestion&&<button className="ll-link" onClick={()=>{const q=questions.find(q=>q.id===sourceQuestion);if(q)void openAI(q.anchor,q.conversation_id);}}>Source conversation <ArrowRight size={12}/></button>}</div>
    {editing&&<button className="ll-link ll-delete-note" onClick={async()=>{if(!confirm('Delete this saved note?'))return;try{await draftWrites.current.catch(()=>{});await learningApi(`/library/${id}/records/${editing.id}`,undefined,'DELETE');setNote('');setEditing(null);setPanel('passage');await reload();}catch(e){setError((e as Error).message);}}}><Trash2 size={12}/>Delete saved note</button>}
  </div>;
  const aiEditor=<div className="ll-ai-panel"><div className="ll-ai-label"><Sparkles size={15}/>{config.ai?'Ask AI about this passage':'AI not configured'}</div>
    <p className="ll-muted">Answers use the transcript and your selected passage.</p>
    {!config.ai&&<div className="ll-inline-notice">AI answers are not available in this preview yet. Your highlights and notes work normally.</div>}
    {displayed.map(q=><QuestionCard key={q.id} q={q} locate={locate} saveAsNote={()=>openNote(q.anchor,null,q)} retry={()=>{setQuestion(q.question);questionId.current=crypto.randomUUID();}} stop={async()=>{try{await learningApi(`/library/${id}/questions/${q.id}/stop`,{});await reload();}catch(e){setError((e as Error).message);}}}/>)}
    <form className="ll-question-form ll-compact-question" onSubmit={async e=>{e.preventDefault();if(!aiAnchor)return;setSaving(true);setError('');try{const result=await learningApi(`/library/${id}/questions`,{id:questionId.current,question,anchor:aiAnchor,conversationId:conversation});setConversation(conversation||result.id);questionId.current=crypto.randomUUID();setQuestion('');await reload();}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}><label htmlFor="ll-question">{displayed.length?'Follow up':'Your question'}</label><textarea id="ll-question" ref={questionField} rows={question?3:1} maxLength={2000} placeholder={displayed.length?'Ask a follow-up…':'What would you like to understand?'} value={question} onChange={e=>setQuestion(e.target.value)}/><button className="ll-button ll-solid" disabled={!config.ai||saving||!!active||!aiAnchor||question.trim().length<2}>{active?'Waiting for answer…':'Ask AI'}<ArrowRight size={15}/></button></form>
  </div>;
  async function openRecords(){
    if(await keepDraft()){setPanel('records');setNote('');setEditing(null);setPreview(null);setFollow(false);await reload();}
  }
  async function openTags(){
    try{const r=await learningApi<{videos:LibraryVideo[]}>('/library');setTagOptions([...new Set(r.videos.flatMap(v=>v.tags))]);setSelected(null);setTagEditor(true);}
    catch(e){setError((e as Error).message);}
  }
  return <main className={`ll-reader ll-reader-margin ${panel?'ll-margin-open':'ll-margin-collapsed'} ${layout.resizing?'ll-resizing':''}`}>
    <div className="ll-reader-top"><button className="ll-link" onClick={()=>navigate('/library')}><ArrowLeft size={15}/>Library</button><div>{notice&&<span role="status">{notice}</span>}<button className="ll-icon" aria-label="Video settings" onClick={()=>setSettings(!settings)}><Settings2 size={18}/></button><button className="ll-button" aria-expanded={panel!==null} aria-controls="ll-learning-margin" onClick={()=>panel?closePanel():openRecords()}><StickyNote size={16}/>Learning records <span>{records.filter(r=>r.kind==='note').length} notes</span></button></div></div>
    {error&&<p className="ll-inline-error" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></p>}
    {settings&&<div className="ll-video-settings"><button className="ll-button" onClick={()=>void openTags()}>Edit video tags</button><label>Learning status<select aria-label="Learning status" value={video.learning_status} onChange={async e=>{try{await learningApi(`/library/${id}`,{status:e.target.value},'PATCH');await reload();}catch(e){setError((e as Error).message);}}}><option value="new">Not started</option><option value="learning">Learning</option><option value="complete">Completed</option></select></label></div>}
    {tagEditor&&<OrganizationDialog title="Video tags" close={()=>setTagEditor(false)}><TagEditor ids={[id]} tags={video.tags} options={tagOptions} changed={async()=>{await reload();flash('Tags saved.');}}/></OrganizationDialog>}
    <div className="ll-learning-columns" ref={layout.columns} style={layout.style}><section className="ll-watch"><div className="ll-video-source">YouTube <span>·</span> {video.author||'Original source'}</div><h1>{video.title}</h1><VideoPlayer video={video} onTime={onTime} handle={player} start={sourceStart}/>
      {transcript&&<ChapterNavigator tools={readingTools.tools} seconds={playhead} cues={transcript.cues} request={readingTools.request} busy={readingTools.busy} jump={jump} ai={config.ai}/>}
      <div className="ll-watch-meta"><span>{video.duration?`${Math.ceil(video.duration/60)} min`:'Duration pending'}</span><span>{label(video.learning_status)}</span>{video.playback_position>5&&<button className="ll-link" aria-label={`Resume video at ${time(video.playback_position)}`} onClick={()=>{if(player.current)player.current.seek(video.playback_position);else flash('Resume is available when the player connects.');}}>Resume {time(video.playback_position)} →</button>}<a className="ll-original-link" href={video.url} target="_blank" rel="noopener noreferrer">Open on YouTube <ExternalLink size={13}/></a></div>
    </section>
    <div className="ll-reader-divider ll-video-divider" {...layout.separator('video')}><span/></div>
    <section className="ll-transcript-column"><div className="ll-transcript-heading"><div><BookOpen size={18}/><strong>Read along</strong></div><div className="ll-follow-controls">{!follow&&!panel&&<span className="ll-follow-state" role="status">Follow paused</span>}<button className={follow&&!panel?'ll-follow active':'ll-follow'} aria-pressed={follow&&!panel} disabled={!!panel} onClick={()=>{setSelected(null);window.getSelection()?.removeAllRanges();setFollow(!follow);wheelIntent.current={distance:0,at:0};if(!follow&&current>=0)centerTranscript(reader.current,current);}}>{panel?'Follow paused for notes':follow?'Following playback':'Back to playback'}</button></div></div>
      {transcript?<><div className="ll-track-row"><select aria-label="Caption language" value={video.selected_track||''} disabled={['queued','importing'].includes(video.caption_status)} onChange={async e=>{setSelected(null);try{await learningApi(`/library/${id}/import`,{trackId:e.target.value});await reload();}catch(e){setError((e as Error).message);}}}>{video.tracks.map(t=><option key={t.id} value={t.id}>{t.name} · {t.source==='manual'?'Human captions':'Auto captions'}{t.translated?' · translated':''}</option>)}</select></div>{transcript.completeness==='partial'&&<p className="ll-inline-notice">Partial transcript. Questions can only use the available passages.</p>}<label className="ll-find"><Search size={16}/><input aria-label="Find in transcript" placeholder="Find in this transcript…" value={find} onChange={e=>setFind(e.target.value)}/><span>{find?transcript.cues.filter((c,i)=>c.text.toLowerCase().includes(find.toLowerCase())||mode!=='original'&&readingTools.tools.lines[i]?.includes(find)).length+' matches':''}</span></label>
      <TranslationControl tools={readingTools.tools} mode={mode} change={value=>{layout.rememberReading();setMode(value);setSelected(null);window.getSelection()?.removeAllRanges();}} request={readingTools.request} cue={current} busy={readingTools.busy}/>
      {readingTools.error&&<p className="ll-inline-error" role="alert">{readingTools.error}</p>}
      <p className="ll-annotation-hint">{mode==='original'?'Select a passage to highlight, write or ask AI.':'Chinese appears below each passage as it is ready. Notes keep the original source.'}</p>
      <div className="ll-transcript-scroll" ref={reader} onMouseUp={captureSelection} onTouchEnd={()=>setTimeout(captureSelection,100)} onKeyUp={captureSelection} onWheel={e=>{
        if(e.ctrlKey||Math.abs(e.deltaY)<=Math.abs(e.deltaX))return;
        const at=performance.now(),delta=Math.abs(e.deltaY)*(e.deltaMode===1?16:e.deltaMode===2?reader.current?.clientHeight||1:1);
        wheelIntent.current={at,distance:(at-wheelIntent.current.at<180?wheelIntent.current.distance:0)+delta};
        if(wheelIntent.current.distance>=12){setFollow(false);setSelected(null);}
      }} onTouchMove={()=>setFollow(false)} onScroll={()=>{
        cancelPreview();setPreview(null);const container=reader.current;if(!container)return;const top=container.getBoundingClientRect().top;
        const visible=Array.from(container.querySelectorAll<HTMLElement>('.ll-cue')).find(e=>e.getBoundingClientRect().bottom>top+45);
        if(visible)progress.current.readingCue=Number(visible.dataset.cue);
      }}>
        <div className="ll-transcript-content">{transcript.cues.map((cue,i)=>{
          const translated=readingTools.tools.lines[i];
          const matched=find&&(cue.text.toLowerCase().includes(find.toLowerCase())||mode!=='original'&&translated?.includes(find));
          const cueNotes=records.filter(r=>r.kind==='note'&&r.anchor?.trackId===transcript.track.id&&r.anchor.firstCue===i);
          const cueDrafts=detail.drafts.filter(d=>d.anchor?.trackId===transcript.track.id&&d.anchor.firstCue===i);
          const cueThreads=questions.filter(q=>q.anchor.trackId===transcript.track.id&&q.anchor.firstCue===i).filter((q,idx,arr)=>arr.findIndex(t=>t.conversation_id===q.conversation_id)===idx);
          const at=cueNotes[0]?.anchor||cueDrafts[0]?.anchor||cueThreads[0]?.anchor;
          const focus=selected?.trackId===transcript.track.id?selected:panel&&groupAnchor?.trackId===transcript.track.id?groupAnchor:null;
          return <div className={`ll-cue ${current===i?'ll-current':''} ${matched?'ll-match':''} ${mode==='chinese'&&translated?'ll-chinese-cue':''}`} id={`cue-${i}`} data-cue={i} key={`${transcript.track.id}:${i}`}><button className="ll-timestamp" aria-label={`Jump to ${time(cue.start)}`} onClick={()=>jump(i,cue.start)}>{time(cue.start)}</button><p className="ll-cue-text" data-cue={i}>{markedText(cue.text,i,[...records.filter(r=>r.anchor?.trackId===transcript.track.id).map(r=>r.anchor!),...questions.filter(q=>q.anchor.trackId===transcript.track.id).map(q=>q.anchor)],focus,selectSaved,(_anchor,event)=>{if(at)previewPassage(at,event.currentTarget);},leavePreview)}</p>
            {mode!=='original'&&translated&&<p className="ll-cue-translation" lang="zh-Hans" data-cue={i}>{translated}</p>}
            <div className="ll-cue-markers">{at&&<>
              {(cueNotes.length>0||cueDrafts.length>0)&&<button className="ll-note-marker" aria-label={`${cueNotes.length} notes at ${time(cue.start)}${cueDrafts.length?' and drafts':''}`} onMouseEnter={e=>previewPassage(at,e.currentTarget)} onMouseLeave={leavePreview} onFocus={e=>previewPassage(at,e.currentTarget)} onBlur={leavePreview} onClick={()=>openPassage(at)}><StickyNote size={13}/>{cueNotes.length>0?cueNotes.length:<span>Draft</span>}{cueDrafts.length>0&&cueNotes.length>0&&<span className="ll-draft-dot" title="Draft available"/>}</button>}
              {cueThreads.length>0&&<button className="ll-question-marker" aria-label={`${cueThreads.length} AI conversations at ${time(cue.start)}`} onClick={()=>cueThreads.length>1?openPassage(at):openAI(cueThreads[0].anchor,cueThreads[0].conversation_id)}><MessageCircle size={13}/>{cueThreads.length}{cueThreads.some(q=>questions.some(other=>other.conversation_id===q.conversation_id&&['queued','running'].includes(other.status)))&&<span className="ll-draft-dot" title="Answer in progress"/>}</button>}
            </>}</div>
          </div>;
        })}</div>
      </div>
      {selected&&<div className="ll-selection-actions ll-context-actions" role="toolbar" aria-label="Selected text actions" style={selectionPosition?{left:selectionPosition.left,top:selectionPosition.top}:undefined} onMouseDown={e=>e.preventDefault()}><button disabled={saving} onClick={highlight}><Highlighter size={15}/>Highlight</button><button onClick={()=>openNote(selected)}><StickyNote size={15}/>Add annotation</button><button onClick={()=>openAI(selected)}><Sparkles size={15}/>Ask AI</button><button aria-label="Clear selection" onClick={()=>{setSelected(null);window.getSelection()?.removeAllRanges();}}><X size={14}/></button></div>}
      </>:<div className="ll-caption-empty">{['queued','importing'].includes(video.caption_status)?<Loader2 size={28} className="ll-spin"/>:<BookOpen size={30}/>}<h2>{label(video.caption_status)}</h2><p>{video.error||(['queued','importing'].includes(video.caption_status)?'Your video is saved. Looking for original captions; no speech recognition is started.':'This video is saved. You can watch it and write a video note. Speech recognition is not started automatically.')}</p>{!['queued','importing'].includes(video.caption_status)&&<button className="ll-button" onClick={async()=>{try{await learningApi(`/library/${id}/import`,{});await reload();}catch(e){setError((e as Error).message);}}}>Retry caption import</button>}</div>}
      {transcript&&['queued','importing'].includes(video.caption_status)&&<p className="ll-inline-notice">Importing the selected caption track. Your previous transcript remains available.</p>}
      {transcript&&video.caption_status==='error'&&<p className="ll-inline-error">{video.error}<button className="ll-link" onClick={async()=>{try{await learningApi(`/library/${id}/import`,{});await reload();}catch(e){setError((e as Error).message);}}}>Retry import</button></p>}
    </section>
    <div className={`ll-reader-divider ll-notes-divider ${panel?'':'ll-divider-inactive'}`} {...(panel?layout.separator('notes'): {'aria-hidden':true})}>{panel&&<span/>}</div>
    <aside id="ll-learning-margin" className={`ll-thought-panel ll-margin-panel ${panel?'':'ll-margin-quiet'}`} aria-label="Learning margin">
      {!panel?<div className="ll-margin-rail"><button className="ll-icon" aria-label="Open learning panel" title="Open notes and questions" onClick={openRecords}><StickyNote size={18}/></button>{detail.drafts.length>0&&<button className="ll-icon" aria-label="Continue a draft" title="Continue a draft" onClick={()=>openDraft(detail.drafts[0])}><span className="ll-draft-dot"/></button>}</div>:<>
      <div className="ll-panel-head"><span>{panel==='note'?(editing?'Edit note':'New note'):panel==='ai'?'Ask in the margin':panel==='passage'?'Beside this passage':panel==='records'?'Learning records':'In the margin'}</span>{panel&&<button className="ll-icon" aria-label="Close learning panel" onClick={closePanel}><X size={17}/></button>}</div>
      {groupAnchor&&panel&&panel!=='records'&&<div className="ll-panel-source"><button className="ll-link" onClick={()=>locate(groupAnchor)}>{time(groupAnchor.start)}–{time(groupAnchor.end)} <ArrowRight size={12}/></button><p title={groupAnchor.quote}>{groupAnchor.quote.slice(0,180)}{groupAnchor.quote.length>180?'…':''}</p></div>}
      <div className="ll-margin-body" ref={marginScroll}>
      {!panel?<div className="ll-margin-rest"><StickyNote size={20}/><p>Your thoughts stay beside the source.</p><p>Choose a passage to write a note or ask a question.</p>{detail.drafts.length>0&&<button className="ll-link" onClick={()=>openDraft(detail.drafts[0])}>Continue a draft <ArrowRight size={13}/></button>}</div>:<>
      {panel==='note'?<>{noteEditor}{groupAnchor&&<details className="ll-other-notes"><summary>Other notes beside this passage ({passageNotes.length})</summary>{groupList}</details>}</>:
      panel==='ai'?aiEditor:panel==='passage'?<>{groupList}<div className="ll-passage-actions"><button className="ll-button" onClick={()=>openNote(groupAnchor)}><Plus size={14}/>New note</button>{groupAnchor&&<button className="ll-link" onClick={()=>openAI(groupAnchor)}><Sparkles size={14}/>Ask AI</button>}</div></>:
      <div className="ll-records-panel"><div className="ll-record-filters">{['all','note','question'].map(f=><button key={f} className={recordFilter===f?'active':''} onClick={()=>setRecordFilter(f)}>{f==='all'?'All':f==='note'?'Notes':'Questions'}</button>)}<button className="ll-link" onClick={()=>openNote(null)}><Plus size={14}/>Add a note</button></div>
        {recordFilter!=='question'&&detail.drafts.map(d=><button key={d.id} className="ll-note-summary ll-draft-summary" onClick={()=>openDraft(d)}><span>Draft · not counted as a note</span><p>{d.body.slice(0,110)||'Continue writing'}</p></button>)}
        {[...records.map(r=>({type:'record' as const,item:r})),...questions.map(q=>({type:'question' as const,item:q}))].sort((a,b)=>b.item.created_at-a.item.created_at).filter(e=>recordFilter==='all'||(recordFilter==='note'?e.type==='record'&&e.item.kind==='note':e.type==='question')).map(entry=>entry.type==='record'?<div className="ll-record" key={entry.item.id} id={`record-${entry.item.id}`}><div className="ll-record-by">{entry.item.kind==='note'?<StickyNote size={14}/>:<Highlighter size={14}/>} {entry.item.kind==='note'?(entry.item.source_question_id?'Your note · from AI':'Your note'):'Your highlight'}<small>{new Date(entry.item.created_at*1000).toLocaleDateString()}</small></div>{entry.item.anchor&&<QuoteBlock anchor={entry.item.anchor} locate={locate}/>}<p className="ll-record-body">{entry.item.body}</p><div className="ll-record-actions">{entry.item.kind==='note'&&<button onClick={()=>openNote(null,entry.item)}>Edit</button>}{entry.item.source_question_id&&<button onClick={()=>{const q=questions.find(q=>q.id===entry.item.source_question_id);if(q)void openAI(q.anchor,q.conversation_id);}}>Source answer</button>}{entry.item.anchor&&<button onClick={()=>openAI(entry.item.anchor!)}>Ask AI</button>}<button aria-label="Delete learning record" onClick={async()=>{if(!confirm('Delete this learning record?'))return;try{await learningApi(`/library/${id}/records/${entry.item.id}`,undefined,'DELETE');await reload();}catch(e){setError((e as Error).message);}}}><Trash2 size={13}/></button></div></div>:<button className="ll-note-summary" key={entry.item.id} id={`record-${entry.item.id}`} onClick={()=>openAI(entry.item.anchor,entry.item.conversation_id)}><span><MessageCircle size={13}/>AI question · {label(entry.item.status)}</span><p>{entry.item.question}</p></button>)}
        {!records.length&&!questions.length&&<div className="ll-panel-empty"><StickyNote size={28}/><h3>The thought is yours.</h3><p>Highlight a line or write your first note. It will be here when you return.</p></div>}
      </div>}
      </>}
      </div>
      </>}
    </aside>
    </div>
    {preview&&<div className="ll-note-preview" role="dialog" aria-label="Passage note preview" style={{left:preview.left,top:preview.top}} onMouseEnter={cancelPreview} onMouseLeave={leavePreview}>
      <div className="ll-note-preview-head"><span>Notes at {time(preview.anchor.start)}</span><button className="ll-icon" aria-label="Close note preview" onClick={()=>setPreview(null)}><X size={13}/></button></div>
      {records.filter(r=>r.kind==='note'&&samePassage(r.anchor,preview.anchor)).slice(0,3).map(r=><button key={r.id} className="ll-preview-entry" onClick={()=>openNote(r.anchor,r)}><small>{r.source_question_id?'From AI · saved by you':'Your note'} · {new Date(r.created_at*1000).toLocaleDateString()}</small><p>{r.body.slice(0,100)}{r.body.length>100?'…':''}</p></button>)}
      {records.filter(r=>r.kind==='note'&&samePassage(r.anchor,preview.anchor)).length===0&&<p className="ll-muted">A draft is waiting beside this passage.</p>}
      <button className="ll-link" onClick={()=>openPassage(preview.anchor)}>View all notes and drafts <ArrowRight size={12}/></button>
    </div>}
  </main>;
}
function markedText(text:string,cue:number,anchors:Anchor[],selected:Anchor|null,onClick?:(a:Anchor,e:React.MouseEvent)=>void,onEnter?:(a:Anchor,e:React.MouseEvent<HTMLElement>)=>void,onLeave?:()=>void){
  const spans=[...anchors,...(selected?[selected]:[])].filter(a=>cue>=a.firstCue&&cue<=a.lastCue).map(a=>({start:cue===a.firstCue?a.startOffset:0,end:cue===a.lastCue?a.endOffset:text.length}));
  if(!spans.length)return text;
  const boundaries=[...new Set([0,text.length,...spans.flatMap(s=>[s.start,s.end])])].sort((a,b)=>a-b);
  return boundaries.slice(0,-1).map((start,i)=>{const end=boundaries[i+1],part=text.slice(start,end);const owner=anchors.find(a=>cue>=a.firstCue&&cue<=a.lastCue&&(cue!==a.firstCue||a.startOffset<=start)&&(cue!==a.lastCue||a.endOffset>=end));return spans.some(s=>s.start<=start&&s.end>=end)?<mark key={start} className={owner?'ll-interactive-highlight':undefined} onClick={owner&&onClick?e=>onClick(owner,e):undefined} onMouseEnter={owner&&onEnter?e=>onEnter(owner,e):undefined} onMouseLeave={onLeave}>{part}</mark>:<React.Fragment key={start}>{part}</React.Fragment>;});
}
function QuoteBlock({anchor,locate}:{anchor:Anchor;locate:(a:Anchor)=>void|Promise<void>}){
  return <blockquote className="ll-saved-quote"><button onClick={()=>locate(anchor)}>{time(anchor.start)}–{time(anchor.end)} <ArrowRight size={12}/></button>{anchor.quote.length>220?<details><summary>{anchor.quote.slice(0,160)}…</summary><p>{anchor.quote}</p></details>:<p>{anchor.quote}</p>}<small>Original transcript</small></blockquote>;
}
function QuestionCard({q,locate,retry,stop,saveAsNote}:{q:LearningQuestion;locate:(a:Anchor)=>void|Promise<void>;retry?:()=>void;stop?:()=>void|Promise<void>;saveAsNote?:()=>void|Promise<void>}){
  return <div className="ll-question-card"><div className="ll-record-by"><MessageCircle size={14}/>Your question</div><h3>{q.question}</h3>{q.status==='complete'?<>
    <div className="ll-ai-source-label">AI · About the video</div><p className="ll-record-body">{readableAnswer(q,q.answer)}</p>
    {saveAsNote&&<button className="ll-button ll-save-answer" onClick={saveAsNote}><StickyNote size={13}/>Save as note</button>}
    {q.supplement&&<details className="ll-ai-supplement"><summary>Additional explanation</summary><p className="ll-record-body">{q.supplement}</p></details>}
    <details><summary>Cited passages ({q.context.length})</summary><div className="ll-citations">{q.citations.map(id=>{const e=q.context.find(c=>c.id===id);return e&&<button key={id} title={e.text} onClick={()=>locate({...q.anchor,trackId:e.trackId,firstCue:e.cue,lastCue:e.cue,start:e.start,end:e.end,quote:e.text,startOffset:0,endOffset:e.text.length})}>{time(e.start)} <ExternalLink size={11}/></button>;})}</div>{q.context.map(e=><p key={e.id}><button className="ll-link" onClick={()=>locate({...q.anchor,trackId:e.trackId,firstCue:e.cue,lastCue:e.cue,start:e.start,end:e.end})}>{time(e.start)}</button> {e.text}</p>)}</details>
    <div className="ll-context-coverage">{q.context_scope==='full_transcript'?'Context: complete available transcript':q.context_scope==='relevant_passages'?'Context: relevant excerpts from a long transcript':'Context: selected and related passages'}</div>
  </>:<><p className="ll-muted">{q.status==='queued'?'Question saved · waiting to send':q.status==='running'?'Question saved · AI is answering':q.error||label(q.status)}</p>{['queued','running'].includes(q.status)&&stop&&<button className="ll-link" onClick={stop}>Stop answering</button>}{['failed','cancelled'].includes(q.status)&&retry&&<button className="ll-link" onClick={retry}>Prepare a new attempt</button>}</>}
  </div>;
}
