import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Budget, DraftPlan, PlanInput, PlanMember, PlanTask, Snapshot } from '../types.ts'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { Request } from './monitor.ts'
import { useCopy } from './locale.tsx'
import { selectedOperation } from './selection.ts'

const lines = (value: string) => value.split('\n')
const cleanLines = (value: string[]) => value.map(item => item.trim()).filter(Boolean)
export function cleanPlan(input: PlanInput): PlanInput {
  return { ...input, scope: cleanLines(input.scope), acceptance: cleanLines(input.acceptance), tasks: input.tasks.map(task => ({ ...task, scope: cleanLines(task.scope), acceptance: cleanLines(task.acceptance), checks: task.checks ? cleanLines(task.checks) : undefined })) }
}
const freshKey = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
/** Read-only subset of the native model directory's advertised route metadata. */
interface CatalogGroup { id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string } }> }
export function newPlan(workspace: string, budget: Budget): PlanInput {
  const acceptance = ['The delivered change satisfies the objective and passes independent verification.']
  return {
    workspace, title: '', objective: '', scope: ['**'], acceptance: [...acceptance], budget: { ...budget },
    members: [{ key: 'builder', name: 'Builder', role: 'Implement and integrate the mission deliverable.' }, { key: 'reviewer', name: 'Reviewer', role: 'Independently check the immutable artifact against acceptance criteria.' }],
    workstreams: [{ key: 'delivery', title: 'Delivery', objective: 'Deliver and independently verify the mission objective.' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'delivery', title: 'Deliver the mission', objective: 'Implement the mission objective, run relevant checks, publish evidence, and submit an immutable artifact.', kind: 'integration', scope: ['**'], acceptance: [...acceptance], checks: ['npm test'], assigneeKey: 'builder', dependencies: [] },
      { key: 'review', workstreamKey: 'delivery', title: 'Independent verification', objective: 'Check the delivered immutable artifact against the mission acceptance criteria and report evidence.', kind: 'verification', scope: ['**'], acceptance: [...acceptance], assigneeKey: 'reviewer', dependencies: [], reviewOf: 'deliver' },
    ],
  }
}

function ModelPicker({ member, directory, onChange }: { member: PlanMember; directory: ModelDirectory; onChange: (patch: Partial<PlanMember>) => void }) {
  const t = useCopy()
  const state = useSyncExternalStore(directory.store.subscribe, directory.store.getSnapshot, directory.store.getSnapshot)
  const groups = state.groups as readonly CatalogGroup[]
  const routes = groups.flatMap(group => group.models.map(model => ({ provider: group.id, providerName: group.name, model })))
  const chosen = routes.find(route => route.provider === (member.provider ?? state.current?.provider) && route.model.id === member.model)
  const key = member.model ? JSON.stringify([member.provider ?? null, member.model]) : ''
  const known = key === '' || (member.provider !== undefined && chosen !== undefined)
  return <div className="sw-fields"><label>{t('Model')}<select data-testid={`worker-model-${member.key}`} value={key} onChange={event => {
    if (event.currentTarget.value === key) return
    const route = routes.find(item => JSON.stringify([item.provider, item.model.id]) === event.currentTarget.value)
    onChange({ provider: route?.provider, model: route?.model.id, reasoningEffort: undefined })
  }}><option value="">{t('Use owner model')}</option>
    {!known && <option value={key}>{member.provider ?? t('Owner provider')} / {member.model}</option>}
    {groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>)}</optgroup>)}
  </select></label><label>{t('Reasoning')}<select aria-label={`${member.name} ${t('Reasoning')}`} value={member.reasoningEffort ?? ''} disabled={!chosen?.model.reasoning} onChange={event => onChange({ reasoningEffort: event.currentTarget.value || undefined })}>
    <option value="">{t('Provider default')}</option>
    {member.reasoningEffort && !chosen?.model.reasoning?.efforts.some(effort => effort.id === member.reasoningEffort) && <option>{member.reasoningEffort}</option>}
    {chosen?.model.reasoning?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
  </select></label></div>
}

export function DraftEditor({ sessionId, workspace, budget, draft, directory, request, onSaved, onLaunched, onDiscarded, ownerLive = true, isSelected = () => true }: {
  sessionId: string; workspace: string; budget: Budget; draft?: DraftPlan; directory?: ModelDirectory; request: Request;
  onSaved: (draft: DraftPlan) => void; onLaunched: (snapshot: Snapshot) => void; onDiscarded: () => void;
  ownerLive?: boolean;
  isSelected?: () => boolean;
}) {
  const t = useCopy()
  const [input, setInput] = useState<PlanInput>(() => draft?.input ?? newPlan(workspace, budget))
  const [saved, setSaved] = useState(draft)
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft?.input))
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [discard, setDiscard] = useState(false)
  const [modelError, setModelError] = useState('')
  const dirty = JSON.stringify(input) !== baseline
  const editable = !saved || saved.status === 'draft'
  const loadModels = () => { setModelError(''); void directory?.load().catch((failure: unknown) => setModelError(String(failure))) }
  useEffect(() => { loadModels() }, [directory])
  useEffect(() => {
    if (draft && (draft.revision !== saved?.revision || draft.status !== saved?.status) && !dirty) {
      setSaved(draft); setInput(draft.input); setBaseline(JSON.stringify(draft.input))
    }
  }, [draft?.revision, draft?.status])
  const update = (patch: Partial<PlanInput>) => setInput(current => ({ ...current, ...patch }))
  const updateMember = (key: string, patch: Partial<PlanMember>) => update({ members: input.members.map(member => member.key === key ? { ...member, ...patch } : member) })
  const updateTask = (key: string, patch: Partial<PlanTask>) => update({ tasks: input.tasks.map(task => task.key === key ? { ...task, ...patch } : task) })
  const perform = async (action: 'save' | 'launch' | 'discard') => {
    setBusy(action); setError('')
    await selectedOperation<{ draft?: DraftPlan; snapshot?: Snapshot }>(isSelected, async () => {
      if (action === 'save') {
        return await request<{ draft: DraftPlan }>(saved ? 'update-draft' : 'create-draft', { sessionId, ...(saved ? { draftId: saved.id, revision: saved.revision } : {}), input: cleanPlan(input) })
      } else if (saved) {
        if (action === 'launch') {
          return await request<{ snapshot: Snapshot }>('launch-draft', { sessionId, draftId: saved.id, revision: saved.revision })
        } else await request('discard-draft', { sessionId, draftId: saved.id, revision: saved.revision })
      }
      return {}
    }, {
      success: value => {
        if (action === 'save' && value.draft) {
          setSaved(value.draft); setInput(value.draft.input); setBaseline(JSON.stringify(value.draft.input)); onSaved(value.draft)
        } else if (action === 'launch' && value.snapshot) onLaunched(value.snapshot)
        else if (action === 'discard') onDiscarded()
      },
      failure: failure => setError(failure instanceof Error ? failure.message : String(failure)),
      settled: () => setBusy(''),
    })
  }
  return <form data-swarm-draft="" className="sw-editor" onSubmit={event => { event.preventDefault(); void perform('save') }}>
    <div className="sw-row"><h2>{t('New mission')}</h2><span className="sw-chip">{t(dirty ? 'Unsaved changes' : 'Saved')}{saved ? ` · r${saved.revision}` : ''}</span></div>
    {error && <div className="sw-error" role="alert">{error}</div>}
    {saved?.error && <div className="sw-error">{saved.error}</div>}
    {draft && saved && draft.revision !== saved.revision && dirty && <div className="sw-notice">This draft changed elsewhere. Save will check its revision; reopen it to load the latest version.</div>}
    <fieldset disabled={Boolean(busy) || !editable}>
      <label>{t('Title')}<input data-testid="draft-title" value={input.title} required onChange={event => update({ title: event.currentTarget.value })} /></label>
      <label>{t('Objective')}<textarea data-testid="draft-objective" value={input.objective} required rows={3} onChange={event => update({ objective: event.currentTarget.value })} /></label>
      <label>{t('Workspace')}<input data-testid="draft-workspace" value={workspace} readOnly /></label>
      <p className="sw-small">{t('Choose a conversation in the repository you want to work on.')}</p>
      <div className="sw-fields"><label>{t('Scope')}<textarea aria-label={t('Scope')} value={input.scope.join('\n')} required placeholder="src/\ntests/" onChange={event => update({ scope: lines(event.currentTarget.value) })} /></label>
        <label>{t('Acceptance')}<textarea aria-label={t('Acceptance')} value={input.acceptance.join('\n')} required onChange={event => update({ acceptance: lines(event.currentTarget.value) })} /></label></div>
      <p className="sw-small">{t('One item per line')} · {t('Scope uses exact files, directory prefixes ending in /, or ** for the workspace.')}</p>
      <details open><summary>{t('Budget')}</summary><div className="sw-budget-fields">{([
        ['maxTokens', 'Tokens'], ['maxSteps', 'Steps'], ['maxWorkers', 'Workers'], ['maxDurationMs', 'Minutes'], ['maxTasks', 'Task limit'], ['maxExperiments', 'Experiment limit'],
      ] as const).map(([key, label]) => <label key={key}>{t(label)}<input type="number" min={1} step={1} required value={key === 'maxDurationMs' ? input.budget[key] / 60_000 : input.budget[key]} onChange={event => update({ budget: { ...input.budget, [key]: Number(event.currentTarget.value) * (key === 'maxDurationMs' ? 60_000 : 1) } })} /></label>)}</div></details>
      <section className="sw-section"><div className="sw-row"><h3>{t('Roster')}</h3><button type="button" onClick={() => update({ members: [...input.members, { key: freshKey('worker'), name: `Worker ${input.members.length + 1}`, role: '' }] })}>{t('Add worker')}</button></div>
        {directory && <button className="sw-link" type="button" onClick={loadModels}>{t('Reload models')}</button>}
        {modelError && <p role="status" className="sw-error">{modelError}</p>}
        {input.members.map(member => <div className="sw-edit-item" key={member.key}><div className="sw-row"><strong>{member.name || member.key}</strong><button type="button" onClick={() => update({ members: input.members.filter(item => item.key !== member.key), tasks: input.tasks.map(task => task.assigneeKey === member.key ? { ...task, assigneeKey: undefined } : task) })}>{t('Remove')}</button></div>
          <div className="sw-fields"><label>{t('Name')}<input value={member.name} required onChange={event => updateMember(member.key, { name: event.currentTarget.value })} /></label><label>{t('Role')}<input value={member.role} required onChange={event => updateMember(member.key, { role: event.currentTarget.value })} /></label></div>
          {directory ? <ModelPicker member={member} directory={directory} onChange={patch => updateMember(member.key, patch)} /> : <p className="sw-small">{t('Use owner model')}</p>}
        </div>)}
      </section>
      <section className="sw-section"><div className="sw-row"><h3>{t('Workstreams')}</h3><button type="button" onClick={() => update({ workstreams: [...input.workstreams, { key: freshKey('stream'), title: '', objective: '' }] })}>{t('Add workstream')}</button></div>
        {input.workstreams.map(stream => <div className="sw-edit-item" key={stream.key}><div className="sw-row"><code>{stream.key}</code><button type="button" disabled={input.tasks.some(task => task.workstreamKey === stream.key)} onClick={() => update({ workstreams: input.workstreams.filter(item => item.key !== stream.key) })}>{t('Remove')}</button></div><div className="sw-fields">
          <label>{t('Title')}<input value={stream.title} required onChange={event => update({ workstreams: input.workstreams.map(item => item.key === stream.key ? { ...item, title: event.currentTarget.value } : item) })} /></label>
          <label>{t('Objective')}<input value={stream.objective} required onChange={event => update({ workstreams: input.workstreams.map(item => item.key === stream.key ? { ...item, objective: event.currentTarget.value } : item) })} /></label>
        </div></div>)}
      </section>
      <section className="sw-section"><div className="sw-row"><h3>{t('Tasks')}</h3><button type="button" onClick={() => update({ tasks: [...input.tasks, { key: freshKey('task'), workstreamKey: input.workstreams[0]?.key ?? '', title: '', objective: '', kind: 'research', scope: [...input.scope], acceptance: [...input.acceptance], dependencies: [] }] })}>{t('Add task')}</button></div>
        {input.tasks.map(task => <details className="sw-edit-item" key={task.key} open><summary>{task.title || task.key} · {task.kind}</summary>
          <div className="sw-row"><code>{task.key}</code><button type="button" onClick={() => update({ tasks: input.tasks.filter(item => item.key !== task.key).map(item => ({ ...item, dependencies: item.dependencies?.filter(key => key !== task.key), ...(item.reviewOf === task.key ? { reviewOf: undefined } : {}) })) })}>{t('Remove')}</button></div>
          <label>{t('Title')}<input value={task.title} required onChange={event => updateTask(task.key, { title: event.currentTarget.value })} /></label>
          <label>{t('Objective')}<textarea value={task.objective} required onChange={event => updateTask(task.key, { objective: event.currentTarget.value })} /></label>
          <div className="sw-fields"><label>{t('Kind')}<select value={task.kind} onChange={event => updateTask(task.key, { kind: event.currentTarget.value as PlanTask['kind'], reviewOf: undefined })}>{['research', 'implementation', 'integration', 'verification'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
            <label>{t('Assignee')}<select value={task.assigneeKey ?? ''} onChange={event => updateTask(task.key, { assigneeKey: event.currentTarget.value || undefined })}><option value="">{t('Unassigned')}</option>{input.members.map(member => <option key={member.key} value={member.key}>{member.name}</option>)}</select></label>
            <label>{t('Workstreams')}<select value={task.workstreamKey} required onChange={event => updateTask(task.key, { workstreamKey: event.currentTarget.value })}>{input.workstreams.map(stream => <option key={stream.key} value={stream.key}>{stream.title}</option>)}</select></label>
            <label>{t('Priority')}<input type="number" min={0} max={100} step={1} value={task.priority ?? 50} onChange={event => updateTask(task.key, { priority: Number(event.currentTarget.value) })} /></label>
            {task.kind === 'verification' && <label>{t('Review source')}<select value={task.reviewOf ?? ''} required onChange={event => updateTask(task.key, { reviewOf: event.currentTarget.value || undefined, dependencies: task.dependencies?.filter(key => key !== event.currentTarget.value) })}><option value="">{t('None')}</option>{input.tasks.filter(item => item.key !== task.key && item.kind !== 'verification').map(item => <option key={item.key} value={item.key}>{item.title}</option>)}</select></label>}
          </div>
          <div className="sw-prereqs"><label><input type="checkbox" checked={task.experiment ?? false} onChange={event => updateTask(task.key, { experiment: event.currentTarget.checked })} />{t('Optional experiment')}</label></div>
          <div className="sw-prereqs"><span>{t('Prerequisites')}</span>{input.tasks.filter(item => item.key !== task.key && item.key !== task.reviewOf).map(item => <label key={item.key}><input type="checkbox" checked={task.dependencies?.includes(item.key) ?? false} onChange={event => updateTask(task.key, { dependencies: event.currentTarget.checked ? [...(task.dependencies ?? []), item.key] : task.dependencies?.filter(key => key !== item.key) })} />{item.title}</label>)}</div>
          <div className="sw-fields"><label>{t('Scope')}<textarea value={task.scope.join('\n')} required onChange={event => updateTask(task.key, { scope: lines(event.currentTarget.value) })} /></label><label>{t('Acceptance')}<textarea value={task.acceptance.join('\n')} required onChange={event => updateTask(task.key, { acceptance: lines(event.currentTarget.value) })} /></label></div>
          <label>{t('Checks')}<textarea value={task.kind === 'verification' ? input.tasks.find(item => item.key === task.reviewOf)?.checks?.join('\n') ?? '' : task.checks?.join('\n') ?? ''} readOnly={task.kind === 'verification'} required={['implementation', 'integration'].includes(task.kind)} placeholder={t('One command per line')} onChange={event => updateTask(task.key, { checks: lines(event.currentTarget.value) })} /></label>
          {task.kind === 'verification' ? <p className="sw-small">{t('Verification runs the selected source task’s checks on its immutable artifact.')}</p> : ['implementation', 'integration'].includes(task.kind) && <p className="sw-small">{t('Replace the default check with commands that prove your acceptance criteria.')}</p>}
        </details>)}
      </section>
    </fieldset>
    <div className="sw-editor-actions"><p className="sw-small">{t('Launch starts workers after the complete saved plan is validated.')}</p><div className="sw-row">
      <button type="submit" data-action="save-draft" disabled={Boolean(busy) || !dirty || !editable}>{t(busy === 'save' ? 'Saving' : 'Save draft')}</button>
      <button type="button" className="sw-primary" data-action="launch-draft" disabled={Boolean(busy) || dirty || !saved || !['draft', 'failed'].includes(saved.status) || !ownerLive} onClick={() => { void perform('launch') }}>{t(busy === 'launch' ? 'Working' : saved?.status === 'failed' ? 'Retry launch' : 'Launch mission')}</button>
      <button type="button" data-action="discard-draft" disabled={Boolean(busy) || Boolean(saved && !['draft', 'failed'].includes(saved.status))} onClick={() => discard ? void perform('discard') : setDiscard(true)}>{t(discard ? 'Confirm discard' : 'Discard draft')}</button>
    </div></div>
    {!ownerLive && <p className="sw-notice">{t('Send a message in the owner conversation before launching workers.')}</p>}
  </form>
}
