import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function environmentFor(target, source = process.env) {
  if (!['ui', 'runtime', 'bridge'].includes(target)) throw new Error('Unknown launch target.');
  const result = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  const names = ['HOME', 'TMPDIR', 'USER', 'LOGNAME', 'JARVIS_LOCAL_TOKEN'];
  if (target !== 'ui') names.push('JARVIS_DATA_DIR', 'JARVIS_MODEL', 'JARVIS_NATIVE_HELPER',
    'JARVIS_ENABLE_DESKTOP', 'JARVIS_ENABLE_TERMINAL', 'JARVIS_ENABLE_APPLE_SERVICES',
    'TAVILY_API_KEY', 'HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN', 'JARVIS_ALLOW_HOME_ASSISTANT_HTTP');
  if (target === 'runtime') names.push('AI_GATEWAY_API_KEY');
  for (const name of names) if (typeof source[name] === 'string') result[name] = source[name];
  if (target === 'runtime') Object.assign(result, { HOST: '127.0.0.1', PORT: '39201' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Launch target and absolute executable are required.');
  const child = spawn(command, args, { env: environmentFor(target), stdio: 'inherit', shell: false });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Unable to start the configured local executable.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
