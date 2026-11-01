import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Download, FileText, ImagePlus, LoaderCircle, Pencil, Play, Plus, Trash2, Upload, Volume2, X } from 'lucide-react';
import { api, post, uid } from './api.js';

export function IconButton({ icon: Icon, label, ...props }) {
  return <button className="icon-button" title={label} aria-label={label} {...props}><Icon size={17}/></button>;
}
export function Options({ values }) { return Object.entries(values).map(([value, label]) => <option key={value} value={value}>{label}</option>); }
export function Field({ label, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}</label>; }
export function Empty({ icon: Icon = FileText, title }) { return <div className="empty"><Icon size={30} strokeWidth={1.3}/><p>{title}</p></div>; }

function editSegmentText(segment, text) {
  return { ...segment, text, audio_id: '', emphasis: text.includes(segment.emphasis) ? segment.emphasis : '' };
}

function SegmentRow({ segment, index, selected, status, onSelect, onChange, disabled }) {
  const input = useRef(null);
  return <div className={`segment-row segment-editable ${selected ? 'selected' : ''}`}>
    <button className="segment-select" aria-label={`编辑第${index + 1}句台词`} title={`编辑第${index + 1}句台词`} onClick={() => { onSelect(); input.current?.focus(); }}>
      <span className="segment-number">{String(index + 1).padStart(2, '0')}</span>
      <span className="segment-meta"><b className="green-text">{status.roles[segment.speaker]}</b><span>{status.emotions[segment.emotion]}</span></span><Pencil size={13}/>
    </button>
    <textarea ref={input} className="segment-input" aria-label={`第${index + 1}句分镜台词`} rows={3} maxLength={160} value={segment.text} disabled={disabled} onFocus={onSelect} onChange={e => onChange(e.target.value)}/>
  </div>;
}

export function ScriptPanel({ project, setProject, selected, setSelected, status, settings, onError, busy, setBusy }) {
  const [expanded, setExpanded] = useState(project.segments.length === 0);
  const [confirmSplit, setConfirmSplit] = useState(false);
  async function analyze() {
    if (project.segments.length && !confirmSplit) { setConfirmSplit(true); return; }
    setConfirmSplit(false); setBusy('analyze');
    try {
      const result = await post('/api/analyze', { source: project.source, roles: project.roles, mode: settings.mode, model: settings.model, api_key: settings.key });
      setProject(p => ({ ...p, segments: result.segments, roles: result.roles, voices: { ...result.voices, ...p.voices }, analysis_mode: result.mode }));
      setSelected(0); setExpanded(false);
    } catch (e) { onError(e.message); } finally { setBusy(''); }
  }
  function add() {
    const role = Object.keys(project.roles)[0];
    const segment = { id: uid(), text: '新台词', speaker: role, display: role, emotion: 'neutral', motion: 'none', pause_ms: 200, emphasis: '', asset_id: '', scene_id: '', audio_id: '' };
    setProject(p => ({ ...p, segments: [...p.segments, segment] }));
    setSelected(project.segments.length);
  }
  return <section className="script-panel region">
    <div className="panel-title"><h2>台词分镜 <span className="count">{project.segments.length}</span></h2><IconButton icon={Plus} label="添加台词" onClick={add} disabled={!!busy}/></div>
    <div className="source-block">
      <button className="source-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><FileText size={15}/>原始文案<ChevronDown size={15} className={expanded ? 'rotated' : ''}/></button>
      {expanded && <><textarea className="source-input" aria-label="原始文案" value={project.source} maxLength={12000} onChange={e => setProject(p => ({ ...p, source: e.target.value }))} placeholder={'旁白：…\n角色名称：…'} rows={9}/>
        <div className="source-actions"><span>{settings.mode === 'local' ? '本地规则拆句' : 'DeepSeek 分析'}</span><button className="button small" onClick={analyze} disabled={!!busy || !project.source.trim()}>{busy === 'analyze' ? <LoaderCircle className="spin" size={14}/> : <Plus size={14}/>}生成分镜</button></div>
        {confirmSplit && <div className="inline-confirm"><p>重新拆句会替换当前分镜及手动设置。</p><button className="button small" onClick={analyze}>确认替换</button><button className="text-button" onClick={() => setConfirmSplit(false)}>取消</button></div>}
      </>}
    </div>
    <div className="segment-list">
      {!project.segments.length ? <Empty title="还没有台词分镜"/> : project.segments.map((s, i) => <SegmentRow key={s.id} segment={s} index={i} selected={selected === i} status={status} disabled={!!busy} onSelect={() => setSelected(i)} onChange={text => setProject(p => ({ ...p, segments: p.segments.map(segment => segment.id === s.id ? editSegmentText(segment, text) : segment) }))}/>)}
    </div>
    <div className="panel-foot"><span>{project.segments.reduce((n, s) => n + s.text.length, 0)} 字</span><span>{project.analysis_mode === 'deepseek' ? 'AI 分析 · 可编辑' : '本地拆句 · 可编辑'}</span></div>
  </section>;
}

export function Preview({ project, selected, issues, assets, busy, onError }) {
  const [src, setSrc] = useState('');
  const [listening, setListening] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const audioRef = useRef(null);
  const audioURL = useRef('');
  const audioVersion = useRef(0);
  const segment = project.segments[selected];
  useEffect(() => {
    const controller = new AbortController();
    let imageURL;
    const timer = setTimeout(async () => {
      if (!segment) { setSrc(''); return; }
      try {
        const blob = await post('/api/frame', { project, index: selected }, { blob: true, signal: controller.signal });
        imageURL = URL.createObjectURL(blob); setSrc(imageURL);
      } catch (e) { if (e.name !== 'AbortError') setSrc(''); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); if (imageURL) URL.revokeObjectURL(imageURL); };
  }, [project, selected, assets]);
  useEffect(() => () => { audioVersion.current++; audioRef.current?.pause(); URL.revokeObjectURL(audioURL.current); }, []);
  useEffect(() => { audioVersion.current++; audioRef.current?.pause(); setListening(false); }, [selected, segment?.text, segment?.audio_id, segment?.speaker, project.voices]);
  async function listen() {
    if (listening) { audioRef.current?.pause(); setListening(false); return; }
    setAudioLoading(true);
    const version = audioVersion.current;
    try {
      const blob = await post('/api/speech', { project, index: selected }, { blob: true });
      if (version !== audioVersion.current) return;
      URL.revokeObjectURL(audioURL.current);
      audioURL.current = URL.createObjectURL(blob);
      const audio = new Audio(audioURL.current); audioRef.current = audio;
      audio.onended = () => setListening(false);
      await audio.play(); setListening(true);
    } catch (e) { onError(e.message); } finally { setAudioLoading(false); }
  }
  const missing = issues.filter(i => i.index === selected);
  return <section className="preview-panel region">
    <div className="panel-title"><h2>画面预览</h2><span className="muted">9:16</span></div>
    <div className="preview-body"><div className="preview-stage">
      {src && segment ? <img src={src} alt={`第${selected + 1}句画面预览`}/> : <div className="stage-empty"><ImagePlus size={34} strokeWidth={1}/><span>{segment ? '等待有效分镜' : '待添加台词'}</span></div>}
    </div>
    <div className="preview-controls"><span>{segment ? `镜头 ${String(selected + 1).padStart(2, '0')}` : '无镜头'}</span><button className="button" onClick={listen} disabled={!segment || audioLoading || !!busy}>{audioLoading ? <LoaderCircle className="spin" size={16}/> : <Volume2 size={16}/>} {listening ? '停止试听' : '试听本句'}</button></div>
    {missing.length > 0 && <div className="asset-warning"><ImagePlus size={16}/><span>{missing.map(m => m.message).join('；')}</span></div>}
    </div>
  </section>;
}

export function Inspector({ project, setProject, selected, setSelected, assets, refreshAssets, status, onError, busy }) {
  const s = project.segments[selected];
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  function update(values) {
    setProject(p => ({ ...p, segments: p.segments.map((segment, i) => i === selected ? { ...segment, ...values } : segment) }));
  }
  function reorder(delta) {
    const next = selected + delta;
    if (next < 0 || next >= project.segments.length) return;
    setProject(p => { const segments = [...p.segments]; [segments[selected], segments[next]] = [segments[next], segments[selected]]; return { ...p, segments }; });
    setSelected(next);
  }
  function remove() {
    setProject(p => ({ ...p, segments: p.segments.filter((_, i) => i !== selected) }));
    setSelected(Math.max(0, selected - 1));
  }
  async function importAudio(file) {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData(); form.append('file', file); form.append('kind', 'audio');
      const asset = await api('/api/assets', { method: 'POST', body: form });
      update({ audio_id: asset.id }); await refreshAssets();
    } catch (e) { onError(e.message); } finally { setUploading(false); fileRef.current.value = ''; }
  }
  const images = assets.filter(a => a.kind === 'character' && a.role === s?.display);
  const scenes = assets.filter(a => a.kind === 'scene');
  return <section className="inspector region"><div className="panel-title"><h2>镜头设置</h2>{s && <div className="icon-group"><IconButton icon={ArrowUp} label="上移台词" disabled={selected === 0 || !!busy} onClick={() => reorder(-1)}/><IconButton icon={ArrowDown} label="下移台词" disabled={selected === project.segments.length - 1 || !!busy} onClick={() => reorder(1)}/><IconButton icon={Trash2} label="删除本句" disabled={!!busy} onClick={remove}/></div>}</div>
      {!s ? <Empty title="选择一句台词"/> : <div className="inspector-body">
        <Field label="台词"><textarea aria-label="台词" rows={4} maxLength={160} value={s.text} disabled={!!busy} onChange={e => update(editSegmentText(s, e.target.value))}/></Field>
        <div className="field-pair"><Field label="说话人"><select aria-label="说话人" value={s.speaker} onChange={e => update({ speaker: e.target.value, audio_id: '' })}><Options values={status.roles}/></select></Field>
        <Field label="出镜人物"><select aria-label="出镜人物" value={s.display} onChange={e => update({ display: e.target.value, asset_id: '' })}><Options values={status.roles}/></select></Field></div>
        <Field label="表情"><select aria-label="表情" value={s.emotion} onChange={e => update({ emotion: e.target.value, asset_id: '' })}><Options values={status.emotions}/></select></Field>
        <Field label="表情图片"><select aria-label="表情图片" value={s.asset_id || ''} onChange={e => update({ asset_id: e.target.value })}><option value="">按角色与表情自动匹配</option>{images.map(a => <option key={a.id} value={a.id}>{a.name} · {status.emotions[a.emotion]}</option>)}</select></Field>
        <Field label="场景插图"><select aria-label="场景插图" value={s.scene_id || ''} onChange={e => update({ scene_id: e.target.value })}><option value="">纯黑背景</option>{scenes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="field-pair"><Field label="画面动作"><select aria-label="画面动作" value={s.motion} onChange={e => update({ motion: e.target.value })}><Options values={status.motions}/></select></Field><Field label="句后停顿 / 毫秒"><input aria-label="句后停顿" type="number" min="0" max="3000" step="50" value={s.pause_ms} onChange={e => update({ pause_ms: Number(e.target.value) })}/></Field></div>
        <Field label="彩色强调片段"><input aria-label="彩色强调片段" value={s.emphasis || ''} onChange={e => update({ emphasis: e.target.value })} placeholder="台词中的原文片段"/></Field>
        <div className="audio-import"><span className="form-label">本句配音</span><div className="audio-source"><span>{s.audio_id ? '已导入音频' : '角色默认声音'}</span>{s.audio_id && <IconButton icon={X} label="恢复默认配音" onClick={() => update({ audio_id: '' })}/>}</div><button className="button secondary full" onClick={() => fileRef.current.click()} disabled={uploading || !!busy}>{uploading ? <LoaderCircle className="spin" size={15}/> : <Upload size={15}/>}导入本句配音</button><input ref={fileRef} hidden type="file" accept="audio/*" onChange={e => importAudio(e.target.files[0])}/></div>
      </div>}
  </section>;
}

function AssetDialog({ asset, mode, status, onClose, onChanged }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState({ name: asset.name, role: asset.role, emotion: asset.emotion });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const deleting = mode === 'delete';
  const roles = status.roles[asset.role] ? status.roles : { ...status.roles, [asset.role]: asset.role_name || '其他角色' };
  useEffect(() => { dialog.current.showModal(); }, []);
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await api(`/api/assets/${asset.id}`, deleting ? { method: 'DELETE' } : {
        method: 'PUT', body: JSON.stringify({ ...draft, role_name: roles[draft.role] }),
      });
      onChanged(result); onClose();
    } catch (e) { setError(e.message); } finally { setPending(false); }
  }
  return <dialog className="asset-dialog" ref={dialog} aria-labelledby="asset-dialog-title" onCancel={e => { e.preventDefault(); if (!pending) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !pending) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><h2 id="asset-dialog-title">{deleting ? '删除素材' : '编辑素材'}</h2><IconButton type="button" icon={X} label="关闭素材窗口" disabled={pending} onClick={onClose}/></div>
      <div className="dialog-asset"><img src={asset.url} alt={asset.name}/><strong>{asset.name}</strong></div>
      {deleting ? <p className="dialog-note">确定将这张图片移出素材库？所有剧集中的手选关联将解除，自动匹配可能出现缺图。已导出的视频不受影响。</p> : <>
        <Field label="素材名称"><input aria-label="素材名称" value={draft.name} maxLength={100} required disabled={pending} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}/></Field>
        {asset.kind === 'character' && <div className="field-pair"><Field label="所属角色"><select aria-label="编辑所属角色" value={draft.role} disabled={pending} onChange={e => setDraft(d => ({ ...d, role: e.target.value }))}><Options values={roles}/></select></Field><Field label="表情标签"><select aria-label="编辑表情标签" value={draft.emotion} disabled={pending} onChange={e => setDraft(d => ({ ...d, emotion: e.target.value }))}><Options values={status.emotions}/></select></Field></div>}
        <p className="dialog-note">修改会应用于整个素材库。更换所属角色后，不再匹配的分镜手选关联将解除。</p>
      </>}
      {error && <p className="error-text dialog-note" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose} disabled={pending}>取消</button><button type="submit" className={`button ${deleting ? 'danger' : 'primary'}`} disabled={pending || (!deleting && !draft.name.trim())}>{pending ? <LoaderCircle size={15} className="spin"/> : deleting ? <Trash2 size={15}/> : <Check size={15}/>} {deleting ? '确认删除' : '保存修改'}</button></div>
    </form>
  </dialog>;
}

function DeleteRoleAssetsDialog({ roleName, assets, onClose, onChanged }) {
  const dialog = useRef(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current.showModal(); }, []);
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      for (const asset of assets) {
        const result = await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
        onChanged(result);
      }
      onClose();
    } catch (e) { setError(`部分图片可能已删除：${e.message}`); } finally { setPending(false); }
  }
  return <dialog className="asset-dialog" ref={dialog} aria-labelledby="delete-role-title" onCancel={e => { e.preventDefault(); if (!pending) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !pending) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><h2 id="delete-role-title">删除角色图片</h2><IconButton type="button" icon={X} label="关闭素材窗口" disabled={pending} onClick={onClose}/></div>
      <p className="dialog-note">确定将“{roleName}”的 {assets.length} 张图片移出素材库？所有剧集中的手选关联将解除，自动匹配可能出现缺图。角色设置、原始文件和已导出的视频不受影响。</p>
      {error && <p className="error-text dialog-note" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose} disabled={pending}>取消</button><button type="submit" className="button danger" disabled={pending || !assets.length}>{pending ? <LoaderCircle size={15} className="spin"/> : <Trash2 size={15}/>} 确认删除</button></div>
    </form>
  </dialog>;
}

function DeleteRoleDialog({ role, roleName, project, assets, onClose, onDelete }) {
  const dialog = useRef(null);
  const [replacement, setReplacement] = useState('');
  const [assetAction, setAssetAction] = useState('reassign');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const others = Object.fromEntries(Object.entries(project.roles).filter(([key]) => key !== role));
  const used = project.segments.filter(s => s.speaker === role || s.display === role).length;
  const lastRole = !!project.roles[role] && !Object.keys(others).length;
  const needsReplacement = used > 0 || assets.length > 0 && assetAction === 'reassign';
  useEffect(() => { dialog.current.showModal(); }, []);
  async function submit(event) {
    event.preventDefault();
    if (pending || lastRole || needsReplacement && !replacement) return;
    setPending(true); setError('');
    try { await onDelete(role, replacement, assetAction); onClose(); }
    catch (e) { setError(e.message); } finally { setPending(false); }
  }
  return <dialog className="asset-dialog" ref={dialog} aria-labelledby="remove-role-title" onCancel={e => { e.preventDefault(); if (!pending) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><h2 id="remove-role-title">删除角色</h2><IconButton type="button" icon={X} label="关闭角色窗口" disabled={pending} onClick={onClose}/></div>
      <p className="dialog-note">删除“{roleName}”？当前剧集有 {used} 条分镜使用该角色，素材库有 {assets.length} 张角色图片。台词文字和原始文案不会删除。</p>
      {lastRole ? <p className="error-text dialog-note">每个剧集至少保留一个角色，请先在“声音与设置”添加接替角色。</p> : <>
        {assets.length > 0 && <Field label="角色图片"><select aria-label="角色图片处理方式" value={assetAction} disabled={pending} onChange={e => setAssetAction(e.target.value)}><option value="reassign">保留图片，转给接替角色</option><option value="delete">将图片移出素材库</option></select></Field>}
        {needsReplacement && <Field label="接替角色"><select aria-label="接替角色" value={replacement} disabled={pending} required onChange={e => setReplacement(e.target.value)}><option value="">请选择其他角色</option><Options values={others}/></select></Field>}
        {used > 0 && <p className="dialog-note">相关分镜的说话人和出镜人物将改为接替角色；更换说话人后解除旧的逐句配音关联。</p>}
        {assets.length > 0 && <p className="dialog-note">图片由所有剧集共享。{assetAction === 'delete' ? '移出后，其他剧集也无法再匹配这些图片。原始文件保留在本地。' : '转移后，其他剧集使用原角色的分镜可能缺图，需要重新选择。'}其他剧集的角色设置和已导出视频不变。</p>}
      </>}
      {error && <p className="error-text dialog-note" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button><button type="submit" className="button danger" disabled={pending || lastRole || needsReplacement && !replacement}>{pending ? <LoaderCircle size={15} className="spin"/> : <Trash2 size={15}/>}确认删除角色</button></div>
    </form>
  </dialog>;
}

export function AssetLibrary({ assets, status, refreshAssets, onError, onAssetChanged, onDeleteRole, project, locked }) {
  const [kind, setKind] = useState('character');
  const [role, setRole] = useState(Object.keys(status.roles)[0]);
  const [emotion, setEmotion] = useState('neutral');
  const [filter, setFilter] = useState('all');
  const [uploading, setUploading] = useState(false);
  const [modal, setModal] = useState(null);
  const input = useRef(null);
  useEffect(() => { if (!status.roles[role]) setRole(Object.keys(status.roles)[0]); }, [status.roles, role]);
  const libraryRoles = { ...status.roles };
  for (const asset of assets) if (asset.kind === 'character' && !libraryRoles[asset.role]) libraryRoles[asset.role] = asset.role_name || '其他角色';
  const visible = assets.filter(a => a.kind !== 'audio' && (filter === 'all' || a.kind === filter || a.role === filter && a.kind === 'character'));
  const selectedRoleAssets = assets.filter(a => a.kind === 'character' && a.role === filter);
  async function removeRole(roleId, replacement, assetAction) {
    await onDeleteRole(roleId, replacement, assetAction);
    setFilter('all');
  }
  async function upload(files) {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const form = new FormData(); form.append('file', file); form.append('kind', kind); form.append('role', role); form.append('role_name', status.roles[role]); form.append('emotion', emotion);
        await api('/api/assets', { method: 'POST', body: form });
      }
    } catch (e) { onError(e.message); } finally { await refreshAssets(); setUploading(false); input.current.value = ''; }
  }
  return <div className="library-page"><div className="page-heading"><div><h2>素材库</h2><span className="muted">{assets.filter(a => a.kind !== 'audio').length} 张图片</span></div></div>
    <div className="import-bar"><Field label="素材类型"><select aria-label="素材类型" value={kind} onChange={e => setKind(e.target.value)}><option value="character">角色表情</option><option value="scene">场景插图</option></select></Field>
      {kind === 'character' && <><Field label="所属角色"><select aria-label="所属角色" value={role} onChange={e => setRole(e.target.value)}><Options values={status.roles}/></select></Field><Field label="表情标签"><select aria-label="表情标签" value={emotion} onChange={e => setEmotion(e.target.value)}><Options values={status.emotions}/></select></Field></>}
      <button className="button primary" onClick={() => input.current.click()} disabled={uploading}>{uploading ? <LoaderCircle className="spin" size={17}/> : <Upload size={17}/>}导入图片</button>
      <input ref={input} data-testid="asset-upload" type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={e => upload([...e.target.files])}/>
    </div>
    <div className="filter-bar">{[['all', '全部'], ...Object.entries(libraryRoles), ['scene', '场景']].map(([key, label]) => <button key={key} className={filter === key ? 'filter active' : 'filter'} onClick={() => setFilter(key)}>{label}</button>)}</div>
    {filter !== 'all' && filter !== 'scene' && libraryRoles[filter] && <div className="role-library-actions"><strong>{libraryRoles[filter]}</strong><span className="muted">{selectedRoleAssets.length} 张图片</span><div><button className="button secondary" disabled={locked || uploading} onClick={() => setModal({ mode: 'remove-role', role: filter })}><Trash2 size={15}/>删除角色</button>{selectedRoleAssets.length > 0 && <button className="button secondary" disabled={locked || uploading} onClick={() => setModal({ mode: 'delete-role' })}><Trash2 size={15}/>删除该角色全部图片</button>}</div></div>}
    {visible.length ? <div className="asset-grid">{visible.map(a => <article className="asset-card" key={a.id}><div className="asset-image"><img src={a.url} alt={a.name} loading="lazy"/></div><div className="asset-info"><strong title={a.name}>{a.name}</strong><span>{a.kind === 'scene' ? '场景插图' : `${status.roles[a.role] || a.role_name || '其他角色'} · ${status.emotions[a.emotion]}`}</span><div className="asset-actions"><IconButton icon={Pencil} label={`编辑${a.name}`} disabled={locked || uploading} onClick={() => setModal({ asset: a, mode: 'edit' })}/><IconButton icon={Trash2} label={`删除${a.name}`} disabled={locked || uploading} onClick={() => setModal({ asset: a, mode: 'delete' })}/></div></div></article>)}</div> : <Empty icon={ImagePlus} title="尚未导入图片"/>}
    {modal?.mode === 'remove-role' ? <DeleteRoleDialog key={modal.role} role={modal.role} roleName={libraryRoles[modal.role]} project={project} assets={assets.filter(a => a.kind === 'character' && a.role === modal.role)} onDelete={removeRole} onClose={() => setModal(null)}/> : modal?.mode === 'delete-role' ? <DeleteRoleAssetsDialog roleName={libraryRoles[filter]} assets={selectedRoleAssets} onClose={() => setModal(null)} onChanged={onAssetChanged}/> : modal && <AssetDialog key={`${modal.mode}-${modal.asset.id}`} {...modal} status={status} onClose={() => setModal(null)} onChanged={onAssetChanged}/>}
  </div>;
}

export function Settings({ project, setProject, status, settings, setSettings, assets }) {
  const [newName, setNewName] = useState('');
  const [roleError, setRoleError] = useState('');
  function addRole() {
    const name = newName.trim();
    if (!name || /[:：]/.test(name) || Object.values(project.roles).includes(name) || Object.keys(project.roles).length >= 30) {
      setRoleError('请填写不重复的角色名称，最多30个角色，名称不能包含冒号。'); return;
    }
    const existing = assets.find(a => a.kind === 'character' && a.role_name === name && !project.roles[a.role]);
    const role = existing?.role || uid();
    setProject(p => ({ ...p, roles: { ...p.roles, [role]: name }, voices: { ...p.voices, [role]: { name: status.voices[0].name, rate: 0 } } }));
    setNewName(''); setRoleError('');
  }
  function removeRole(role) {
    setProject(p => { const roles = { ...p.roles }; const voices = { ...p.voices }; delete roles[role]; delete voices[role]; return { ...p, roles, voices }; });
  }
  return <div className="settings-page"><div className="page-heading"><h2>声音与设置</h2></div>
    <section className="settings-section"><h3>角色与音色</h3><div className="engine-status"><strong>ByteDance · MegaTTS3</strong><span className={status.tts?.ready ? 'green-text' : 'error-text'}>{status.tts?.message}{status.tts?.device === 'cuda' ? ' · GPU' : ''}</span></div>
      {Object.entries(status.roles).map(([role, label]) => <div className="voice-row" key={role}>
        <Field label="角色名称"><input aria-label={`${label}名称`} value={label} maxLength={24} onChange={e => setProject(p => ({ ...p, roles: { ...p.roles, [role]: e.target.value } }))}/></Field>
        <Field label="MegaTTS3 音色"><select aria-label={`${label}声音`} value={project.voices[role].name} onChange={e => setProject(p => ({ ...p, voices: { ...p.voices, [role]: { ...p.voices[role], name: e.target.value } } }))}>{status.voices.map(v => <option key={v.name} value={v.name}>{v.label || v.name}</option>)}</select></Field>
        <Field label={`语速 ${project.voices[role].rate > 0 ? '+' : ''}${project.voices[role].rate}`}><input aria-label={`${label}语速`} type="range" min="-5" max="5" value={project.voices[role].rate} onChange={e => setProject(p => ({ ...p, voices: { ...p.voices, [role]: { ...p.voices[role], rate: Number(e.target.value) } } }))}/></Field>
        <IconButton icon={Trash2} label={`删除${label}`} disabled={Object.keys(project.roles).length === 1 || project.segments.some(s => s.speaker === role || s.display === role)} onClick={() => removeRole(role)}/>
      </div>)}
      <div className="add-role"><input aria-label="新角色名称" value={newName} maxLength={24} placeholder="新角色名称" onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addRole(); }}/><IconButton icon={Plus} label="添加角色" onClick={addRole}/></div>
      {roleError && <p className="error-text">{roleError}</p>}
      {status.voice_error && <p className="error-text">{status.voice_error}</p>}
    </section>
    <section className="settings-section"><h3>字幕</h3><Field label="强调色"><div className="color-field"><input type="color" aria-label="字幕强调色" value={project.caption_color} onChange={e => setProject(p => ({ ...p, caption_color: e.target.value }))}/><span>{project.caption_color}</span></div></Field></section>
    <section className="settings-section"><h3>文案分析</h3><Field label="分析方式"><select aria-label="分析方式" value={settings.mode} onChange={e => setSettings(s => ({ ...s, mode: e.target.value }))}><option value="local">本地规则拆句</option><option value="deepseek">DeepSeek · 语境分析</option></select></Field>
      {settings.mode === 'deepseek' && <div className="provider-settings"><Field label="模型名称"><input aria-label="模型名称" value={settings.model} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}/></Field><Field label="API 密钥 · 仅本次窗口有效"><input type="password" autoComplete="off" aria-label="API 密钥" value={settings.key} onChange={e => setSettings(s => ({ ...s, key: e.target.value }))}/></Field><div className="provider-note">文案分析将发送台词到 DeepSeek。密钥不保存在项目中。</div></div>}
    </section>
    <section className="settings-section"><h3>运行环境</h3><div className="environment-row"><span className={status.ffmpeg ? 'status-dot' : 'status-dot bad'}/><span>视频合成</span><strong>{status.ffmpeg ? '就绪' : '未找到合成程序'}</strong></div><div className="environment-row"><span className={status.tts?.ready ? 'status-dot' : 'status-dot bad'}/><span>MegaTTS3</span><strong>{status.tts?.ready ? `${status.voices.length} 个可用音色` : '未就绪'}</strong></div></section>
  </div>;
}

export function Exports({ jobs }) {
  const completed = jobs.filter(j => j.state === 'done');
  return <div className="exports-page"><div className="page-heading"><h2>导出记录</h2><span className="muted">{completed.length} 个成片</span></div>
    {!jobs.length ? <Empty icon={Play} title="还没有导出记录"/> : <div className="export-list">{jobs.map(job => <article className="export-row" key={job.id}>
      {job.state === 'done' ? <video controls preload="metadata" src={job.result.video} poster={job.result.cover}/> : <div className="export-pending"><FileText size={32}/></div>}
      <div className="export-info"><h3>{job.name}</h3><p>{new Date(job.created_at * 1000).toLocaleString('zh-CN')} · {job.quality === 'full' ? '1080 × 1920' : '540 × 960'}</p><p className={job.state === 'failed' ? 'error-text' : ''}>{job.message}</p>
      {job.result && <><p>{job.result.duration.toFixed(1)} 秒</p><div className="download-links"><a className="button" href={job.result.video} download={`${job.name}.mp4`}><Download size={15}/>视频</a><a className="button secondary" href={job.result.subtitles} download={`${job.name}.srt`}><Download size={15}/>字幕</a><a className="button secondary" href={job.result.timeline} download={`${job.name}-时间轴.json`}><Download size={15}/>时间轴</a></div></>}
      </div></article>)}</div>}
  </div>;
}
