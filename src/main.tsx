import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, AudioLines, Check, CheckCircle2, ChevronDown, Clock3, Copy, Download, FileAudio, FileText, Headphones, History, Link2, Loader2, LogOut, Menu, MoreHorizontal, Plus, Search, ShieldCheck, Trash2, Upload, X, Youtube, Zap } from 'lucide-react';
import { PACKAGES, STATUS_LABELS, shortTime, MAX_BYTES, type Job, type Quote, type Transcript } from '../shared/model';
import { SAMPLE } from '../shared/sample';
import './style.css';
import { LearningApp } from './learning';

type User = { id: string; email: string; balance: number; reserved: number; demo: boolean; blocked: boolean };
type Config = { environment: string; transcription: boolean; links: boolean; uploads: boolean; localAsr: boolean; billing: boolean; demo: boolean; supportEmail: string; globalConcurrency: number; userConcurrency: number };
const initialConfig: Config = { environment: 'production', transcription: false, links: false, uploads: false, localAsr: false, billing: false, demo: false, supportEmail: '', globalConcurrency: 2, userConcurrency: 1 };
async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'small' : ''}`}><span className="brand-icon"><span /><span /><span /></span><span>transcript<span className="brand-light"> studio</span></span></span>;
}
function App() {
  const [path, setPath] = useState(location.pathname);
  const [config, setConfig] = useState<Config>(initialConfig);
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState<'login' | 'pricing' | 'account' | 'help' | null>(null);
  const [toast, setToast] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [active, setActive] = useState<{job: Job; transcript: Transcript | null} | null>(null);
  const [busy, setBusy] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function message(text: string) { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6000); }
  function navigate(to: string) { history.pushState({}, '', to); setPath(to.split('?')[0]); setSidebar(false); window.scrollTo(0, 0); }
  async function refreshUser() { const data = await api('/me'); setUser(data.user); return data.user as User | null; }
  async function refreshJobs() { const data = await api('/jobs'); setJobs(data.jobs); }
  useEffect(() => {
    Promise.all([api<Config>('/config'), api('/me')]).then(([c, u]) => { setConfig(c); setUser(u.user); }).catch(e => message(e.message)).finally(() => setLoaded(true));
    const handle = () => setPath(location.pathname);
    window.addEventListener('popstate', handle);
    return () => { window.removeEventListener('popstate', handle); clearTimeout(toastTimer.current); };
  }, []);
  const activeId = path.match(/^\/app\/([a-f0-9-]+)$/)?.[1];
  useEffect(() => {
    if (!user) { setJobs([]); return; }
    let alive = true;
    const refresh = async () => {
      try {
        const data = await api('/jobs');
        if (!alive) return;
        setJobs(data.jobs);
        if (activeId) { const selected = await api(`/jobs/${activeId}`); if (alive) setActive(selected); }
        const me = await api('/me'); if (alive) setUser(me.user);
      } catch (e) { if (alive) message((e as Error).message); }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [user?.id, activeId]);
  useEffect(() => { setActive(null); }, [activeId]);
  useEffect(() => {
    document.title = path.startsWith('/app') ? 'Your workspace — Transcript Studio' : 'Transcript Studio — Give every word a place.';
    const meta = document.querySelector('meta[name="robots"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'robots' }));
    meta.setAttribute('content', path.startsWith('/app') || path.startsWith('/auth') ? 'noindex, nofollow' : 'index, follow');
  }, [path]);
  async function openSample() {
    setBusy('sample');
    try {
      if (!user) { await api('/auth/demo', {}); await refreshUser(); }
      const { quote } = await api('/quotes', { sample: true, rights: true });
      const { id } = await api('/jobs', { quoteId: quote.id });
      await refreshJobs(); navigate(`/app/${id}`);
    } catch (e) { message((e as Error).message); } finally { setBusy(''); }
  }
  async function openLocalTest() {
    setBusy('live-test');
    try {
      await api('/auth/local-asr', {}); await refreshUser();
      const { quote } = await api('/quotes', { realTest: true, rights: true });
      const { id } = await api('/jobs', { quoteId: quote.id });
      await refreshJobs(); await refreshUser(); navigate(`/app/${id}`);
    } catch (e) { message((e as Error).message); } finally { setBusy(''); }
  }
  async function selectJob(job: Job) { navigate(`/app/${job.id}`); }
  async function deleteJob(job: Job) {
    if (!confirm('Delete this transcript and its uploaded file? This cannot be undone.')) return;
    try { await api(`/jobs/${job.id}`, undefined, 'DELETE'); await refreshJobs(); navigate('/app'); message('Transcript deleted.'); }
    catch (e) { message((e as Error).message); }
  }
  async function cancelJob(job: Job) {
    try { await api(`/jobs/${job.id}/cancel`, {}); setActive(await api(`/jobs/${job.id}`)); await refreshJobs(); await refreshUser(); message('Cancellation requested. Reserved minutes return when processing is confirmed stopped.'); }
    catch (e) { message((e as Error).message); }
  }
  async function buy(pack: keyof typeof PACKAGES) {
    if (!user) { setModal('login'); return; }
    setBusy(pack);
    try { const result = await api('/billing/checkout', { pack }); location.href = result.url; }
    catch (e) { message((e as Error).message); } finally { setBusy(''); }
  }
  const workspace = path.startsWith('/app');
  return <>
    {config.localAsr && <div className="preview-strip"><span className="tiny-dot"/>Local test · Official 6-second audio · 2 test minutes, granted once.<button className="text-button" onClick={openLocalTest} disabled={!!busy}>{busy === 'live-test' ? 'Submitting…' : 'Run real ASR test · 1 min'}</button></div>}
    {workspace ? <div className="workspace">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <button className="brand-button" onClick={() => navigate('/')} aria-label="Home"><Brand small /></button>
        <button className="new-button" onClick={() => navigate('/app')}><Plus size={17} />New transcript<span>↵</span></button>
        <div className="library-label"><History size={14} /> YOUR LIBRARY <span>{jobs.length}</span></div>
        <div className="library">
          {jobs.length ? jobs.map(job => <button className={`library-item ${activeId === job.id ? 'selected' : ''}`} key={job.id} onClick={() => selectJob(job)}>
            <FileText size={16} /><span><strong>{job.title}</strong><small>{job.source === 'sample' ? 'Sample' : job.source === 'x' ? 'X video' : job.source} · {shortTime(job.duration)}</small></span>
            {['running','queued'].includes(job.status) && <span className="status-dot" />}
          </button>) : <p className="empty-library">A home for the words<br />you want to keep.</p>}
        </div>
        <div className="sidebar-bottom">
          {user && <div className="balance-card"><div><Clock3 size={15} /><b>{user.balance}</b> min available</div>{user.reserved > 0 && <small>{user.reserved} min reserved for processing</small>}<button onClick={() => setModal('pricing')}>{user.demo ? 'Explore minute packs' : 'Add minutes'}<ArrowUpRight size={14}/></button></div>}
          <button className="account-button" onClick={() => setModal(user ? 'account' : 'login')}><span className="avatar">{user?.demo ? 'S' : user?.email[0].toUpperCase() || 'G'}</span><span><b>{user?.demo ? 'Sample workspace' : user ? 'Your account' : 'Sign in'}</b><small>{user?.demo ? 'Local preview' : user?.email || 'Keep your transcripts'}</small></span><MoreHorizontal size={17}/></button>
        </div>
      </aside>
      {sidebar && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebar(false)}/>}
      <main className="workspace-main">
        <div className="workspace-top"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={20}/></button><span>Workspace <span className="crumb">/</span> {activeId ? 'Transcript' : 'New transcript'}</span><button className="text-button" onClick={() => setModal('help')}>Help & support <ArrowUpRight size={13}/></button></div>
        {user?.demo && <div className="preview-strip"><span className="tiny-dot"/>Sample workspace · Fixed example text. No live transcription or payment.</div>}
        {!loaded ? <div className="center-state"><Loader2 className="spin" />Loading your workspace…</div>
          : !user ? <div className="center-state"><Brand/><h1>Your words, all in one place.</h1><p>Sign in to save transcripts and keep track of your minutes.</p><button className="primary" onClick={() => setModal('login')}>Sign in with email <ArrowRight size={17}/></button>{config.demo && <button className="text-button" onClick={openSample}>Explore the sample workspace</button>}</div>
          : activeId ? active ? <Reader data={active} message={message} onDelete={deleteJob} onCancel={cancelJob} support={() => setModal('help')}/> : <div className="center-state"><Loader2 className="spin"/>Opening transcript…</div>
          : <div className="composer-page"><div className="eyebrow">LESS REWINDING. MORE UNDERSTANDING.</div><h1>What are we listening to?</h1><p className="subtitle">A link, a file, a conversation worth keeping.</p><Composer user={user} config={config} onLogin={() => setModal('login')} onSample={openSample} busySample={busy === 'sample'} message={message} onOpen={id => { refreshJobs(); refreshUser(); navigate(`/app/${id}`); }}/><div className="recent"><div className="section-label">RECENT TRANSCRIPTS<span>{jobs.length ? 'Pick up where you left off' : 'Your library starts here'}</span></div>{jobs.slice(0, 4).map(job => <button className="recent-row" key={job.id} onClick={() => selectJob(job)}><span className="file-badge"><FileText size={20}/></span><span><b>{job.title}</b><small>{job.source === 'sample' ? 'SAMPLE' : job.source.toUpperCase()} · {shortTime(job.duration)}</small></span><span className={`job-label ${job.status}`}>{STATUS_LABELS[job.status]}</span><ArrowUpRight size={17}/></button>)}{!jobs.length && <button className="sample-row" onClick={openSample} disabled={!config.demo}><Headphones size={21}/><span><b>Take a look around.</b><small>Open a short sample and try search, timestamps, and exports.</small></span><ArrowRight size={18}/></button>}</div></div>}
      </main>
    </div> : path === '/auth/verify' ? <Verify onDone={async () => { await refreshUser(); navigate('/app'); }} onRetry={() => setModal('login')}/> : <>
      <header className="site-header"><button className="brand-button" onClick={() => navigate('/')}><Brand/></button><nav><button onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}>How it works</button><button onClick={() => setModal('pricing')}>Pricing</button><button className="login-link" onClick={() => user ? navigate('/app') : setModal('login')}>{user ? 'Workspace' : 'Log in'}</button><button className="header-cta" onClick={() => user ? navigate('/app') : setModal('login')}>Get started<ArrowUpRight size={15}/></button></nav></header>
      <main>
        <section className="hero"><div className="hero-main"><div className="eyebrow"><span className="tiny-dot"/> MADE FOR THE WORDS THAT MATTER</div><h1>{path === '/youtube-transcript' ? <>From YouTube.<br/>To your next <em>idea.</em></> : path === '/x-transcript' ? <>Keep the words.<br/>Beyond the <em>feed.</em></> : path === '/upload-transcript' ? <>Your recordings.<br/>Ready to <em>read.</em></> : <>Give every word<br/>a <em>place.</em></>}</h1><p className="hero-description">Turn videos and audio into clear, searchable text.<br className="desktop-break"/> Find the thought. Keep the quote. Make it yours.</p>
        <Composer compact user={user} config={config} onLogin={() => setModal('login')} onSample={openSample} busySample={busy === 'sample'} message={message} onOpen={id => navigate(`/app/${id}`)}/>
        <div className="hero-footnotes"><span><Check size={14}/> No subscription</span><span><Check size={14}/> No API keys needed</span><span><Check size={14}/> Your files stay private</span></div>
        </div><div className="hero-preview"><div className="preview-note"><span>FROM SPOKEN TO WRITTEN</span><span className="note-line"/></div><div className="paper-preview"><div className="paper-top"><span className="paper-dots"><i/><i/><i/></span><span>transcript.txt</span><FileText size={14}/></div><div className="paper-content"><div className="paper-meta"><span className="green-dot"/> A MOMENT OF CLARITY <span>00:57</span></div><h2>A small practice<br/>for better listening</h2><div className="paper-divider"/>{SAMPLE.segments.slice(0, 3).map((s, i) => <div className={`paper-segment ${i === 2 ? 'highlighted' : ''}`} key={s.start}><span>{shortTime(s.start)}</span><p>{s.text}</p></div>)}<div className="paper-cursor"/><div className="paper-export"><span><CheckCircle2 size={14}/> Every word, within reach.</span><Download size={16}/></div></div></div><div className="floating-format"><span className="format-icon"><FileText size={20}/></span><div><b>Ready for what’s next.</b><span>TXT <i>·</i> SRT <i>·</i> VTT <i>·</i> Markdown</span></div></div><span className="sample-caption">Illustrative sample · Original example text</span></div></section>
        <section className="source-strip"><span>BRING YOUR<br/><b>own source.</b></span><button onClick={() => navigate('/youtube-transcript')}><Youtube size={26}/><span>YouTube<small>Videos, Shorts & finished replays</small></span></button><button onClick={() => navigate('/x-transcript')}><span className="x-logo">𝕏</span><span>X / Twitter<small>Public, single-video posts</small></span></button><button onClick={() => navigate('/upload-transcript')}><FileAudio size={25}/><span>Your files<small>MP3, M4A, WAV, MP4, WEBM</small></span></button></section>
        <section className="how-section" id="how-it-works"><div><span className="eyebrow">A SHORTER PATH TO THE GOOD PART</span><h2>Listen once.<br/><em>Come back to anything.</em></h2></div><div className="steps">{[{n:'01', title:'Bring a link or a file.', text:'Start with a public video or your own recording. Check its duration and minute estimate before processing.', icon:Link2},{n:'02',title:'Let the words come through.',text:'We use existing captions when available or generate a transcript in the original spoken language.',icon:AudioLines},{n:'03',title:'Find it. Keep it. Use it.',text:'Search your transcript, jump to timestamps, and export text or subtitle files for your next step.',icon:FileText}].map(s => <div className="step" key={s.n}><span className="step-no">{s.n}</span><s.icon size={23}/><h3>{s.title}</h3><p>{s.text}</p></div>)}</div></section>
        <section className="honest-section"><div><ShieldCheck size={24}/><h3>A little clarity before you start.</h3></div><p>Up to 120 minutes per recording and 250 MB per upload. Public, accessible content only. No live streams, private posts, or members-only videos. Original files expire after 24 hours; transcripts stay for 30 days. Save an export to keep them longer.</p>{!config.transcription && <span className="availability-note">Early preview · Live transcription is not open yet.</span>}</section>
        <section className="bottom-cta"><span className="eyebrow">GOOD IDEAS DESERVE A SECOND READ</span><h2>Your next thought<br/>might already be <em>in there.</em></h2><button className="primary" onClick={config.demo ? openSample : () => setModal('login')}>{config.demo ? 'Explore a sample transcript' : 'Get started'}<ArrowRight size={17}/></button></section>
      </main><footer><Brand small/><span>A quieter way to work with words.</span><button onClick={() => setModal('help')}>Help & privacy<ArrowUpRight size={13}/></button></footer>
    </>}
    {modal && <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setModal(null)}><section className={`modal ${modal === 'pricing' || modal === 'account' ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={modal}><button className="modal-close icon-button" aria-label="Close" onClick={() => setModal(null)}><X size={20}/></button>
      {modal === 'login' && <Login config={config} onSample={() => { setModal(null); openSample(); }} message={message}/>}
      {modal === 'pricing' && <><div className="eyebrow">PAY FOR WHAT YOU USE</div><h2>A few minutes.<br/>A lot of possibilities.</h2><p className="subtitle">One-time minute packs. No automatic renewal.</p><div className="price-grid">{Object.entries(PACKAGES).map(([key,p]) => <div className={`price-card ${key === 'plus' ? 'featured' : ''}`} key={key}><span className="eyebrow">{p.name}</span><h3>${p.cents / 100}<small> / one time</small></h3><b>{p.minutes} transcription minutes</b><p>All supported sources<br/>Search and timestamped reading<br/>TXT, Markdown, SRT & VTT</p><button className={key === 'plus' ? 'primary' : 'secondary'} disabled={!config.billing || !!user?.demo || !!busy} onClick={() => buy(key as keyof typeof PACKAGES)}>{busy === key ? 'Opening checkout…' : !config.billing || user?.demo ? 'Not open for purchase yet' : 'Get minutes'}<ArrowRight size={16}/></button></div>)}</div><p className="fine-print">Each request uses at least 1 minute, rounded up to the next minute. We reserve minutes when you confirm and use them only when your transcript is delivered. Subtitle exports require valid timestamps. Prices are preview proposals until checkout opens.</p></>}
      {modal === 'account' && user && <Account user={user} onPricing={() => setModal('pricing')} onLogout={async () => { await api('/auth/logout', {}); setUser(null); setModal(null); navigate('/'); }} message={message}/>}
      {modal === 'help' && <><div className="eyebrow">A NOTE FROM THE STUDIO</div><h2>Help & privacy</h2><div className="help-copy"><h3>What can I transcribe?</h3><p>Public YouTube videos, Shorts and finished replays; public X posts with one native video; or your own MP3, M4A, WAV, MP4 and WEBM files. Live, private, restricted and members-only content is not supported.</p><h3>How do minutes work?</h3><p>Check your estimate before confirming. Minutes are held while a task waits or runs. Failed tasks return their minutes. If provider status is uncertain, we check it without starting another paid request; unresolved requests return their reserved minutes within 24 hours.</p><h3>Where do my files go?</h3><p>Uploaded files are private and read by our processing provider through a temporary link. Original media expires after 24 hours and transcripts after 30 days. Delete a finished transcript in your workspace to remove it and its uploaded file. Payment records are retained for accounting.</p><h3>Need a hand?</h3><p>Include your task ID when reporting a problem. Do not send your full transcript unless needed.</p>{config.supportEmail ? <a href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a> : <p className="notice">This is a development preview. Public support and final legal policies will be added before launch.</p>}</div></>}
    </section></div>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="Dismiss message" onClick={() => setToast('')}><X size={15}/></button></div>}
  </>;
}
function Composer({ compact = false, user, config, onLogin, onSample, busySample, message, onOpen }: { compact?: boolean; user: User | null; config: Config; onLogin: () => void; onSample: () => void; busySample: boolean; message: (s:string)=>void; onOpen:(id:string)=>void }) {
  const [tab, setTab] = useState<'link'|'file'>('link'), [url,setUrl] = useState(''), [file,setFile] = useState<File|null>(null);
  const [quote,setQuote] = useState<Quote|null>(null), [busy,setBusy] = useState(''), [rights,setRights] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const enabled = config.transcription && !user?.demo && (tab === 'file' ? config.uploads : config.links);
  async function check() {
    if (!user) { onLogin(); return; }
    if (!enabled) { message('Live transcription is not open yet. Explore the sample to try the workspace.'); return; }
    if (!rights) { message('Please confirm that you have permission to transcribe this content.'); return; }
    setBusy('Checking your source…'); setQuote(null);
    try {
      let uploadId: string | undefined;
      if (tab === 'file') {
        if (!file) throw new Error('Choose a file first.');
        if (file.size > MAX_BYTES) throw new Error('Your file must be 250 MB or smaller.');
        const upload = await api('/uploads', { name: file.name, size: file.size });
        setBusy('Uploading your file…');
        const response = await fetch(upload.url, { method:'PUT', headers: {'Content-Type':upload.mime}, body:file });
        if (!response.ok) throw new Error('The file could not be uploaded. Please try again.');
        setBusy('Checking audio and duration…');
        await api(`/uploads/${upload.id}/complete`, {});
        uploadId = upload.id;
      }
      const result = await api('/quotes', { url: tab === 'link' ? url : undefined, uploadId, rights:true });
      if (result.existingJobId) { onOpen(result.existingJobId); return; }
      setQuote(result.quote);
    } catch(e) { message((e as Error).message); } finally { setBusy(''); }
  }
  async function confirmQuote() {
    if (!quote) return;
    setBusy('Adding to your queue…');
    try { const result = await api('/jobs', {quoteId:quote.id}); onOpen(result.id); }
    catch(e) { message((e as Error).message); } finally { setBusy(''); }
  }
  return <div className={`composer ${compact ? 'compact' : ''}`}>
    <div className="input-tabs"><button className={tab === 'link' ? 'active' : ''} onClick={() => {setTab('link');setQuote(null);}}><Link2 size={16}/>Paste a link</button><button className={tab === 'file' ? 'active' : ''} onClick={() => {setTab('file');setQuote(null);}}><Upload size={16}/>Upload a file</button>{!compact && <span className="private-label"><ShieldCheck size={13}/>PRIVATE BY DEFAULT</span>}</div>
    {tab === 'link' ? <form className="url-form" onSubmit={e => {e.preventDefault();check();}}><Link2 size={20}/><input type="url" aria-label="Video URL" placeholder="Paste a YouTube or X video link" value={url} onChange={e => {setUrl(e.target.value);setQuote(null);}}/><button className="primary" type="submit" disabled={!!busy || !url.trim()} aria-label="Check video link">{busy ? <Loader2 className="spin" size={17}/> : compact ? <ArrowRight size={20}/> : <>Check link<ArrowRight size={17}/></>}</button></form> : <><input ref={input} type="file" accept=".mp3,.m4a,.wav,.mp4,.webm" className="visually-hidden" onChange={e => {setFile(e.target.files?.[0] || null);setQuote(null);}}/><button className="dropzone" onClick={() => input.current?.click()}><span><Upload size={22}/></span><b>{file ? file.name : 'Choose an audio or video file'}</b><small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · Click to change` : 'MP3, M4A, WAV, MP4, WEBM · Up to 250 MB'}</small></button>{file && <button className="primary upload-submit" disabled={!!busy} onClick={check}>Check file<ArrowRight size={16}/></button>}</>}
    {enabled && <label className="rights"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)}/>I own this content or have permission to transcribe it.</label>}
    {busy && <p className="input-status" role="status"><Loader2 size={14} className="spin"/>{busy}</p>}
    {quote && <div className="quote"><span className="eyebrow">YOUR ESTIMATE</span><h3>{quote.title}</h3><div><span>{shortTime(quote.duration)} of audio</span><b>{quote.minutes} {quote.minutes === 1 ? 'minute' : 'minutes'}</b></div><p>Held now, used only when your transcript is delivered. Existing captions may be used; otherwise we generate text in the original language.</p><button className="primary" disabled={!!busy || (user?.balance || 0) < quote.minutes} onClick={confirmQuote}>{(user?.balance || 0) < quote.minutes ? 'Not enough available minutes' : 'Confirm & transcribe'}<ArrowRight size={16}/></button></div>}
    <div className="composer-bottom"><span>{!enabled ? 'Live processing is not open yet.' : 'Up to 120 minutes · Original language'}</span>{config.demo && <button onClick={onSample} disabled={busySample} className="sample-link">{busySample ? 'Opening…' : 'Try a sample'}<ArrowUpRight size={13}/></button>}</div>
  </div>;
}
function Reader({data, message, onDelete, onCancel, support}: {data:{job:Job;transcript:Transcript|null};message:(s:string)=>void;onDelete:(j:Job)=>void;onCancel:(j:Job)=>void;support:()=>void}) {
  const {job,transcript:t} = data;
  const cjk = t ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t.text) : false;
  const count = t ? cjk ? [...t.text.replace(/\s/g, '')].length : t.text.trim().split(/\s+/).length : 0;
  const language = t?.language === 'en' ? 'English' : !t?.language || t.language === 'und' ? 'Original language' : t.language;
  const [search,setSearch] = useState(''), [format,setFormat] = useState('txt'), [timestamps,setTimestamps] = useState(true), [selected,setSelected] = useState(-1);
  const matches = t?.segments.filter(s => s.text.toLowerCase().includes(search.toLowerCase())) || [];
  const highlight = (text:string) => {
    if (!search) return text;
    const parts = text.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'ig'));
    return parts.map((p,i) => p.toLowerCase() === search.toLowerCase() ? <mark key={i}>{p}</mark> : p);
  };
  async function copy() {
    try { await navigator.clipboard.writeText(t?.text || '');message('Transcript copied.'); } catch { message('Clipboard access is unavailable. Use the TXT export.'); }
  }
  return <article className="reader"><div className="reader-pretitle"><span className="source-tag">{job.source === 'sample' ? <FileText size={13}/> : job.source === 'youtube' ? <Youtube size={14}/> : <Headphones size={14}/>} {job.source === 'sample' ? 'SAMPLE TRANSCRIPT' : job.source === 'doubao-test' ? 'LIVE ASR TEST' : job.source.toUpperCase()}</span><button className="icon-button delete-button" title="Delete transcript" aria-label="Delete transcript" onClick={() => onDelete(job)} disabled={['running','review','review_refunded'].includes(job.status)}><Trash2 size={16}/></button></div><h1>{job.title}</h1><div className="reader-meta"><span><Clock3 size={14}/>{shortTime(job.duration)}</span><span>{language}</span><span>{new Date(job.created_at*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>{t && <span className="ready-label"><Check size={13}/>{t.source === 'native' ? 'Existing captions' : t.source === 'sample' ? 'Example text' : 'AI-generated'}</span>}</div>
    {!t ? <div className="job-state">{['queued','running'].includes(job.status) ? <span className="processing-icon"><AudioLines size={30}/></span> : <span className="processing-icon"><Clock3 size={30}/></span>}<h2>{STATUS_LABELS[job.status]}</h2><p>{job.error || (job.status === 'queued' ? 'Your place in the queue is saved. You can leave this page and return later.' : job.status === 'running' ? 'We are turning the audio into text. Your minutes stay reserved until delivery.' : 'Your request status is saved in your library.')}</p><div className="job-id">TASK {job.id}</div>{['queued','running'].includes(job.status) && <button className="secondary" onClick={() => onCancel(job)} disabled={!!job.cancel_requested}>{job.cancel_requested ? 'Cancellation requested' : 'Cancel request'}</button>}{job.status.startsWith('review') && <button className="secondary" onClick={support}>Contact support</button>}</div> : <>
      <div className="reader-toolbar"><label className="search-box"><Search size={17}/><input placeholder="Find a word or phrase…" aria-label="Search transcript" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14}/></button>}</label><div className="reader-actions"><button className="icon-button" title="Copy transcript" aria-label="Copy transcript" onClick={copy}><Copy size={17}/></button><span className="toolbar-divider"/><select aria-label="Export format" value={format} onChange={e => setFormat(e.target.value)}><option value="txt">TXT</option><option value="md">Markdown</option>{t.timed && <><option value="srt">SRT</option><option value="vtt">VTT</option></>}</select><a className="export-button" href={`/api/jobs/${job.id}/export?format=${format}`} download><Download size={15}/><span>Export</span></a></div></div>
      <div className="reading-options"><span>{search ? `${t.timed ? matches.length : t.text.toLowerCase().includes(search.toLowerCase()) ? 1 : 0} matching ${matches.length === 1 ? 'passage' : 'passages'}` : `${count} ${cjk ? 'characters' : 'words'} · About ${Math.max(1,Math.ceil(count / (cjk ? 400 : 220)))} min read`}</span>{t.timed && <button role="switch" aria-checked={timestamps} onClick={() => setTimestamps(!timestamps)}><span className={`toggle ${timestamps ? 'on' : ''}`}/>Timestamps</button>}</div>
      <div className={`transcript-body ${timestamps ? '' : 'hide-timestamps'}`}>{t.timed ? (search ? matches : t.segments).map(s => <div className={`transcript-segment ${selected === s.start ? 'focused' : ''}`} key={s.start}><button className="timestamp" title={job.source === 'youtube' ? 'Open video at this time' : 'Select this passage'} onClick={() => {setSelected(s.start); if(job.source === 'youtube' && job.input_url) window.open(`${job.input_url}&t=${Math.floor(s.start)}`,'_blank','noopener,noreferrer');}}>{shortTime(s.start)}</button><p>{highlight(s.text)}</p></div>) : <div className="untimed-text">{highlight(t.text)}</div>}{search && t.timed && !matches.length && <div className="no-matches"><Search size={24}/><p>No passages match “{search}”.</p><button className="text-button" onClick={() => setSearch('')}>Clear search</button></div>}</div>
      <div className="end-mark"><span/><AudioLines size={16}/><span/></div><div className="reader-footer"><span>{job.source === 'sample' ? 'Original sample text · Not a live transcription' : 'Please check important names, figures, and quotes against the source.'}</span><span>Available until {new Date(job.expires_at*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span></div>
    </>}
  </article>;
}
function Login({config,onSample,message}:{config:Config;onSample:()=>void;message:(s:string)=>void}) {
  const [email,setEmail] = useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<any>(null);
  async function submit(e:React.FormEvent) {
    e.preventDefault();setBusy(true);
    try {setResult(await api('/auth/start',{email}));} catch(e){message((e as Error).message);} finally {setBusy(false);}
  }
  return <><Brand/><h2>{result ? 'Check your inbox.' : <>Make room<br/>for your next idea.</>}</h2><p className="subtitle">{result ? `We sent a sign-in link to ${email}. It expires in 15 minutes.` : 'Sign in with a link sent to your email. No password to remember.'}</p>{!result ? <form className="login-form" onSubmit={submit}><label>Email address<input type="email" autoComplete="email" required autoFocus placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/></label><button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send a sign-in link'}<ArrowRight size={17}/></button></form> : result.developmentLink ? <div className="notice">Local development: email delivery is not configured.<a className="development-link" href={result.developmentLink}>Open the local sign-in link<ArrowUpRight size={14}/></a></div> : <div className="notice"><CheckCircle2 size={20}/>You can close this window and open the link in your inbox.</div>}{config.demo && <button className="login-sample text-button" onClick={onSample}>Just looking? Explore a sample<ArrowUpRight size={14}/></button>}<p className="fine-print">Your workspace is private. Only transcribe content you own or have permission to use.</p></>;
}
function Verify({onDone,onRetry}:{onDone:()=>void;onRetry:()=>void}) {
  const [state,setState] = useState(''), [token] = useState(()=>new URLSearchParams(location.hash.slice(1)).get('token') || '');
  useEffect(()=>{history.replaceState({},'',location.pathname);},[]);
  async function verify() {setState('Verifying…');try {await api('/auth/verify',{token});onDone();}catch(e){setState((e as Error).message);}}
  return <main className="verify-page"><Brand/><h1>Welcome back.</h1><p>Confirm to open your private workspace.</p><button className="primary" disabled={!token || state === 'Verifying…'} onClick={verify}>Continue to your workspace<ArrowRight size={17}/></button>{state && <p role="status">{state}</p>}<button className="text-button" onClick={onRetry}>Request a new sign-in link</button></main>;
}
function Account({user,onPricing,onLogout,message}:{user:User;onPricing:()=>void;onLogout:()=>void;message:(s:string)=>void}) {
  const [data,setData]=useState<any>(null);
  useEffect(()=>{api('/account').then(setData).catch(e=>message(e.message));},[]);
  return <><div className="eyebrow">YOUR ACCOUNT</div><h2>{user.demo ? 'A little room to explore.' : 'Every minute, accounted for.'}</h2><p className="subtitle">{user.email}</p><div className="account-balances"><div><strong>{user.balance}</strong><span>Available minutes</span></div><div><strong>{user.reserved}</strong><span>Reserved minutes</span></div><button className="secondary" onClick={onPricing}>Add minutes<Plus size={15}/></button></div><h3 className="account-heading">Minute history</h3>{data?.ledger.length ? <div className="ledger">{data.ledger.map((l:any,i:number)=><div key={i}><span><b>{l.note}</b><small>{new Date(l.created_at*1000).toLocaleString('en-US')}</small></span><strong className={l.available_delta>0 ? 'positive' : ''}>{l.available_delta>0 ? '+' : ''}{l.available_delta} min{l.reserved_delta!==0 && <small>{l.reserved_delta>0 ? '+' : ''}{l.reserved_delta} held</small>}</strong></div>)}</div> : <p className="fine-print">{data ? 'No minute activity yet.' : 'Loading history…'}</p>}{data?.orders.length>0 && <><h3 className="account-heading">Orders</h3>{data.orders.map((o:any)=><div className="order-row" key={o.id}><span>{o.minutes} minutes · ${o.cents/100}</span><b>{o.status}</b></div>)}</>}<button className="text-button logout" onClick={onLogout}><LogOut size={15}/>Sign out</button></>;
}
createRoot(document.getElementById('root')!).render(location.pathname.startsWith('/app') ? <App/> : <LearningApp/>);
