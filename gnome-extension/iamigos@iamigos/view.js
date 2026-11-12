// IAmigos — what each session shows: its state, its menu text and the order of
// the critters. No GNOME imports: shared by the GNOME extension and the desktop
// app (macOS/Windows), and tested with Node.

export const CLOSED_LINGER = 30;        // s a closed session stays visible before it is removed
export const SUBAGENT_STALE = 3 * 3600; // s: a subagent with no SubagentStop for this long is considered gone
export const MAX_MINIS = 4;             // most subagent mini critters drawn

export const AGENT_LABELS = {claude: 'Claude', opencode: 'OpenCode'};

export function formatAge(secs) {
    if (secs < 60)
        return `${Math.floor(secs)} s`;
    if (secs < 3600)
        return `${Math.floor(secs / 60)} min`;
    return `${Math.floor(secs / 3600)} h ${Math.floor(secs % 3600 / 60)} min`;
}

export function formatTokens(n) {
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${Math.round(n / 1e3)}k`;
    return String(n);
}

// Live subagents of a session (very old entries are ignored).
export function liveSubagents(s, now) {
    return (Array.isArray(s.subagents) ? s.subagents : [])
        .filter(x => x && (!x.since || now - x.since < SUBAGENT_STALE));
}

// The state shown, which is not always the one in the file:
//   closed      its process is gone
//   background  done/idle, but a background shell is still running (Claude Code only)
//   asleep      done/idle for longer than sleepSecs
// `hasBackground` is only called when it matters, as it can be expensive.
export function viewOf(s, now, {alive = true, hasBackground = () => false, sleepSecs = 0} = {}) {
    let view = s.state;
    if (view !== 'closed' && !alive)
        view = 'closed';
    if ((view === 'done' || view === 'idle') && s.agent === 'claude' && hasBackground())
        view = 'background';
    if ((view === 'done' || view === 'idle') && sleepSecs > 0 && now - s.since > sleepSecs)
        view = 'asleep';
    return view;
}

// Has been waiting for your permission or answer for too long.
export function isUrgent(view, s, now, waitSecs) {
    return waitSecs > 0 && (view === 'permission' || view === 'asking') && now - s.since > waitSecs;
}

// "project · state (why) · age", with ⚠ when it has been waiting for too long.
export function sessionTitle(s, view, now, waitSecs, t) {
    const why = s.detail && ['permission', 'asking', 'error'].includes(view) ? ` (${s.detail})` : '';
    const urgent = isUrgent(view, s, now, waitSecs) ? '⚠ ' : '';
    return `${urgent}${s.project}  ·  ${t(`state.${view}`)}${why}  ·  ${formatAge(now - s.since)}`;
}

// Tool · turn · branch · context · subagents (whatever is known).
export function detailsLine(s, view, now, branch, t) {
    const parts = [];
    if (view === 'working' && s.detail)
        parts.push(s.detail);
    if (s.turn_started) {
        if (view === 'working' || view === 'compacting' || view === 'permission' || view === 'asking')
            parts.push(t('menu.turn', formatAge(now - s.turn_started)));
        else if (s.turn_ended && s.turn_ended >= s.turn_started)
            parts.push(t('menu.lastTurn', formatAge(s.turn_ended - s.turn_started)));
    }
    if (branch)
        parts.push(`⎇ ${branch}`);
    if (s.tokens) {
        const model = s.model ? ` (${String(s.model).replace(/^claude-/, '')})` : '';
        parts.push(t('menu.tokens', formatTokens(s.tokens)) + model);
    }
    const subs = liveSubagents(s, now);
    if (subs.length && view !== 'closed') {
        const kinds = [...new Set(subs.map(x => x.type).filter(Boolean))].join(', ');
        parts.push((subs.length === 1 ? t('menu.subagent') : t('menu.subagents', subs.length)) + (kinds ? `: ${kinds}` : ''));
    }
    return parts.join('  ·  ');
}

// Oldest session first. With more than `max` (0 = no limit), the rest are grouped into "+N".
export function layoutBar(names, sessions, max) {
    const visible = [...names].sort((a, b) => (sessions.get(a).started ?? 0) - (sessions.get(b).started ?? 0));
    const inBar = max > 0 ? visible.slice(0, max) : visible;
    return {visible, inBar, hidden: visible.length - inBar.length};
}

// Same project → same critter; the 2nd, 3rd… session of a project gets another colour.
// Returns name → {project, ordinal}.
export function assignLooks(names, sessions) {
    const perProject = new Map();
    const out = new Map();
    for (const name of names) {
        const s = sessions.get(name);
        const project = s.cwd || s.project || s.id;
        const ordinal = perProject.get(project) ?? 0;
        perProject.set(project, ordinal + 1);
        out.set(name, {project, ordinal});
    }
    return out;
}

// How much a session needs you, highest first (for a single tray icon).
const PRIORITY = ['permission', 'asking', 'error', 'compacting', 'working', 'done',
    'background', 'idle', 'asleep', 'closed'];

export function urgency(view, urgent) {
    const i = PRIORITY.indexOf(view);
    return (urgent ? 100 : 0) + (i < 0 ? 0 : PRIORITY.length - i);
}
