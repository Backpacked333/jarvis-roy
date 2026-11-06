"""Trusted, stdlib-only operations sent through docker exec; never run on the host."""
import base64
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time


def parts(path):
    if not isinstance(path, str) or len(path) > 240 or re.search(r"[\\\x00-\x1f\x7f:%]", path):
        raise ValueError("Unsafe path")
    result = path.split("/")
    if any(p in ("", ".", "..") for p in result):
        raise ValueError("Unsafe path")
    return result


def parent(path, create=False):
    segments = parts(path)
    fd = os.open("/workspace", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for p in segments[:-1]:
            if create:
                try:
                    os.mkdir(p, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, segments[-1]
    except BaseException:
        os.close(fd)
        raise


def read_file(path, limit):
    directory, name = parent(path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
    with os.fdopen(fd, "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("Only bounded regular single-link files are allowed")
        data = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
        if len(data) > limit or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("File changed during snapshot")
        return data


def write_file(path, data):
    directory, name = parent(path, True)
    try:
        # A fresh inode avoids following or mutating an existing hard link.
        temp = ".jarvis-" + os.urandom(16).hex()
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        try:
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                raise ValueError("Unsafe write target")
        except FileNotFoundError:
            pass
        os.rename(temp, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        os.close(directory)


def snapshot(request):
    files, size, entries = [], 0, 0
    for root, directories, names in os.walk("/workspace", followlinks=False):
        entries += len(directories) + len(names)
        if entries > 1024 or root.count("/") > 18:
            raise ValueError("Workspace tree limit exceeded")
        for name in directories:
            if not stat.S_ISDIR(os.lstat(os.path.join(root, name)).st_mode):
                raise ValueError("Symlink directory denied")
        for name in sorted(names):
            path = os.path.relpath(os.path.join(root, name), "/workspace")
            data = read_file(path, request["maxBytes"] - size)
            size += len(data)
            files.append({"path": path, "data": base64.b64encode(data).decode("ascii")})
            if len(files) > request["maxFiles"]:
                raise ValueError("Artifact file count exceeded")
    return sorted(files, key=lambda item: item["path"])


def check_environment():
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/workspace", "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1", "NPM_CONFIG_CACHE": "/tmp/npm-cache", "NPM_CONFIG_OFFLINE": "true",
            "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false", "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "COREPACK_ENABLE_NETWORK": "0"}


def main(request):
    op = request["op"]
    if op == "probe":
        if sys.version_info < (3, 10):
            raise ValueError("Python 3.10+ required")
        mounts = {line.split()[4]: line.split()[5].split(",") for line in open("/proc/self/mountinfo")}
        for path in ("/workspace", "/tmp"):
            if not {"rw", "nosuid", "nodev"}.issubset(mounts[path]):
                raise ValueError("Unsafe scratch mount")
        if request.get("coding"):
            for program in ("node", "npm", "cc", "c++", "make"):
                version = subprocess.run([program, "--version"], env=check_environment(), capture_output=True, check=True, timeout=5)
                if program == "node" and not version.stdout.startswith(b"v24."):
                    raise ValueError("Node 24 required")
        status = dict(line.split(":", 1) for line in open("/proc/self/status") if ":" in line)
        return {"uid": os.geteuid(), "noNewPrivs": status["NoNewPrivs"].strip(), "seccomp": status["Seccomp"].strip(),
                "workspaceNoexec": "noexec" in mounts["/workspace"], "temporaryNoexec": "noexec" in mounts["/tmp"],
                "caps": status["CapEff"].strip(),
                "memory": open("/sys/fs/cgroup/memory.max").read().strip(),
                "swap": open("/sys/fs/cgroup/memory.swap.max").read().strip(),
                "pids": open("/sys/fs/cgroup/pids.max").read().strip(),
                "cpu": open("/sys/fs/cgroup/cpu.max").read().strip()}
    if op == "write":
        data = base64.b64decode(request["data"], validate=True)
        if len(data) > request["maxBytes"]:
            raise ValueError("File byte limit exceeded")
        write_file(request["path"], data)
        return {"bytes": len(data)}
    if op == "read":
        return {"data": base64.b64encode(read_file(request["path"], request["maxBytes"])).decode("ascii")}
    if op == "snapshot":
        return snapshot(request)
    if op == "check":
        start = time.monotonic()
        child = subprocess.Popen(["/bin/sh", "-c", request["command"]], cwd="/workspace", start_new_session=True,
                                 env=check_environment())
        try:
            code = child.wait(timeout=request["timeoutMs"] / 1000)
        except subprocess.TimeoutExpired:
            code = 124
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        # Output goes to stderr; the final protocol response remains distinct.
        return {"exitCode": code, "elapsedMs": int((time.monotonic() - start) * 1000)}
    raise ValueError("Unknown sandbox operation")


if __name__ == "__main__":
    request = json.loads(sys.stdin.read(96 * 1024 * 1024))
    if request["op"] == "check":
        saved = os.dup(1)
        os.dup2(2, 1)
        result = main(request)
        os.dup2(saved, 1)
        os.close(saved)
    else:
        result = main(request)
    print(json.dumps(result, separators=(",", ":")))
    if request["op"] == "check":
        sys.exit(result["exitCode"] if result["exitCode"] >= 0 else 128 - result["exitCode"])
