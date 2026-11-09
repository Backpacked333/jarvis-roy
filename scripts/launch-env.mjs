import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function environmentFor(target, source = process.env) {
  if (!['ui', 'runtime', 'bridge'].includes(target)) throw new Error('Unknown launch target.');
  const result = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  const names = ['HOME', 'TMPDIR', 'USER', 'LOGNAME', 'JARVIS_LOCAL_TOKEN'];
  if (target !== 'runtime') names.push('JARVIS_NATIVE_TOKEN');
  names.push('JARVIS_ENABLE_ASSISTANT', 'JARVIS_ENABLE_KNOWLEDGE', 'JARVIS_ENABLE_MEMORY',
    'JARVIS_ENABLE_SEMANTIC_RETRIEVAL', 'JARVIS_ENABLE_RESEARCH', 'JARVIS_ENABLE_VOICE_APPROVAL');
  if (target !== 'ui') names.push('JARVIS_DATA_DIR', 'JARVIS_MODEL', 'JARVIS_NATIVE_HELPER',
    'JARVIS_ENABLE_DESKTOP', 'JARVIS_ENABLE_TERMINAL', 'JARVIS_ENABLE_APPLE_SERVICES',
    'TAVILY_API_KEY', 'HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN', 'JARVIS_ALLOW_HOME_ASSISTANT_HTTP');
  if (target !== 'ui') names.push('AI_GATEWAY_API_KEY');
  if (target !== 'ui') names.push('JARVIS_DEEP_MODEL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR');
  if (target === 'bridge') names.push('ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
    'JARVIS_WORKER_PYTHON', 'JARVIS_WORKER_IMAGE', 'JARVIS_DOCKER_BINARY');
  for (const name of names) if (typeof source[name] === 'string') result[name] = source[name];
  if (target === 'runtime') Object.assign(result, { HOST: '127.0.0.1', PORT: '39201' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Launch target and absolute executable are required.');
  const child = spawn(command, args, { env: environmentFor(target), stdio: 'inherit', shell: false });
  let shutdownTimer;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    child.kill(signal);
    shutdownTimer ??= setTimeout(() => {
      console.error('Local process shutdown timed out; resource reconciliation is required on restart.');
      child.kill('SIGKILL');
    }, 35_000);
  });
  child.on('error', () => { console.error('Unable to start the configured local executable.'); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(shutdownTimer); process.exitCode = code ?? 1; });
}
