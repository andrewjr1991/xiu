import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = path.join(root, 'dist/native'); await mkdir(output, {recursive:true});
  const compiler = path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const framework = path.dirname(compiler);
  const r = spawnSync(compiler, ['/nologo','/target:exe','/platform:x64', '/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll', ...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(name=>`/r:${path.join(framework,'WPF',name)}`), `/out:${path.join(output,'XiuComputerBridge.exe')}`, path.join(root,'native/ComputerBridge.cs')], {stdio:'inherit',windowsHide:true});
  if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);
}
