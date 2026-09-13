"""Run an isolated, disposable container without Google credentials or user data."""
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

name = 'journal-smoke-' + uuid.uuid4().hex[:10]
image = 'journal-backend:local'
subprocess.run([
    'docker', 'run', '--rm', '-d', '--name', name,
    '-p', '127.0.0.1::8080',
    '-e', 'DATA_BACKEND=sqlite',
    '-e', 'APP_ORIGIN=http://localhost:8080', image,
], check=True, capture_output=True)
try:
    address = subprocess.check_output(['docker', 'port', name, '8080'], text=True).strip()
    def request(path):
        req = urllib.request.Request('http://' + address + path, headers={'Host': 'localhost:8080'})
        try:
            with urllib.request.urlopen(req, timeout=2) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()
    for attempt in range(40):
        try:
            status, body = request('/healthz')
            assert status == 200 and json.loads(body) == {'status': 'ok'}
            break
        except OSError:
            time.sleep(.25)
    else:
        raise RuntimeError('Container did not become ready')
    for path, expected in [('/api/overview', 401), ('/', 404), ('/.env', 404), ('/src/models.ts', 404)]:
        assert request(path)[0] == expected, path
    check = """const fs=require('node:fs');
      if(process.getuid()===0) throw Error('root user');
      for(const path of ['.env','migration-source','dist','src/App.tsx']) {
        if(fs.existsSync('/app/'+path)) throw Error('Unexpected file: '+path);
      }
      console.log('PASS: non-root image, no secrets/snapshots/frontend UI');"""
    subprocess.run(['docker', 'exec', name, 'node', '-e', check], check=True)
    print('PASS: health endpoint, protected API and backend-only routes')
finally:
    subprocess.run(['docker', 'stop', '--time', '5', name], check=True, capture_output=True)
