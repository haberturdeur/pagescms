"""Authenticated preview controller. Repository code runs only in disposable workers.

The operator supplies an allowlist mapping repositories to prebuilt worker images.
Workers read /input, emit a tar archive of the static site on stdout, and log to
stderr. Neither the Docker socket nor authentication secrets enter the worker.
"""
import concurrent.futures
import hmac
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import selectors
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_ARCHIVE = 100 * 1024 * 1024
MAX_EXPANDED = 300 * 1024 * 1024


def extract(archive, destination, strip_root=False):
    """Extract only regular files/directories, with bounded sizes and no traversal."""
    destination = Path(destination)
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as tar:
        for index, member in enumerate(tar):
            parts = PurePosixPath(member.name).parts
            if index > 20000 or member.name.startswith('/') or '..' in parts or '\\' in member.name:
                raise ValueError('Unsafe archive path')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Links and special files are not supported in previews')
            if strip_root:
                parts = parts[1:]
            if not parts:
                continue
            if '.git' in parts:
                raise ValueError('Git metadata is not permitted in preview archives')
            total += member.size
            if total > MAX_EXPANDED:
                raise ValueError('Expanded preview exceeds size limit')
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)


def worker_command(image, source, name, base_url):
    return ['docker', 'run', '--rm', '--name', name, '--init', '--network', 'none',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--user', '1000:1000', '--cpus', '2', '--memory', '1536m',
            '--memory-swap', '1536m', '--pids-limit', '128',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777',
            '--mount', f'type=bind,src={source},dst=/input,readonly',
            '--env', f'PREVIEW_BASE_URL={base_url}', image]


def run_worker(command, timeout=300):
    """Drain both pipes without allowing unbounded output or orphaned containers."""
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, logs = bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, 'output')
    selector.register(process.stderr, selectors.EVENT_READ, 'logs')
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise ValueError('Preview build exceeded five minutes')
            for key, _ in selector.select(1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == 'output':
                    output.extend(chunk)
                    if len(output) > MAX_ARCHIVE:
                        raise ValueError('Preview output exceeds size limit')
                else:
                    logs.extend(chunk)
                    logs[:] = logs[-8000:]
        if process.wait(timeout=max(1, deadline-time.monotonic())) != 0:
            # Build logs originate from repository code and contain no injected tokens.
            raise ValueError('Build failed:\n' + logs.decode(errors='replace')[-4000:])
        return bytes(output)
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()


class Controller:
    def __init__(self, root, public_url, repositories):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.public_url = public_url.rstrip('/')
        self.repositories = repositories
        self.lock = threading.Lock()
        self.jobs = {}
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        # Recover completed builds, but never resume a build with missing credentials.
        for file in self.root.glob('*/status.json'):
            try:
                data = json.loads(file.read_text())
                if data['status'] in ('queued', 'building'):
                    data.update(status='failed', error='Preview service restarted. Build again.')
                key = (data['repository'], data['branch'])
                if data.get('created', 0) >= self.jobs.get(key, {}).get('created', 0):
                    self.jobs[key] = data
            except (ValueError, KeyError):
                pass

    def status(self, repository, branch):
        with self.lock:
            return dict(self.jobs.get((repository, branch), {'status': 'idle'}))

    def update(self, key, job, **changes):
        with self.lock:
            job.update(changes)
            self.jobs[key] = job
            file = self.root / job['id'] / 'status.json'
            file.parent.mkdir(parents=True, exist_ok=True)
            temporary = file.with_suffix('.tmp')
            temporary.write_text(json.dumps(job))
            temporary.replace(file)

    def submit(self, repository, branch, sha, token):
        if repository not in self.repositories:
            raise ValueError('Repository is not enabled on this preview service')
        if not re.fullmatch('[0-9a-f]{40}', sha) or not branch or len(branch) > 1024:
            raise ValueError('Invalid preview reference')
        key = (repository, branch)
        with self.lock:
            existing = self.jobs.get(key)
            if existing and existing['status'] in ('queued', 'building'):
                return dict(existing)
            if sum(j['status'] in ('queued', 'building') for j in self.jobs.values()) >= 4:
                raise ValueError('Preview queue is full. Try again shortly.')
            # Unpredictable URL per build; no repository names or branch names in paths.
            job = {'id': secrets.token_hex(16), 'repository': repository, 'branch': branch,
                   'sha': sha, 'status': 'queued', 'created': time.time()}
            self.jobs[key] = job
        self.update(key, job)
        self.pool.submit(self.build, key, job, token)
        return dict(job)

    def build(self, key, job, token):
        folder = self.root / job['id']
        source = folder / 'source'
        name = 'pagescms-preview-' + job['id']
        try:
            self.update(key, job, status='building')
            url = f"https://api.github.com/repos/{job['repository']}/tarball/{job['sha']}"
            request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token,
                'User-Agent': 'PagesCMS-preview', 'Accept': 'application/vnd.github+json'})
            with urllib.request.urlopen(request, timeout=60) as response:
                archive = response.read(MAX_ARCHIVE + 1)
            del token, request
            if len(archive) > MAX_ARCHIVE:
                raise ValueError('Repository archive exceeds size limit')
            source.mkdir()
            extract(archive, source, strip_root=True)
            base_url = self.public_url + '/' + job['id'] + '/'
            result = run_worker(worker_command(self.repositories[job['repository']], str(source), name, base_url))
            output = folder / 'staging'
            output.mkdir()
            extract(result, output)
            if not (output / 'index.html').is_file():
                raise ValueError('Build did not produce index.html')
            output.rename(folder / 'public')
            self.update(key, job, status='ready', url=base_url)
        except Exception as error:
            message = str(error) if isinstance(error, ValueError) else 'Preview service could not complete the build. Try again.'
            self.update(key, job, status='failed', error=message)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            shutil.rmtree(source, ignore_errors=True)
            # Retain previews for seven days. Never touch an active job.
            with self.lock:
                active = {j['id'] for j in self.jobs.values() if j['status'] in ('queued', 'building')}
                folders = sorted((p for p in self.root.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
                excess = {p.name for p in folders[:-32]}
                for old in folders:
                    if old.name not in active and (old.name in excess or time.time()-old.stat().st_mtime > 7*86400):
                        shutil.rmtree(old)
                        for old_key, value in list(self.jobs.items()):
                            if value['id'] == old.name:
                                del self.jobs[old_key]


def serve(controller, secret):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_json(self, status, body):
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            self.api(True)

        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == '/build':
                return self.api(False)
            # Static content is served on a separate origin. No source, logs, or API secrets.
            path = urllib.parse.unquote(parsed.path)
            parts = PurePosixPath(path).parts[1:]
            if not parts or not re.fullmatch('[0-9a-f]{32}', parts[0]) or '..' in parts or '\\' in path:
                return self.send_error(404)
            root = controller.root / parts[0] / 'public'
            file = root.joinpath(*parts[1:])
            if file.is_dir():
                if not path.endswith('/'):
                    self.send_response(301); self.send_header('Location', parsed.path + '/'); self.end_headers(); return
                file = file / 'index.html'
            if not file.is_file() or root not in file.resolve().parents:
                return self.send_error(404)
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(file.stat().st_size))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Robots-Tag', 'noindex, nofollow, noarchive')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with file.open('rb') as source:
                shutil.copyfileobj(source, self.wfile)

        def api(self, post):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret):
                return self.send_json(401, {'message': 'Unauthorized'})
            try:
                if urllib.parse.urlsplit(self.path).path != '/build':
                    return self.send_error(404)
                if post:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size < 16384:
                        raise ValueError('Invalid request size')
                    body = json.loads(self.rfile.read(size))
                    result = controller.submit(body['repository'], body['branch'], body['sha'], body['token'])
                else:
                    query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                    repository, branch = query['repository'][0], query['branch'][0]
                    if repository not in controller.repositories:
                        raise ValueError('Repository is not enabled on this preview service')
                    result = controller.status(repository, branch)
                self.send_json(200, result)
            except (ValueError, KeyError, TypeError) as error:
                self.send_json(400, {'message': str(error)})
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()


if __name__ == '__main__':
    secret = os.environ['PREVIEW_SERVICE_TOKEN']
    if len(secret) < 32:
        raise ValueError('Use a random service token of at least 32 characters')
    controller = Controller(os.environ['PREVIEW_ROOT'], os.environ['PREVIEW_PUBLIC_URL'],
                            json.loads(os.environ['PREVIEW_REPOSITORIES']))
    for job in controller.jobs.values():
        if job.get('error') == 'Preview service restarted. Build again.' and re.fullmatch('[0-9a-f]{32}', job['id']):
            subprocess.run(['docker', 'rm', '-f', 'pagescms-preview-' + job['id']],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    serve(controller, secret)
