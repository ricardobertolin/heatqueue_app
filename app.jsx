const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ────────────────────────────────────────────────────────────────────────────
// Tweakable defaults — host rewrites between EDITMODE markers
// ────────────────────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "cream",
  "showStreak": true,
  "showScanlines": true
}/*EDITMODE-END*/;

const DEFAULT_TASK_DURATION_MS = 60 * 60 * 1000; // 1 hour fallback
const MS = { day: 86400_000, hour: 3600_000, minute: 60_000 };

const THEMES = {
  cream:    { chassis:'#DBD3BF', edge:'#B9AE93', screen:'#F4EFE0', ink:'#2A2620', accent:'#DA5757' },
  graphite: { chassis:'#3C3A35', edge:'#23211D', screen:'#1F1D19', ink:'#EFEAD8', accent:'#F9C66B' },
  sherbet:  { chassis:'#F4C6C0', edge:'#D89890', screen:'#FFF4EE', ink:'#3B2724', accent:'#5BAE73' },
};

const ACTIVITY_COLORS = ['#DA5757', '#F0A33A', '#5BAE73', '#4A6FA5', '#B47BD6', '#E07AB5'];

const INITIAL_ACTIVITIES = [
  { id: 1, name: 'DAILY DRILLS', color: '#DA5757', tasks: [
    { id: 't1', name: 'Mandarin',  streak: 7,  durationMs: 30_000 },
    { id: 't2', name: 'Research',  streak: 4,  durationMs: 20_000 },
    { id: 't3', name: 'UWB',       streak: 12, durationMs: 15_000 },
    { id: 't4', name: 'Horse',     streak: 2,  durationMs: 10_000 },
  ]},
  { id: 2, name: 'HOUSE LOOP',   color: '#F0A33A', tasks: [
    { id: 't5', name: 'Dishes',    streak: 1, durationMs: 15_000 },
    { id: 't6', name: 'Laundry',   streak: 3, durationMs: 25_000 },
    { id: 't7', name: 'Plants',    streak: 9, durationMs: 18_000 },
  ]},
  { id: 3, name: 'STUDIO',       color: '#5BAE73', tasks: [
    { id: 't8', name: 'Sketchbk',  streak: 0, durationMs: 25_000 },
    { id: 't9', name: 'Synth',     streak: 5, durationMs: 18_000 },
    { id:'t9b', name: 'Journal',   streak: 2, durationMs: 12_000 },
  ]},
  { id: 4, name: 'INBOX',        color: '#4A6FA5', tasks: [
    { id:'t10', name: 'Triage',    streak: 0, durationMs: 20_000 },
  ]},
];

// Layout constants — coordinates inside the right screen
const TASK_W    = 110;
const TASK_GAP  = 36;
const STEP      = TASK_W + TASK_GAP;  // horizontal stride between task slots
const OVEN_PAD  = 56;                 // distance from screen right edge to oven center
const FINISH_MS = 420;                // duration of the "finishing" cycle animation

// Color helper — boxes in the rightmost (hot) task heat from the bottom up
function heatColorForBox(boxFromTop, heat) {
  // boxFromTop: 0=top (heats last → yellow), 1=mid (orange), 2=bot (heats first → red)
  const palette = ['#F9C66B', '#F08A4C', '#DA5757'];
  const target = palette[boxFromTop];
  // priority: bottom heats first
  const threshold = 2 - boxFromTop; // bot=0, mid=1, top=2
  const i = Math.max(0, Math.min(1, heat * 3 - threshold));
  if (i <= 0) return null;
  return `color-mix(in oklab, var(--box) ${(1 - i) * 100}%, ${target})`;
}

// ────────────────────────────────────────────────────────────────────────────
// Stage — scale-to-fit letterbox
// ────────────────────────────────────────────────────────────────────────────
function Stage({ width, height, children }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    function update() {
      const pad = 32;
      const s = Math.min(
        (window.innerWidth  - pad) / width,
        (window.innerHeight - pad) / height,
        1.4
      );
      setScale(s);
    }
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [width, height]);
  return (
    <div style={{ width, height, transform:`scale(${scale})`, transformOrigin:'center center' }}>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Conveyor screen (right panel)
// ────────────────────────────────────────────────────────────────────────────
function ConveyorScreen({ activity, heat, finishingId, onFinish, onAddTask, onDeleteTask, onReorderTasks, showStreak }) {
  if (!activity) return null;
  const tasks = activity.tasks;
  const lastIdx = tasks.length - 1;
  const hot = tasks[lastIdx];
  const fullyHot = heat > 0.97 && !finishingId;

  // ── Pan (drag empty belt to scroll horizontally) ───────────────────────────
  const [panX, setPanX] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const beltRef = useRef(null);
  const panState = useRef(null);
  const maxPan = Math.max(0, lastIdx * STEP);

  useEffect(() => { setPanX(0); }, [activity.id]);
  useEffect(() => { setPanX(p => Math.max(0, Math.min(maxPan, p))); }, [maxPan]);

  useEffect(() => {
    function onMove(e) {
      if (!panState.current) return;
      const dx = (e.clientX - panState.current.startX) / panState.current.scale;
      const next = panState.current.startPan + dx;
      setPanX(Math.max(0, Math.min(panState.current.maxPan, next)));
    }
    function onUp() {
      if (panState.current) {
        panState.current = null;
        setIsPanning(false);
        document.body.style.cursor = '';
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function onBeltMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.task')) return;       // task drag handles itself
    if (e.target.closest('button')) return;
    if (!beltRef.current) return;
    const r = beltRef.current.getBoundingClientRect();
    const scale = r.width / beltRef.current.offsetWidth || 1;
    panState.current = { startX: e.clientX, startPan: panX, scale, maxPan };
    setIsPanning(true);
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  }

  // ── Task reorder via HTML5 drag-and-drop ───────────────────────────────────
  const [dragTaskIdx, setDragTaskIdx] = useState(null);
  const [overTaskIdx, setOverTaskIdx] = useState(null);

  function onTaskDragStart(e, idx) {
    setDragTaskIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
  }
  function onTaskDragOver(e, idx) {
    if (dragTaskIdx == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overTaskIdx !== idx) setOverTaskIdx(idx);
  }
  function onTaskDrop(e, idx) {
    e.preventDefault();
    if (dragTaskIdx != null && dragTaskIdx !== idx) onReorderTasks(dragTaskIdx, idx);
    setDragTaskIdx(null);
    setOverTaskIdx(null);
  }
  function onTaskDragEnd() {
    setDragTaskIdx(null);
    setOverTaskIdx(null);
  }

  return (
    <div className="screen screen-right">
      <div className="crt-overlay" aria-hidden="true" />

      <header className="screen-hd">
        <div className="screen-tag" style={{ color: activity.color }}>
          <span className="dot" style={{ background: activity.color }} /> {activity.name}
        </div>
        <div className="screen-tools">
          <button className="tool-btn" onClick={onAddTask} title="Add task to queue">+ task</button>
        </div>
      </header>

      <div
        className={`belt-area ${isPanning ? 'is-panning':''} ${maxPan > 0 ? 'is-pannable':''}`}
        ref={beltRef}
        onMouseDown={onBeltMouseDown}
      >
        {/* dotted infinity tail on the left */}
        <div className="belt-tail" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        {/* the rail */}
        <div className="belt-rail" aria-hidden="true">
          <div className="rail-arrow" />
        </div>
        {/* heat glow under the oven */}
        <div className="oven-glow" style={{ opacity: heat * 0.9 }} aria-hidden="true" />
        {/* the oven (rollers) */}
        <div className="oven" aria-hidden="true">
          <span className="roller r-l" />
          <span className="roller r-r" />
          <div className="oven-floor" />
        </div>

        {/* tasks */}
        <div className="task-track">
          {tasks.map((task, i) => {
            const fromRight = lastIdx - i; // 0 = on the oven
            const isHot = i === lastIdx;
            const isFinishing = task.id === finishingId;
            const isDragging = dragTaskIdx === i;
            const isDragOver = overTaskIdx === i && dragTaskIdx != null && dragTaskIdx !== i;
            const tx = -fromRight * STEP + panX;
            return (
              <div
                key={task.id}
                className={`task ${isHot ? 'is-hot':''} ${isFinishing ? 'is-finishing':''} ${fullyHot && isHot ? 'is-sizzling':''} ${isDragging ? 'is-dragging':''} ${isDragOver ? 'is-drag-over':''}`}
                style={{ transform: `translateX(${tx}px) translateY(${isFinishing ? -110 : 0}px)` }}
                draggable={!isFinishing}
                onDragStart={(e) => onTaskDragStart(e, i)}
                onDragOver={(e) => onTaskDragOver(e, i)}
                onDrop={(e) => onTaskDrop(e, i)}
                onDragEnd={onTaskDragEnd}
              >
                <div className="task-label">{task.name}</div>
                <div className="task-stack">
                  {[0,1,2].map(bi => {
                    const fill = isHot && !isFinishing ? heatColorForBox(bi, heat) : null;
                    return (
                      <div className="stack-box" key={bi}
                           style={fill ? { background: fill, borderColor:'#2A2620' } : undefined} />
                    );
                  })}
                </div>
                {showStreak && task.streak > 0 && (
                  <div className="streak">×{task.streak}</div>
                )}
                <button
                  className="task-x"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onDeleteTask(task.id)}
                  title="Remove"
                >×</button>
              </div>
            );
          })}
        </div>

        {tasks.length === 0 && (
          <div className="empty-belt">
            <div className="empty-mono">QUEUE EMPTY</div>
            <button className="finish-btn" onClick={onAddTask}>+ Add a task</button>
          </div>
        )}
      </div>

      {/* Finish action */}
      <div className="finish-row">
        <div className="finish-meta">
          {hot ? (
            <>
              <span className="finish-mono">ON THE OVEN</span>
              <span className="finish-name">{hot.name}</span>
              <span className="finish-bar">
                <span className="finish-bar-fill" style={{ width: `${Math.round(heat*100)}%` }} />
              </span>
              <span className="finish-pct">{Math.round(heat*100)}°</span>
            </>
          ) : (
            <span className="finish-mono">— add a task to start the belt —</span>
          )}
        </div>
        <button
          className={`finish-btn primary ${fullyHot ? 'is-ready':''}`}
          disabled={!hot || !!finishingId}
          onClick={onFinish}
        >
          Finish task <kbd>⎵</kbd>
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Add-task modal
// ────────────────────────────────────────────────────────────────────────────
function AddTaskModal({ activityName, onCancel, onSubmit }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(1);
  const [minutes, setMinutes] = useState(0);
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const totalMs = (days * MS.day) + (hours * MS.hour) + (minutes * MS.minute);
  const canSubmit = name.trim().length > 0 && totalMs > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit(name, totalMs);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    else if (e.key === 'Enter') { e.stopPropagation(); submit(); }
  }
  function clampInt(v, min) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return min;
    return Math.max(min, n);
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="modal-hd">
          <h3>New task</h3>
          {activityName && <span className="modal-sub mono">→ {activityName}</span>}
        </div>

        <label className="modal-field">
          <span className="modal-lbl mono">Name</span>
          <input
            ref={nameRef}
            type="text"
            maxLength={16}
            value={name}
            placeholder="e.g. Stretch"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="modal-field">
          <span className="modal-lbl mono">Time to 100%</span>
          <div className="time-inputs">
            <label>
              <input type="number" min="0" value={days}
                     onChange={(e) => setDays(clampInt(e.target.value, 0))} />
              <span className="time-unit mono">days</span>
            </label>
            <label>
              <input type="number" min="0" max="23" value={hours}
                     onChange={(e) => setHours(clampInt(e.target.value, 0))} />
              <span className="time-unit mono">hrs</span>
            </label>
            <label>
              <input type="number" min="0" max="59" value={minutes}
                     onChange={(e) => setMinutes(clampInt(e.target.value, 0))} />
              <span className="time-unit mono">min</span>
            </label>
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn primary" disabled={!canSubmit} onClick={submit}>
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sidebar (left panel)
// ────────────────────────────────────────────────────────────────────────────
function ActivitySidebar({ activities, selectedId, onSelect, onAdd, onRename, onDelete, onReorderActivities, onSave, onLoad, heats }) {
  const fileInputRef = useRef(null);
  function onLoadClick() { fileInputRef.current?.click(); }
  function onFilePicked(e) {
    const f = e.target.files?.[0];
    if (f) onLoad(f);
    e.target.value = '';
  }
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  function onRowDragStart(e, i) {
    setDragIdx(i);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
  }
  function onRowDragOver(e, i) {
    if (dragIdx == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overIdx !== i) setOverIdx(i);
  }
  function onRowDrop(e, i) {
    e.preventDefault();
    if (dragIdx != null && dragIdx !== i) onReorderActivities(dragIdx, i);
    setDragIdx(null);
    setOverIdx(null);
  }
  function onRowDragEnd() {
    setDragIdx(null);
    setOverIdx(null);
  }

  return (
    <div className="screen screen-left">
      <div className="crt-overlay" aria-hidden="true" />
      <div className="sidebar-hd">
        <span className="mono">MENU</span>
        <span className="mono dim">{activities.length}/8</span>
      </div>
      <ul className="activity-list">
        {activities.map((a, i) => {
          const sel = a.id === selectedId;
          const isDragging = dragIdx === i;
          const isOver = overIdx === i && dragIdx != null && dragIdx !== i;
          return (
            <li key={a.id}
                className={`activity-row ${sel ? 'is-sel':''} ${isDragging ? 'is-dragging':''} ${isOver ? 'is-drag-over':''}`}
                style={{ '--row-tint': a.color, '--heat': heats?.[a.id] || 0 }}
                draggable
                onDragStart={(e) => onRowDragStart(e, i)}
                onDragOver={(e) => onRowDragOver(e, i)}
                onDrop={(e) => onRowDrop(e, i)}
                onDragEnd={onRowDragEnd}
                onClick={() => onSelect(a.id)}>
              <span className="row-bar" />
              <span className="row-num">{String(i+1).padStart(2,'0')}</span>
              <span className="row-name" onDoubleClick={(e)=>{e.stopPropagation();onRename(a.id);}}>{a.name}</span>
              <span className="row-count">{a.tasks.length}</span>
              {sel && <span className="row-chev">▸</span>}
            </li>
          );
        })}
      </ul>
      <button className="add-activity" onClick={onAdd}>＋ Add Activity</button>
      <div className="sidebar-io">
        <button className="io-btn" onClick={onSave} title="Download save file">↓ Save</button>
        <button className="io-btn" onClick={onLoadClick} title="Load save file">↑ Load</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={onFilePicked}
        />
      </div>
      <div className="sidebar-ft mono">
        <div>↑↓ &nbsp; switch</div>
        <div>⎵ &nbsp;&nbsp; finish</div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const theme = THEMES[t.theme] || THEMES.cream;

  const [activities, setActivities] = useState(INITIAL_ACTIVITIES);
  const [selectedId, setSelectedId] = useState(1);
  const [finishingId, setFinishingId] = useState(null);
  const [heatStarts, setHeatStarts] = useState({}); // { [activityId]: { hotTaskId, startedAt } }
  const [now, setNow] = useState(() => Date.now());

  const current = activities.find(a => a.id === selectedId) || activities[0];
  const hotTask = current?.tasks[current.tasks.length - 1];

  // Tick for live heat values
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(id);
  }, []);

  // Maintain a heat-start entry per activity, keyed by its current hot task id.
  // Whenever the hot task changes (finish, add, delete, reorder), the entry resets.
  useEffect(() => {
    setHeatStarts(prev => {
      const next = { ...prev };
      let changed = false;
      const seen = new Set();
      activities.forEach(a => {
        seen.add(String(a.id));
        const ht = a.tasks[a.tasks.length - 1];
        const newId = ht?.id || null;
        const cur = next[a.id];
        if (!cur || cur.hotTaskId !== newId) {
          if (newId == null) delete next[a.id];
          else next[a.id] = { hotTaskId: newId, startedAt: Date.now() };
          changed = true;
        }
      });
      Object.keys(next).forEach(k => {
        if (!seen.has(k)) { delete next[k]; changed = true; }
      });
      return changed ? next : prev;
    });
  }, [activities]);

  // Compute current heat (0..1) per activity, using each hot task's own durationMs.
  const heats = useMemo(() => {
    const out = {};
    activities.forEach(a => {
      const entry = heatStarts[a.id];
      if (!entry) { out[a.id] = 0; return; }
      if (finishingId === entry.hotTaskId) { out[a.id] = 1; return; }
      const ht = a.tasks[a.tasks.length - 1];
      const taskDur = ht?.durationMs || DEFAULT_TASK_DURATION_MS;
      out[a.id] = Math.max(0, Math.min(1, (now - entry.startedAt) / taskDur));
    });
    return out;
  }, [activities, heatStarts, now, finishingId]);

  const heat = heats[selectedId] || 0;

  // ── Actions ───────────────────────────────────────────────────────────────
  const finishTask = useCallback(() => {
    if (!hotTask || finishingId) return;
    const finId = hotTask.id;
    setFinishingId(finId);
    setTimeout(() => {
      setActivities(acts => acts.map(a => {
        if (a.id !== selectedId) return a;
        const ts = a.tasks.slice();
        const moved = ts.pop();
        return { ...a, tasks: [{ ...moved, streak: (moved.streak||0) + 1 }, ...ts] };
      }));
      setFinishingId(null);
    }, FINISH_MS);
  }, [hotTask?.id, finishingId, selectedId]);

  const [addTaskOpen, setAddTaskOpen] = useState(false);

  const openAddTask = useCallback(() => setAddTaskOpen(true), []);
  const submitAddTask = useCallback((name, durationMs) => {
    setActivities(acts => acts.map(a => a.id === selectedId
      ? { ...a, tasks: [...a.tasks, {
          id: `tk_${Date.now()}`,
          name: name.trim().slice(0,16),
          streak: 0,
          durationMs,
        }] }
      : a));
    setAddTaskOpen(false);
  }, [selectedId]);

  const deleteTask = useCallback((tid) => {
    setActivities(acts => acts.map(a => a.id === selectedId
      ? { ...a, tasks: a.tasks.filter(x => x.id !== tid) } : a));
  }, [selectedId]);

  const addActivity = useCallback(() => {
    const name = window.prompt('Activity name?');
    if (!name) return;
    setActivities(acts => {
      const color = ACTIVITY_COLORS[acts.length % ACTIVITY_COLORS.length];
      const id = Date.now();
      return [...acts, { id, name: name.toUpperCase().slice(0,16), color, tasks: [] }];
    });
  }, []);

  const renameActivity = useCallback((id) => {
    const a = activities.find(x => x.id === id);
    if (!a) return;
    const name = window.prompt('Rename activity', a.name);
    if (!name) return;
    setActivities(acts => acts.map(x => x.id === id ? { ...x, name: name.toUpperCase().slice(0,16) } : x));
  }, [activities]);

  const reorderTasks = useCallback((from, to) => {
    setActivities(acts => acts.map(a => {
      if (a.id !== selectedId) return a;
      if (from < 0 || from >= a.tasks.length || to < 0 || to >= a.tasks.length) return a;
      const ts = a.tasks.slice();
      const [moved] = ts.splice(from, 1);
      ts.splice(to, 0, moved);
      return { ...a, tasks: ts };
    }));
  }, [selectedId]);

  const reorderActivities = useCallback((from, to) => {
    setActivities(acts => {
      if (from < 0 || from >= acts.length || to < 0 || to >= acts.length) return acts;
      const next = acts.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // ── Save / Load ───────────────────────────────────────────────────────────
  const saveToFile = useCallback(() => {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      selectedId,
      activities,
      heatStarts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `heatqueue-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activities, heatStarts, selectedId]);

  const loadFromFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!Array.isArray(data.activities)) throw new Error('bad shape');
        setActivities(data.activities);
        if (data.heatStarts && typeof data.heatStarts === 'object') {
          setHeatStarts(data.heatStarts);
        } else {
          setHeatStarts({});
        }
        if (data.selectedId != null) setSelectedId(data.selectedId);
      } catch (err) {
        window.alert('Could not load that file — it does not look like a HeatQueue save.');
      }
    };
    reader.readAsText(file);
  }, []);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (addTaskOpen) return;
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = activities.findIndex(a => a.id === selectedId);
        const next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + activities.length) % activities.length;
        setSelectedId(activities[next].id);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        finishTask();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activities, selectedId, finishTask, addTaskOpen]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`:root{
        --chassis:${theme.chassis}; --edge:${theme.edge};
        --screen:${theme.screen}; --ink:${theme.ink};
        --accent:${theme.accent};
      }`}</style>

      <Stage width={1280} height={760}>
        <div className={`device ${t.showScanlines ? 'with-crt':''}`}>
          {/* device top bar */}
          <div className="device-top">
            <div className="device-brand">
              <span className="logo-mark" />
              <span className="logo-text">QUEUE-DS</span>
              <span className="logo-sub">model&nbsp;A-01</span>
            </div>
            <div className="device-grille" aria-hidden="true">
              {Array.from({length:30}).map((_,i)=><span key={i} />)}
            </div>
            <div className="device-leds" aria-hidden="true">
              <span className="led led-pwr" />
              <span className="led-label mono">PWR</span>
              <span className={`led led-heat`} style={{ opacity: 0.25 + heat*0.75 }}/>
              <span className="led-label mono">HEAT</span>
            </div>
          </div>

          <div className="device-screens">
            <ActivitySidebar
              activities={activities}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={addActivity}
              onRename={renameActivity}
              onReorderActivities={reorderActivities}
              onSave={saveToFile}
              onLoad={loadFromFile}
              heats={heats}
            />
            <div className="hinge" aria-hidden="true">
              <span /><span /><span />
            </div>
            <ConveyorScreen
              activity={current}
              heat={heat}
              finishingId={finishingId}
              onFinish={finishTask}
              onAddTask={openAddTask}
              onDeleteTask={deleteTask}
              onReorderTasks={reorderTasks}
              showStreak={t.showStreak}
            />
          </div>

          <div className="device-bottom">
            <div className="bottom-feet">
              <span /><span />
            </div>
            <div className="bottom-mono mono">
              <span>SN&nbsp;0042·77A</span>
              <span>·</span>
              <span>FW 1.04</span>
              <span>·</span>
              <span>{activities.reduce((s,a)=>s+a.tasks.reduce((q,x)=>q+(x.streak||0),0),0)} loops</span>
            </div>
          </div>
        </div>
      </Stage>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Mechanics" />
        <TweakToggle label="Show streak counters" value={t.showStreak}
                     onChange={(v)=>setTweak('showStreak', v)} />
        <TweakSection label="Look" />
        <TweakRadio label="Theme" value={t.theme}
                    options={['cream','graphite','sherbet']}
                    onChange={(v)=>setTweak('theme', v)} />
        <TweakToggle label="CRT scanlines" value={t.showScanlines}
                     onChange={(v)=>setTweak('showScanlines', v)} />
      </TweaksPanel>

      {addTaskOpen && (
        <AddTaskModal
          activityName={current?.name}
          onCancel={() => setAddTaskOpen(false)}
          onSubmit={submitAddTask}
        />
      )}
    </>
  );
}

// Mount
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
