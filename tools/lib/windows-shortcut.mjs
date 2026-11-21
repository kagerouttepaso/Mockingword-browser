import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

export async function sendBrowserAltA(browserPid, start) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(browserPid) || browserPid <= 0) {
    throw new Error('配布版 sakutto の試験は Windows のブラウザーで実行してください');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace Replay -Name Window -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hwnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hwnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint source, uint target, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
'@
function Get-ForegroundOwner {
    [uint32]$owner = 0
    [void][Replay.Window]::GetWindowThreadProcessId([Replay.Window]::GetForegroundWindow(), [ref]$owner)
    return $owner
}
$shell = New-Object -ComObject WScript.Shell
if ((Get-ForegroundOwner) -ne ${browserPid}) { [void]$shell.AppActivate(${browserPid}) }
if ((Get-ForegroundOwner) -ne ${browserPid}) {
    $target = (Get-Process -Id ${browserPid}).MainWindowHandle
    [uint32]$owner = 0
    $foreground = [Replay.Window]::GetWindowThreadProcessId([Replay.Window]::GetForegroundWindow(), [ref]$owner)
    $helper = [Replay.Window]::GetCurrentThreadId()
    if ($target -ne 0 -and $foreground -ne 0 -and [Replay.Window]::AttachThreadInput($helper, $foreground, $true)) {
        try { [void][Replay.Window]::SetForegroundWindow($target) }
        finally { [void][Replay.Window]::AttachThreadInput($helper, $foreground, $false) }
    }
}
for ($attempt = 0; $attempt -lt 10 -and (Get-ForegroundOwner) -ne ${browserPid}; $attempt++) { Start-Sleep -Milliseconds 50 }
if ((Get-ForegroundOwner) -ne ${browserPid}) {
    [Console]::Error.WriteLine("foreground=$(Get-ForegroundOwner) browser=${browserPid}")
    exit 2
}
[Console]::WriteLine('ready')
if ([Console]::ReadLine() -ne 'send' -or (Get-ForegroundOwner) -ne ${browserPid}) { exit 3 }
$shell.SendKeys('%a')
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => child.kill());
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (text) => { errors += text; });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const exited = once(child, 'close');
    const ready = await Promise.race([once(lines, 'line').then(([line]) => line === 'ready'), exited.then(() => false)]);
    if (!ready) throw new Error(`試験用ブラウザーを前面にできません。Alt+A は送信していません ${errors.trim()}`);
    await start();
    child.stdin.end('send\n');
    const [code] = await exited;
    if (code !== 0) throw new Error(`試験用ブラウザーに Alt+A を送信できません ${errors.trim()}`);
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
