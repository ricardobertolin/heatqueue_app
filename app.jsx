const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ────────────────────────────────────────────────────────────────────────────
// Tweakable defaults — host rewrites between EDITMODE markers
// ────────────────────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "cream",
  "showStreak": true,
  "showScanlines": true,
  "layout": "vertical"
}/*EDITMODE-END*/;

const DEFAULT_TASK_DURATION_MS = 60 * 60 * 1000; // 1 hour fallback
const MS = { day: 86400_000, hour: 3600_000, minute: 60_000 };

function msToParts(ms) {
  ms = Math.max(0, ms || 0);
  return {
    days:    Math.floor(ms / MS.day),
    hours:   Math.floor((ms % MS.day) / MS.hour),
    minutes: Math.floor((ms % MS.hour) / MS.minute),
  };
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const THEMES = {
  cream:    { chassis:'#DBD3BF', edge:'#B9AE93', screen:'#F4EFE0', ink:'#2A2620', accent:'#DA5757' },
  graphite: { chassis:'#3C3A35', edge:'#23211D', screen:'#1F1D19', ink:'#EFEAD8', accent:'#F9C66B' },
  sherbet:  { chassis:'#F4C6C0', edge:'#D89890', screen:'#FFF4EE', ink:'#3B2724', accent:'#5BAE73' },
};

const ACTIVITY_COLORS = ['#DA5757', '#F0A33A', '#5BAE73', '#4A6FA5', '#B47BD6', '#E07AB5'];

const MAX_OVENS = 4;
const INITIAL_ACTIVITIES = [
  { id: 1, name: 'TASKS', color: '#DA5757', ovenCount: 1, tasks: [] },
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
function ConveyorScreen({ activity, heat, elapsedMs, taskHeats, focusedSlot, onChangeFocus, finishingId, onFinish, onAddTask, onDeleteTask, onReorderTasks, onEditTask, showStreak }) {
  if (!activity) return null;
  const tasks = activity.tasks;
  const lastIdx = tasks.length - 1;
  const ovenCount = Math.max(1, activity.ovenCount || 1);
  const visibleOvens = Math.min(ovenCount, tasks.length);
  const slot = visibleOvens > 0 ? Math.min(focusedSlot ?? 0, visibleOvens - 1) : 0;
  const focused = visibleOvens > 0 ? tasks[lastIdx - slot] : null;
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
      if (e.pointerId != null && panState.current.pointerId != null
          && e.pointerId !== panState.current.pointerId) return;
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
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  function onBeltPointerDown(e) {
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (e.target.closest('.task')) return;   // mouse: tasks drag via HTML5 d&d
    }
    if (e.target.closest('button')) return;
    if (!beltRef.current) return;
    const r = beltRef.current.getBoundingClientRect();
    const scale = r.width / beltRef.current.offsetWidth || 1;
    panState.current = { startX: e.clientX, startPan: panX, scale, maxPan, pointerId: e.pointerId };
    setIsPanning(true);
    document.body.style.cursor = 'grabbing';
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
        onPointerDown={onBeltPointerDown}
      >
        {/* dotted infinity tail on the left */}
        <div className="belt-tail" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        {/* the rail */}
        <div className="belt-rail" aria-hidden="true">
          <div className="rail-arrow" />
        </div>
        {/* heat glow + ovens — anchored to the right end of the belt and pan with it */}
        {Array.from({ length: ovenCount }).map((_, slot) => {
          const slotTaskIdx = lastIdx - slot;
          const slotTask = slotTaskIdx >= 0 ? tasks[slotTaskIdx] : null;
          const slotHeat = slotTask ? (taskHeats?.[slotTask.id] || 0) : 0;
          const rightOffset = slot * STEP;
          return (
            <React.Fragment key={`oven-${slot}`}>
              <div className="oven-glow"
                   style={{ right: `${51 + rightOffset - panX}px`, opacity: slotHeat * 0.9 }}
                   aria-hidden="true" />
              <div className="oven"
                   style={{ right: `${101 + rightOffset - panX}px` }}
                   aria-hidden="true">
                <span className="roller r-l" />
                <span className="roller r-r" />
                <div className="oven-floor" />
              </div>
            </React.Fragment>
          );
        })}

        {/* tasks */}
        <div className="task-track">
          {tasks.map((task, i) => {
            const fromRight = lastIdx - i; // 0 = rightmost
            const isOnOven = fromRight < ovenCount;
            const isFocused = visibleOvens > 1 && fromRight === slot;
            const isFinishing = task.id === finishingId;
            const isDragging = dragTaskIdx === i;
            const isDragOver = overTaskIdx === i && dragTaskIdx != null && dragTaskIdx !== i;
            const tx = -fromRight * STEP + panX;
            const myHeat = taskHeats?.[task.id] || 0;
            const mySizzling = isOnOven && myHeat > 0.97 && !isFinishing;
            return (
              <div
                key={task.id}
                className={`task ${isOnOven ? 'is-hot':''} ${isFocused ? 'is-focused':''} ${isFinishing ? 'is-finishing':''} ${mySizzling ? 'is-sizzling':''} ${isDragging ? 'is-dragging':''} ${isDragOver ? 'is-drag-over':''}`}
                style={{ transform: `translateX(${tx}px) translateY(${isFinishing ? -110 : 0}px)` }}
                draggable={!isFinishing}
                onDragStart={(e) => onTaskDragStart(e, i)}
                onDragOver={(e) => onTaskDragOver(e, i)}
                onDrop={(e) => onTaskDrop(e, i)}
                onDragEnd={onTaskDragEnd}
                onDoubleClick={() => onEditTask?.(task.id)}
                title="Double-click to edit"
              >
                <div className="task-label">{task.name}</div>
                <div className="task-stack">
                  {[0,1,2].map(bi => {
                    const fill = isOnOven && !isFinishing ? heatColorForBox(bi, myHeat) : null;
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

        {maxPan > 0 && (
          <>
            <button
              className="belt-arrow belt-arrow-left"
              disabled={panX >= maxPan - 0.5}
              onClick={() => setPanX(p => Math.min(maxPan, p + STEP))}
              title="See earlier tasks"
              aria-label="Scroll left"
            >‹</button>
            <button
              className="belt-arrow belt-arrow-right"
              disabled={panX <= 0.5}
              onClick={() => setPanX(p => Math.max(0, p - STEP))}
              title="See later tasks"
              aria-label="Scroll right"
            >›</button>
          </>
        )}
      </div>

      {/* Finish action */}
      <div className="finish-row">
        <div className="finish-meta">
          {focused ? (
            <>
              {visibleOvens > 1 && (
                <button className="oven-nav"
                        onClick={() => onChangeFocus?.((slot - 1 + visibleOvens) % visibleOvens)}
                        title="Previous oven">‹</button>
              )}
              <span className="finish-mono">
                {visibleOvens > 1 ? `OVEN ${slot + 1}/${visibleOvens}` : 'ON THE OVEN'}
              </span>
              <span className="finish-name">{focused.name}</span>
              <span className="finish-bar">
                <span className="finish-bar-fill" style={{ width: `${Math.round(heat*100)}%` }} />
              </span>
              <span className="finish-pct">
                {fmtDuration(elapsedMs)} / {fmtDuration(focused.durationMs || 0)}
              </span>
              {visibleOvens > 1 && (
                <button className="oven-nav"
                        onClick={() => onChangeFocus?.((slot + 1) % visibleOvens)}
                        title="Next oven">›</button>
              )}
            </>
          ) : (
            <span className="finish-mono">— add a task to start the belt —</span>
          )}
        </div>
        <button
          className={`finish-btn primary ${fullyHot ? 'is-ready':''}`}
          disabled={!focused || !!finishingId}
          onClick={onFinish}
        >
          Finish task <kbd>⎵</kbd>
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Task modal — handles both "new task" and "edit task"
// ────────────────────────────────────────────────────────────────────────────
function TaskModal({ activityName, task, onCancel, onSubmit, onDelete }) {
  const isEdit = !!task;
  const initial = isEdit ? msToParts(task.durationMs || DEFAULT_TASK_DURATION_MS) : { days: 0, hours: 0, minutes: 0 };
  const [name, setName] = useState(task?.name || '');
  const [days, setDays] = useState(initial.days);
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
    if (isEdit) nameRef.current?.select();
  }, [isEdit]);

  const totalMs = (days * MS.day) + (hours * MS.hour) + (minutes * MS.minute);
  const canSubmit = name.trim().length > 0 && totalMs > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit(name, totalMs);
  }
  function tryDelete() {
    if (!isEdit) return;
    if (window.confirm(`Delete task "${task.name}"?`)) onDelete();
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
          <h3>{isEdit ? 'Edit task' : 'New task'}</h3>
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
          {isEdit && (
            <button className="modal-btn danger" onClick={tryDelete}>Delete</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn primary" disabled={!canSubmit} onClick={submit}>
            {isEdit ? 'Save' : 'Add task'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Activity modal — handles both "new activity" and "edit activity"
// ────────────────────────────────────────────────────────────────────────────
function ActivityModal({ activity, defaultColor, canDelete, onCancel, onSubmit, onDelete }) {
  const isEdit = !!activity;
  const [name, setName] = useState(activity?.name || '');
  const [color, setColor] = useState(activity?.color || defaultColor || ACTIVITY_COLORS[0]);
  const [ovenCount, setOvenCount] = useState(activity?.ovenCount || 1);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
    if (isEdit) nameRef.current?.select();
  }, [isEdit]);

  const canSubmit = name.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit(name.trim().toUpperCase().slice(0, 16), color, ovenCount);
  }
  function tryDelete() {
    if (!isEdit || !canDelete) return;
    if (window.confirm(`Delete "${activity.name}" and all its tasks?`)) onDelete();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    else if (e.key === 'Enter') { e.stopPropagation(); submit(); }
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="modal-hd">
          <h3>{isEdit ? 'Edit activity' : 'New activity'}</h3>
          {isEdit && (
            <span className="modal-sub mono">
              {activity.tasks.length} task{activity.tasks.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <label className="modal-field">
          <span className="modal-lbl mono">Name</span>
          <input
            ref={nameRef}
            type="text"
            maxLength={16}
            placeholder="e.g. STUDIO"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="modal-field">
          <span className="modal-lbl mono">Color</span>
          <div className="color-swatches">
            {ACTIVITY_COLORS.map(c => (
              <button key={c} type="button"
                      className={`swatch ${c.toLowerCase() === color.toLowerCase() ? 'is-sel' : ''}`}
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                      title={c} />
            ))}
            <label className={`swatch swatch-custom ${!ACTIVITY_COLORS.map(c=>c.toLowerCase()).includes(color.toLowerCase()) ? 'is-sel' : ''}`}
                   title="Custom color">
              <span className="swatch-custom-inner" style={{ background: color }} />
              <input type="color" value={color}
                     onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="modal-field">
          <span className="modal-lbl mono">Ovens (tasks heating in parallel)</span>
          <div className="oven-picker">
            {Array.from({ length: MAX_OVENS }).map((_, i) => {
              const n = i + 1;
              return (
                <button key={n} type="button"
                        className={`oven-pick ${ovenCount === n ? 'is-sel' : ''}`}
                        onClick={() => setOvenCount(n)}>
                  {n}
                </button>
              );
            })}
          </div>
        </div>

        <div className="modal-actions">
          {isEdit && (
            <button className="modal-btn danger"
                    disabled={!canDelete}
                    title={canDelete ? 'Delete activity' : 'Cannot delete the last activity'}
                    onClick={tryDelete}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn primary" disabled={!canSubmit} onClick={submit}>
            {isEdit ? 'Save' : 'Add activity'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sidebar (left panel)
// ────────────────────────────────────────────────────────────────────────────
function ActivitySidebar({ activities, selectedId, onSelect, onAdd, onEditActivity, onReorderActivities, onSave, onLoad, onPickLoad, heats }) {
  const fileInputRef = useRef(null);
  function onLoadClick() {
    // Prefer the file picker (lets future saves overwrite the same file);
    // fall back to a plain file input where it isn't supported.
    if (window.showOpenFilePicker) onPickLoad();
    else fileInputRef.current?.click();
  }
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
                onClick={() => onSelect(a.id)}
                onDoubleClick={(e) => { e.stopPropagation(); onEditActivity(a.id); }}
                title="Double-click to edit">
              <span className="row-bar" />
              <span className="row-num">{String(i+1).padStart(2,'0')}</span>
              <span className="row-name">{a.name}</span>
              <span className="row-count">{a.tasks.length}</span>
              {sel && <span className="row-chev">▸</span>}
            </li>
          );
        })}
      </ul>
      <button className="add-activity" onClick={onAdd}>＋ Add Activity</button>
      <div className="sidebar-io">
        <button className="io-btn" onClick={onSave} title="Save to a file (overwrites the same file on later saves)">↓ Save</button>
        <button className="io-btn" onClick={onLoadClick} title="Load a save file">↑ Load</button>
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
// Persistence — auto-save to localStorage so data restores on every open
// ────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'heatqueue:autosave';

function readSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.activities)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const theme = THEMES[t.theme] || THEMES.cream;

  // Restore the last session from localStorage (read once at boot).
  const boot = useRef(readSavedState()).current;
  const [activities, setActivities] = useState(() =>
    boot ? boot.activities.map(a => ({ ovenCount: 1, ...a })) : INITIAL_ACTIVITIES);
  const [selectedId, setSelectedId] = useState(() =>
    boot && boot.selectedId != null ? boot.selectedId : 1);
  const [finishingId, setFinishingId] = useState(null);
  const [taskHeats, setTaskHeats] = useState(() =>
    boot && boot.taskHeats && typeof boot.taskHeats === 'object' ? boot.taskHeats : {}); // { [taskId]: { startedAt } }
  const [now, setNow] = useState(() => Date.now());

  const current = activities.find(a => a.id === selectedId) || activities[0];

  // Tick for live heat values
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(id);
  }, []);

  // Set of task ids currently in an oven slot (last N of each activity, where N=ovenCount).
  const hotTaskIdsByActivity = useMemo(() => {
    const out = new Map();
    activities.forEach(a => {
      const N = Math.max(1, a.ovenCount || 1);
      const len = a.tasks.length;
      const ids = [];
      for (let i = Math.max(0, len - N); i < len; i++) ids.push(a.tasks[i].id);
      out.set(a.id, ids);
    });
    return out;
  }, [activities]);

  const allHotTaskIds = useMemo(() => {
    const s = new Set();
    hotTaskIdsByActivity.forEach(ids => ids.forEach(id => s.add(id)));
    return s;
  }, [hotTaskIdsByActivity]);

  // Maintain a per-task startedAt for any task currently in an oven slot.
  // Entering a slot fresh sets startedAt = now; leaving a slot clears the entry.
  useEffect(() => {
    setTaskHeats(prev => {
      const next = { ...prev };
      let changed = false;
      allHotTaskIds.forEach(tid => {
        if (!next[tid]) { next[tid] = { startedAt: Date.now() }; changed = true; }
      });
      Object.keys(next).forEach(tid => {
        if (!allHotTaskIds.has(tid)) { delete next[tid]; changed = true; }
      });
      return changed ? next : prev;
    });
  }, [allHotTaskIds]);

  // Compute heat per task (0..1).
  const taskHeatValues = useMemo(() => {
    const out = {};
    activities.forEach(a => {
      a.tasks.forEach(t => {
        if (finishingId === t.id) { out[t.id] = 1; return; }
        const entry = taskHeats[t.id];
        if (!entry) { out[t.id] = 0; return; }
        const dur = t.durationMs || DEFAULT_TASK_DURATION_MS;
        out[t.id] = Math.max(0, Math.min(1, (now - entry.startedAt) / dur));
      });
    });
    return out;
  }, [activities, taskHeats, now, finishingId]);

  // Per-activity heat for the menu glow = max heat among its current hot tasks.
  const heats = useMemo(() => {
    const out = {};
    activities.forEach(a => {
      const ids = hotTaskIdsByActivity.get(a.id) || [];
      let max = 0;
      ids.forEach(id => { const v = taskHeatValues[id] || 0; if (v > max) max = v; });
      out[a.id] = max;
    });
    return out;
  }, [activities, hotTaskIdsByActivity, taskHeatValues]);

  // Which oven slot's task is currently shown in the finish row. 0 = rightmost.
  const [focusedSlot, setFocusedSlot] = useState(0);
  useEffect(() => { setFocusedSlot(0); }, [selectedId]);

  const focusedTask = useMemo(() => {
    if (!current) return null;
    const N = Math.max(1, current.ovenCount || 1);
    const T = current.tasks.length;
    if (T === 0) return null;
    const slot = Math.min(focusedSlot, N - 1, T - 1);
    return current.tasks[T - 1 - slot] || null;
  }, [current, focusedSlot]);

  const heat = focusedTask ? (taskHeatValues[focusedTask.id] || 0) : 0;
  const focusedStart = focusedTask ? taskHeats[focusedTask.id] : null;
  const elapsedMs = focusedStart ? Math.max(0, now - focusedStart.startedAt) : 0;

  // ── Actions ───────────────────────────────────────────────────────────────
  const finishTask = useCallback(() => {
    if (!focusedTask || finishingId) return;
    const finId = focusedTask.id;
    setFinishingId(finId);
    setTimeout(() => {
      setActivities(acts => acts.map(a => {
        if (a.id !== selectedId) return a;
        const idx = a.tasks.findIndex(t => t.id === finId);
        if (idx < 0) return a;
        const ts = a.tasks.slice();
        const [moved] = ts.splice(idx, 1);
        return { ...a, tasks: [{ ...moved, streak: (moved.streak||0) + 1 }, ...ts] };
      }));
      setFocusedSlot(0);
      setFinishingId(null);
    }, FINISH_MS);
  }, [focusedTask?.id, finishingId, selectedId]);

  const [addTaskOpen, setAddTaskOpen] = useState(false);

  const openAddTask = useCallback(() => setAddTaskOpen(true), []);
  const submitAddTask = useCallback((name, durationMs) => {
    // Prepend at the back of the queue (leftmost, farthest from the oven).
    // Tasks already heating on the oven keep their position and their heat.
    setActivities(acts => acts.map(a => a.id === selectedId
      ? { ...a, tasks: [{
          id: `tk_${Date.now()}`,
          name: name.trim().slice(0,16),
          streak: 0,
          durationMs,
        }, ...a.tasks] }
      : a));
    setAddTaskOpen(false);
  }, [selectedId]);

  const deleteTask = useCallback((tid) => {
    setActivities(acts => acts.map(a => a.id === selectedId
      ? { ...a, tasks: a.tasks.filter(x => x.id !== tid) } : a));
  }, [selectedId]);

  const [editingTaskId, setEditingTaskId] = useState(null);
  const editingTask = editingTaskId != null
    ? current?.tasks.find(t => t.id === editingTaskId) || null
    : null;

  const openEditTask = useCallback((tid) => setEditingTaskId(tid), []);
  const submitEditTask = useCallback((name, durationMs) => {
    setActivities(acts => acts.map(a => a.id !== selectedId ? a : {
      ...a,
      tasks: a.tasks.map(t => t.id === editingTaskId
        ? { ...t, name: name.trim().slice(0,16), durationMs }
        : t),
    }));
    setEditingTaskId(null);
  }, [selectedId, editingTaskId]);
  const deleteEditingTask = useCallback(() => {
    if (editingTaskId == null) return;
    setActivities(acts => acts.map(a => a.id !== selectedId ? a : {
      ...a, tasks: a.tasks.filter(t => t.id !== editingTaskId),
    }));
    setEditingTaskId(null);
  }, [selectedId, editingTaskId]);

  const [addActivityOpen, setAddActivityOpen] = useState(false);
  const openAddActivity = useCallback(() => setAddActivityOpen(true), []);
  const submitAddActivity = useCallback((name, color, ovenCount) => {
    setActivities(acts => [
      ...acts,
      { id: Date.now(), name, color, ovenCount: ovenCount || 1, tasks: [] },
    ]);
    setAddActivityOpen(false);
  }, []);

  const [editingActivityId, setEditingActivityId] = useState(null);
  const editingActivity = editingActivityId != null
    ? activities.find(a => a.id === editingActivityId) || null
    : null;

  const openEditActivity = useCallback((id) => setEditingActivityId(id), []);
  const submitEditActivity = useCallback((name, color, ovenCount) => {
    setActivities(acts => acts.map(a =>
      a.id === editingActivityId ? { ...a, name, color, ovenCount: ovenCount || 1 } : a));
    setEditingActivityId(null);
  }, [editingActivityId]);
  const deleteEditingActivity = useCallback(() => {
    if (editingActivityId == null) return;
    setActivities(acts => {
      if (acts.length <= 1) return acts;
      return acts.filter(a => a.id !== editingActivityId);
    });
    setEditingActivityId(null);
  }, [editingActivityId]);

  // If the selected activity gets deleted, fall back to the first remaining.
  useEffect(() => {
    if (activities.length > 0 && !activities.find(a => a.id === selectedId)) {
      setSelectedId(activities[0].id);
    }
  }, [activities, selectedId]);

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
  const buildPayload = useCallback(() => ({
    version: 2,
    savedAt: new Date().toISOString(),
    selectedId,
    activities,
    taskHeats,
  }), [activities, taskHeats, selectedId]);

  // Auto-save to localStorage on every change (debounced) so the app restores
  // itself on the next open — no manual "Load" needed.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildPayload()));
      } catch (_) { /* storage full or unavailable — ignore */ }
    }, 400);
    return () => clearTimeout(id);
  }, [buildPayload]);

  // Remember the file the user saved/loaded so subsequent saves overwrite it
  // instead of downloading a new copy each time.
  const fileHandleRef = useRef(null);

  const applyLoadedData = useCallback((data) => {
    if (!data || !Array.isArray(data.activities)) {
      window.alert('Could not load that file — it does not look like a HeatQueue save.');
      return false;
    }
    // Backfill ovenCount for older saves.
    setActivities(data.activities.map(a => ({ ovenCount: 1, ...a })));
    setTaskHeats(data.taskHeats && typeof data.taskHeats === 'object' ? data.taskHeats : {});
    if (data.selectedId != null) setSelectedId(data.selectedId);
    return true;
  }, []);

  const saveToFile = useCallback(async () => {
    const json = JSON.stringify(buildPayload(), null, 2);
    const suggestedName = `heatqueue-${new Date().toISOString().slice(0,10)}.json`;

    // File System Access API: write straight to a remembered file handle so we
    // overwrite the same file instead of cluttering Downloads with copies.
    if (window.showSaveFilePicker) {
      try {
        let handle = fileHandleRef.current;
        if (!handle) {
          handle = await window.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'HeatQueue save', accept: { 'application/json': ['.json'] } }],
          });
          fileHandleRef.current = handle;
        }
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled
        fileHandleRef.current = null; // fall through to download fallback
      }
    }

    // Fallback (older browsers, most mobile): download a file.
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [buildPayload]);

  const loadFromFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyLoadedData(JSON.parse(String(reader.result)));
      } catch (err) {
        window.alert('Could not load that file — it does not look like a HeatQueue save.');
      }
    };
    reader.readAsText(file);
  }, [applyLoadedData]);

  // Load via the File System Access API when available, so the chosen file
  // also becomes the target for future saves.
  const pickAndLoad = useCallback(async () => {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'HeatQueue save', accept: { 'application/json': ['.json'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      const ok = applyLoadedData(JSON.parse(await file.text()));
      if (ok) fileHandleRef.current = handle;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      window.alert('Could not load that file — it does not look like a HeatQueue save.');
    }
  }, [applyLoadedData]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      if (addTaskOpen || addActivityOpen || editingActivityId != null || editingTaskId != null) return;
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
  }, [activities, selectedId, finishTask, addTaskOpen, addActivityOpen, editingActivityId, editingTaskId]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`:root{
        --chassis:${theme.chassis}; --edge:${theme.edge};
        --screen:${theme.screen}; --ink:${theme.ink};
        --accent:${theme.accent};
      }`}</style>

      <Stage
        width={t.layout === 'vertical' ? 480 : 1280}
        height={t.layout === 'vertical' ? 900 : 760}
      >
        <div className={`device ${t.showScanlines ? 'with-crt':''} ${t.layout === 'vertical' ? 'is-vertical':''}`}>
          {/* device top bar */}
          <div className="device-top">
            <div className="device-brand">
              <span className="logo-mark" />
              <span className="logo-text">QUEUE-DS</span>
              <span className="logo-sub">model&nbsp;A-01</span>
              <button
                className="layout-toggle"
                onClick={() => setTweak('layout', t.layout === 'vertical' ? 'horizontal' : 'vertical')}
                title={t.layout === 'vertical' ? 'Switch to horizontal' : 'Switch to vertical'}
              >
                {t.layout === 'vertical' ? '↔' : '↕'}
              </button>
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
              onAdd={openAddActivity}
              onEditActivity={openEditActivity}
              onReorderActivities={reorderActivities}
              onSave={saveToFile}
              onLoad={loadFromFile}
              onPickLoad={pickAndLoad}
              heats={heats}
            />
            <div className="hinge" aria-hidden="true">
              <span /><span /><span />
            </div>
            <ConveyorScreen
              activity={current}
              heat={heat}
              elapsedMs={elapsedMs}
              taskHeats={taskHeatValues}
              focusedSlot={focusedSlot}
              onChangeFocus={setFocusedSlot}
              finishingId={finishingId}
              onFinish={finishTask}
              onAddTask={openAddTask}
              onDeleteTask={deleteTask}
              onReorderTasks={reorderTasks}
              onEditTask={openEditTask}
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
        <TaskModal
          activityName={current?.name}
          onCancel={() => setAddTaskOpen(false)}
          onSubmit={submitAddTask}
        />
      )}

      {editingTask && (
        <TaskModal
          activityName={current?.name}
          task={editingTask}
          onCancel={() => setEditingTaskId(null)}
          onSubmit={submitEditTask}
          onDelete={deleteEditingTask}
        />
      )}

      {addActivityOpen && (
        <ActivityModal
          defaultColor={ACTIVITY_COLORS[activities.length % ACTIVITY_COLORS.length]}
          onCancel={() => setAddActivityOpen(false)}
          onSubmit={submitAddActivity}
        />
      )}

      {editingActivity && (
        <ActivityModal
          activity={editingActivity}
          canDelete={activities.length > 1}
          onCancel={() => setEditingActivityId(null)}
          onSubmit={submitEditActivity}
          onDelete={deleteEditingActivity}
        />
      )}
    </>
  );
}

// Mount
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
