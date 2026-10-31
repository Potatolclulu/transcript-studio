import React,{useEffect,useId,useRef,useState} from 'react';
import { createPortal } from 'react-dom';
import { Languages, Loader2, Sparkles } from 'lucide-react';
import { cueAt,type Cue,type ReadingTools } from '../shared/learning';
import { learningApi } from './learning-api';

export const readingTime=(seconds:number)=>{
  const s=Math.floor(seconds),m=Math.floor(s/60);
  return s>=3600?`${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`:`${m}:${String(s%60).padStart(2,'0')}`;
};
const empty:ReadingTools={chapters:[],chapterTask:null,translation:null,lines:{}};
export function useReadingTools(id:string,track:string|null,available:boolean) {
  const [tools,setTools]=useState<ReadingTools>(empty),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  const load=async()=>{const g=generation.current,r=await learningApi<ReadingTools>(`/library/${id}/reading`);if(g===generation.current)setTools(r);return r;};
  async function request(kind:'chapters'|'translation',cue=0,ai=false){
    setBusy(true);setError('');
    try {await learningApi(`/library/${id}/reading`,{kind,cue,ai});await load();}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  useEffect(()=>{
    const g=++generation.current;setTools(empty);setError('');
    if(!available)return;
    void load().then(r=>{if(g===generation.current&&!r.chapterTask)void request('chapters');}).catch(e=>{if(g===generation.current)setError(e.message);});
    return()=>{generation.current++;};
  },[id,track,available]);
  const waiting=[tools.chapterTask,tools.translation].some(t=>t&&['queued','running'].includes(t.status));
  useEffect(()=>{
    if(!waiting)return;
    const timer=setInterval(()=>{void load().catch(e=>setError(e.message));},4000);
    return()=>clearInterval(timer);
  },[waiting,id,track]);
  return {tools,error,busy,request};
}
export function ChapterNavigator({tools,seconds,cues,request,busy,jump,ai}:{
  tools:ReadingTools;seconds:number;cues:Cue[];request:ReturnType<typeof useReadingTools>['request'];busy:boolean;
  jump:(cue:number,seconds:number)=>void;ai:boolean;
}) {
  const [preview,setPreview]=useState<{index:number;left:number;top:number;width:number;above:boolean}|null>(null);
  const tooltipId=useId();
  const timeline=useRef<HTMLDivElement>(null);
  const chapters=tools.chapters,active=chapters.findIndex(c=>c.start<=seconds&&c.end>seconds),task=tools.chapterTask;
  useEffect(()=>{
    const hide=()=>setPreview(null);
    const moved=(event:Event)=>{
      if(event.target===document||event.target instanceof Element&&timeline.current&&event.target.contains(timeline.current))hide();
    };
    window.addEventListener('resize',hide);window.addEventListener('scroll',moved,true);
    return()=>{window.removeEventListener('resize',hide);window.removeEventListener('scroll',moved,true);};
  },[]);
  function show(index:number,target:HTMLElement){
    const rect=target.getBoundingClientRect(),width=Math.min(280,window.innerWidth-24),above=rect.top>120;
    setPreview({index,width,above,left:Math.max(12,Math.min(window.innerWidth-width-12,rect.left+rect.width/2-width/2)),
      top:above?rect.top-8:rect.bottom+8});
  }
  if(!chapters.length)return <div className="ll-chapter-empty">{!task||['queued','running'].includes(task.status)?<><Loader2 size={14} className="ll-spin"/>Looking for creator chapters…</>:<><p>{task.error||'This video has no creator chapters.'}</p>{ai&&<button className="ll-link" disabled={busy} onClick={()=>void request('chapters',0,true)}><Sparkles size={13}/>Generate an AI outline</button>}{task.status==='failed'&&<button className="ll-link" disabled={busy} onClick={()=>void request('chapters')}>Retry creator chapters</button>}</>}</div>;
  const shown=preview&&chapters[preview.index];
  return <div className="ll-chapters">
    <div className="ll-chapter-bar" ref={timeline} role="group" aria-label="Chapter timeline">{chapters.map((c,i)=><button key={c.start} className={i===active?'active':''} style={{flexGrow:c.end-c.start}} aria-label={`Go to chapter: ${c.title}`} aria-current={i===active?'true':undefined} aria-describedby={preview?.index===i?tooltipId:undefined}
      onMouseEnter={e=>show(i,e.currentTarget)} onMouseLeave={()=>setPreview(null)} onFocus={e=>show(i,e.currentTarget)} onBlur={()=>setPreview(null)}
      onKeyDown={e=>{if(e.key==='Escape')setPreview(null);}}
      onClick={()=>jump(Math.max(0,cueAt(cues,c.start)),c.start)}>
      <span style={{width:`${i===active?Math.min(100,Math.max(0,(seconds-c.start)/(c.end-c.start)*100)):i<active?100:0}%`}}/>
    </button>)}</div>
    {preview&&shown&&createPortal(<div id={tooltipId} role="tooltip" className="ll-chapter-preview" style={{left:preview.left,top:preview.top,width:preview.width,transform:preview.above?'translateY(-100%)':undefined}}>
      <time>{readingTime(shown.start)}</time><strong>{shown.title}</strong>{task?.source==='ai'&&<small>AI outline</small>}
    </div>,document.body)}
  </div>;
}
export type ReadingMode='original'|'bilingual'|'chinese';
export function TranslationControl({tools,mode,change,request,cue,busy}:{
  tools:ReadingTools;mode:ReadingMode;change:(mode:ReadingMode)=>void;request:ReturnType<typeof useReadingTools>['request'];cue:number;busy:boolean;
}) {
  const task=tools.translation,waiting=task&&['queued','running'].includes(task.status);
  return <><label className="ll-reading-language"><Languages size={15}/><select aria-label="Transcript view" value={mode} onChange={e=>{
    const value=e.target.value as ReadingMode;change(value);
    if(value!=='original'&&!task)void request('translation',Math.max(0,cue));
  }}><option value="original">Original</option><option value="bilingual">English + 中文</option><option value="chinese">中文</option></select></label>
  {mode!=='original'&&<div className="ll-translation-status" role="status">{waiting&&<Loader2 size={13} className="ll-spin"/>}<span>{task?.source==='youtube'?'YouTube Chinese captions':task?.source==='ai'?'AI translation':'Chinese translation'}{task?` · ${task.completed.toLocaleString()} / ${task.total.toLocaleString()} passages`:''}{waiting?' · Translating in the background':''}</span>
    {task&&['paused','failed'].includes(task.status)&&<><p>{task.error}</p><button className="ll-link" disabled={busy} onClick={()=>void request('translation',Math.max(0,cue))}>Resume translation</button></>}
    {task?.status==='complete'&&task.source==='youtube'&&<button className="ll-link" disabled={busy} onClick={()=>change('original')}>Read original</button>}
  </div>}</>;
}
