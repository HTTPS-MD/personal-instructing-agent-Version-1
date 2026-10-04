"""TEST HARNESS ONLY: a stand-in for Cloudflare's `workers` module so the Worker's
Python can run on a laptop. Not part of the deployed service."""
import sys, types


class Response:
    def __init__(self, body="", status=200, headers=None):
        self.body, self.status, self.headers = body, status, dict(headers or {})


class WorkerEntrypoint:
    env = None


def install():
    m = types.ModuleType("workers")
    m.WorkerEntrypoint, m.Response = WorkerEntrypoint, Response
    sys.modules["workers"] = m


class FakeKV:
    """Records every write so tests can prove the service never writes."""
    def __init__(self, stored=None):
        self.stored, self.puts = stored, []
    async def get(self, key):
        return self.stored
    async def put(self, key, value):
        self.puts.append((key, value))


class FakeRequest:
    def __init__(self, method="POST", url="https://ml.example/predict", headers=None, body=""):
        self.method, self.url, self.headers, self._body = method, url, headers or {}, body
    async def text(self):
        return self._body
    async def json(self):
        import json
        return json.loads(self._body)


class Env:
    def __init__(self, **kw):
        self.__dict__.update(kw)
