// IAmigos desktop — Windows: the process table from Win32_Process (PowerShell),
// background shells, and bringing the session's terminal window forward.

import {ancestors, backgroundShellCount, jumpToPane} from '../shared/procs.js';
import {cachedTable, isAlive, runner} from './common.mjs';

const PS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const encode = script => Buffer.from(script, 'utf16le').toString('base64');

const LIST = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';

// ConvertTo-Json output → [{pid, ppid, argv}]; argv is [name, command line].
export function parseCim(out) {
    let rows;
    try {
        rows = JSON.parse(out);
    } catch {
        return null;
    }
    return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(r => ({
        pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId),
        argv: [r.Name ?? '', r.CommandLine ?? ''].filter(Boolean),
    }));
}

const psString = s => `'${String(s).replace(/'/g, "''")}'`;

// PowerShell that raises the first of `pids` that has a window; if none does,
// a window whose title has the project name; else Windows Terminal.
// AppActivate works because the request comes from the app the user just clicked.
export function focusScript(pids, project) {
    return `
$shell = New-Object -ComObject WScript.Shell
foreach ($id in @(${pids.map(Number).join(', ')})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0 -and $shell.AppActivate($id)) { exit 0 }
}
$title = ${psString(project ?? '')}
if ($title) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
  if ($p -and $shell.AppActivate($p.Id)) { exit 0 }
}
$p = Get-Process WindowsTerminal, wezterm-gui, alacritty, Code -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) { $shell.AppActivate($p.Id) | Out-Null }
`;
}

export function createWin32Platform({env = process.env} = {}) {
    const run = runner(env);
    // Win32_Process is slow to query (~0.5 s): only every 15 s, and only when needed.
    const table = cachedTable(async () => parseCim(await run([...PS, encode(LIST)], {timeout: 20000})), 15000);
    let wanted = false;

    return {
        isAlive,
        backgroundShells(pid) {
            wanted = true;
            return pid ? backgroundShellCount(table.get(), pid) : 0;
        },
        update: () => (wanted ? table.refresh() : Promise.resolve([])),

        async focus(session) {
            const procs = await table.refresh(true);
            const byPid = new Map(procs.map(p => [p.pid, p]));
            const chain = [...ancestors(session.pid, pid => byPid.get(pid)?.ppid ?? 0)];
            await run([...PS, encode(focusScript(chain, session.project))]);
            await jumpToPane(session.mux, run, session.term).catch(() => {});
        },
    };
}
