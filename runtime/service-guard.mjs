// Runs one local service in this process and ties its life to the app that
// launched it:  node service-guard.mjs <entry> [arguments…]
//
// With JARVIS_LIFELINE=stdin the launcher keeps the write end of this
// process's standard input open and never writes to it. If the launcher goes
// away for any reason, including a crash, the operating system closes that
// pipe and the service stops itself instead of holding its port forever.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('Usage: node service-guard.mjs <entry> [arguments…]\n');
  process.exit(2);
}
// The service must see itself as the direct entry point.
process.argv.splice(1, 1);

if (process.env.JARVIS_LIFELINE === 'stdin') {
  let ended = false;
  const launcherGone = () => {
    if (ended) return;
    ended = true;
    process.stderr.write('The launching application is gone; stopping this service.\n');
    // The service's own handler performs an orderly stop. If it never finishes, stop anyway.
    setTimeout(() => process.exit(1), 90_000).unref();
    process.kill(process.pid, 'SIGTERM');
  };
  process.stdin.once('end', launcherGone);
  process.stdin.once('close', launcherGone);
  process.stdin.once('error', launcherGone);
  process.stdin.resume();
  // Watching the lifeline must not keep a service alive after its own orderly stop.
  process.stdin.unref?.();
}

await import(pathToFileURL(resolve(entry)).href);
