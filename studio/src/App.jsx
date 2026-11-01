import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clapperboard, Download, Film, FolderOpen, Image, LoaderCircle, Play, Plus, Save, Settings2, Upload, X } from 'lucide-react';
import { api, downloadJSON, post } from './api.js';
import { AssetLibrary, Exports, IconButton, Inspector, Preview, ScriptPanel, Settings } from './components.jsx';

export default function App() {
  const [status, setStatus] = useState(null);
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [assets, setAssets] = useState([]);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState('editor');
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('已保存');
  const [busy, setBusy] = useState('');
  const [issues, setIssues] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [quality, setQuality] = useState('preview');
  const [settings, setSettings] = useState({ mode: 'local', model: 'deepseek-chat', key: '' });
  const [checkOpen, setCheckOpen] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const roleMutation = useRef(false);
  const projectRef = useRef(project);
  const importRef = useRef(null);
  projectRef.current = project;
  const refreshAssets = useCallback(async () => setAssets(await api('/api/assets')), []);
  const refreshProjects = useCallback(async () => setProjects(await api('/api/projects')), []);
  const refreshJobs = useCallback(async id => {
    const records = await api(`/api/projects/${id}/jobs`); setJobs(records);
    const active = records.find(j => j.state === 'queued' || j.state === 'running');
    if (active) setJob(active);
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const [environment, records, library] = await Promise.all([api('/api/status'), api('/api/projects'), api('/api/assets')]);
        setStatus(environment); setProjects(records); setAssets(library);
        const remembered = localStorage.getItem('expression-studio-project-v1');
        const id = records.find(p => p.id === remembered)?.id || records[0]?.id;
        const current = id ? await api(`/api/projects/${id}`) : await post('/api/projects', { name: '我的第一条短剧' });
        setProject(current); await refreshProjects(); await refreshJobs(current.id);
      } catch (e) { setError(e.message); }
    })();
  }, [refreshProjects, refreshJobs]);
  const save = useCallback(async snapshot => {
    if (!snapshot || roleMutation.current) return;
    const operation = saveQueue.current.catch(() => {}).then(() => api(`/api/projects/${snapshot.id}`, { method: 'PUT', body: JSON.stringify(snapshot) }));
    saveQueue.current = operation;
    try {
      await operation;
      if (projectRef.current === snapshot) setSaveState('已保存');
    } catch (e) { if (projectRef.current === snapshot) setSaveState('未保存'); throw e; }
  }, []);
  useEffect(() => {
    if (!project) return;
    localStorage.setItem('expression-studio-project-v1', project.id);
    setSaveState('待保存');
    const timer = setTimeout(() => save(project).catch(() => {}), 700);
    return () => clearTimeout(timer);
  }, [project, save]);
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    const timer = setTimeout(() => post('/api/check', project, { signal: controller.signal }).then(r => setIssues(r.issues)).catch(e => { if (e.name !== 'AbortError') setIssues([{ index: selected, kind: 'validation', message: e.message }]); }), 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [project, assets, selected]);
  useEffect(() => {
    function warn(e) { if (saveState !== '已保存') { e.preventDefault(); e.returnValue = ''; } }
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.state)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api(`/api/jobs/${job.id}`); setJob(current);
        if (!['queued', 'running'].includes(current.state)) {
          clearInterval(timer); await refreshJobs(projectRef.current.id);
          if (current.state === 'done') setView('exports');
          if (current.state === 'failed') setError(current.message);
        }
      } catch (e) { setError(e.message); }
    }, 1200);
    return () => clearInterval(timer);
  }, [job?.id, job?.state, refreshJobs]);
  async function switchProject(id) {
    try {
      await save(project); const next = await api(`/api/projects/${id}`);
      setProject(next); setSelected(0); setJob(null); await refreshJobs(id); await refreshProjects();
    } catch (e) { setError(e.message); }
  }
  async function createProject() {
    try {
      await save(project); const next = await post('/api/projects', { name: `短剧 ${projects.length + 1}` });
      setProject(next); setSelected(0); setJobs([]); setView('editor'); await refreshProjects();
    } catch (e) { setError(e.message); }
  }
  async function restore(file) {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      await save(project);
      const next = await post('/api/projects', { name: value.name || '导入的短剧' });
      const restored = { ...value, id: next.id };
      const saved = await api(`/api/projects/${next.id}`, { method: 'PUT', body: JSON.stringify(restored) });
      setProject(saved); setSelected(0); setView('editor'); setJobs([]); await refreshProjects();
    } catch (e) { setError(`导入失败：${e.message}`); } finally { importRef.current.value = ''; }
  }
  async function render() {
    setBusy('render');
    try {
      await save(project);
      const checked = await post('/api/check', project); setIssues(checked.issues);
      if (checked.issues.length) { setCheckOpen(true); return; }
      setJob(await post('/api/render', { project, quality }));
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  function handleAssetChanged({ asset, deleted }) {
    setAssets(items => deleted ? items.filter(a => a.id !== asset.id) : items.map(a => a.id === asset.id ? asset : a));
    setProject(p => ({ ...p, segments: p.segments.map(segment => {
      const next = { ...segment };
      for (const field of ['asset_id', 'scene_id', 'audio_id']) {
        if (next[field] === asset.id && (deleted || field === 'asset_id' && next.display !== asset.role)) next[field] = '';
      }
      return next;
    }) }));
  }
  async function deleteRole(role, replacement, assetAction) {
    if (roleMutation.current) return;
    roleMutation.current = true; setBusy('delete-role');
    try {
      await saveQueue.current.catch(() => {});
      const result = await api(`/api/projects/${projectRef.current.id}/roles/${role}`, {
        method: 'DELETE', body: JSON.stringify({ project: projectRef.current, replacement, asset_action: assetAction }),
      });
      setProject(result.project); setAssets(result.assets); setSaveState('已保存');
    } finally { roleMutation.current = false; setBusy(''); }
  }
  const working = job && ['queued', 'running'].includes(job.state);
  if (!project || !status) return <div className="loading-screen"><Clapperboard size={34}/><p>{error || '正在打开工作台…'}</p>{error && <button className="button" onClick={() => location.reload()}>重新连接</button>}</div>;
  const projectStatus = { ...status, roles: project.roles };
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-icon"><Clapperboard size={22}/></span><div><strong>表情短剧</strong><span>本地工作台</span></div></div>
      <div className="project-picker"><label htmlFor="project">当前剧集</label><div><select id="project" value={project.id} disabled={working || !!busy} onChange={e => switchProject(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.id === project.id ? project.name : p.name}</option>)}</select><IconButton icon={Plus} label="新建剧集" disabled={working || !!busy} onClick={createProject}/></div></div>
      <nav aria-label="工作台导航">{[['editor', Clapperboard, '台词分镜'], ['assets', Image, '素材库'], ['settings', Settings2, '声音与设置'], ['exports', Film, '导出记录']].map(([key, Icon, label]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => setView(key)}><Icon size={18}/><span>{label}</span>{key === 'assets' && <span className="nav-count">{assets.filter(a => a.kind !== 'audio').length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div><span className="status-dot"/>本机运行</div><div className="sidebar-tools"><button onClick={() => importRef.current.click()} disabled={working || !!busy}><Upload size={15}/>导入项目</button><button onClick={() => downloadJSON(project, `${project.name}.json`)}><Download size={15}/>备份项目</button></div><input ref={importRef} type="file" accept="application/json" hidden onChange={e => restore(e.target.files[0])}/></div>
    </aside>
    <main className="main"><header className="topbar"><div className="project-heading"><input aria-label="剧集名称" value={project.name} maxLength={80} onChange={e => setProject(p => ({ ...p, name: e.target.value }))}/><span className={`save-state ${saveState === '未保存' ? 'error-text' : ''}`}>{saveState === '已保存' ? <Check size={13}/> : null}{saveState}</span></div><div className="top-actions"><IconButton icon={Save} label="保存项目" onClick={() => save(project).catch(e => setError(e.message))}/><select aria-label="导出分辨率" value={quality} onChange={e => setQuality(e.target.value)}><option value="preview">540p 预览</option><option value="full">1080p 成片</option></select><button className="button primary" onClick={render} disabled={!!busy || !!working || !project.segments.length}>{working ? <LoaderCircle className="spin" size={16}/> : <Play size={16}/>}生成视频</button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><IconButton icon={X} label="关闭提示" onClick={() => setError('')}/></div>}
      {view === 'editor' && <><div className="workflow-bar"><div><span className="step active">1</span>文案分镜<span className="step-line"/><span className={`step ${assets.length ? 'active' : ''}`}>2</span>表情与配音<span className="step-line"/><span className={`step ${jobs.some(j => j.state === 'done') ? 'active' : ''}`}>3</span>成片</div><button className={issues.length ? 'check-button warning' : 'check-button'} onClick={() => setCheckOpen(!checkOpen)}>{issues.length ? `${issues.length} 项待处理` : project.segments.length ? '素材检查通过' : '等待文案'}</button></div>
        {checkOpen && <div className="issues-panel">{issues.length ? issues.map((issue, i) => <button key={i} onClick={() => { setSelected(issue.index); setCheckOpen(false); }}>第 {issue.index + 1} 句 · {issue.message}</button>) : <span>当前没有缺失素材。</span>}<button className="text-button" onClick={() => setView('assets')}>打开素材库</button></div>}
        <div className="editor-grid"><ScriptPanel key={project.id} {...{ project, setProject, selected, setSelected, settings, busy, setBusy }} status={projectStatus} onError={setError}/><Preview {...{ project, selected, issues, assets, busy }} onError={setError}/><Inspector {...{ project, setProject, selected, setSelected, assets, refreshAssets, busy }} status={projectStatus} onError={setError}/></div></>}
      {view === 'assets' && <AssetLibrary key={project.id} {...{ assets, refreshAssets, project }} status={projectStatus} onError={setError} onAssetChanged={handleAssetChanged} onDeleteRole={deleteRole} locked={!!working || !!busy}/>}
      {view === 'settings' && <Settings key={project.id} {...{ project, setProject, settings, setSettings, assets }} status={projectStatus}/>}
      {view === 'exports' && <Exports jobs={jobs}/>}
      {working && <div className="job-bar" role="status"><LoaderCircle size={17} className="spin"/><div><strong>{job.message}</strong><progress value={job.progress} max="100"/></div><span>{job.progress}%</span><button className="text-button" disabled={job.cancel_requested} onClick={() => post(`/api/jobs/${job.id}`, {}).then(setJob).catch(e => setError(e.message))}>{job.cancel_requested ? '等待停止' : '停止后续步骤'}</button></div>}
    </main>
  </div>;
}
