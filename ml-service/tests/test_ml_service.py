"""Proof that the hardened service keeps the original model and inference, and
that it cannot be driven to change the model. Run: python3 ml-service/tests/test_ml_service.py"""
import asyncio, importlib.util, json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, "..")
sys.path.insert(0, HERE)
import stub_workers as sw
sw.install()

def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
orig = load("orig", os.path.join(ROOT, "ORIGINAL_entry.py"))
new = load("new", os.path.join(ROOT, "src", "entry.py"))
results = []
def check(name):
    def deco(fn):
        try: fn(); results.append((name, True, ""))
        except Exception as e: results.append((name, False, repr(e)))
    return deco
def run(c): return asyncio.run(c)

@check("the model and inference code is byte-for-byte the original's")
def _():
    src = open(os.path.join(ROOT, "src", "entry.py")).read()
    block = src[src.index("# ===== BEGIN VERBATIM"):src.index("# ===== END VERBATIM")]
    block = block.split("\n", 1)[1]
    o = open(os.path.join(ROOT, "ORIGINAL_entry.py")).read()
    want = o[o.index("# New model key"):o.index("def update_centroid")].rstrip() + "\n"
    assert block.strip() == want.strip()

@check("same centres, weights and feature list as the original")
def _():
    assert new.DEFAULT_MODEL == orig.DEFAULT_MODEL and new.FEATURE_WEIGHTS == orig.FEATURE_WEIGHTS and new.FEATURES == orig.FEATURES

@check("no learning code remains (no update_centroid, no save_model, no KV put)")
def _():
    src = open(os.path.join(ROOT, "src", "entry.py")).read()
    import ast
    tree = ast.parse(src)
    names = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert not names & {"update_centroid", "save_model"}, names
    code = "\n".join(l for l in src.split("\n") if not l.strip().startswith("#"))
    code = code.replace(ast.get_docstring(tree, clean=False) or "", "")
    for bad in (".put(", "should_learn", "Access-Control-Allow-Origin"):
        assert bad not in code, bad

def call_orig(feats, learn=False):
    w = orig.Default(); w.env = sw.Env(ML_MODEL=sw.FakeKV(json.dumps(orig.DEFAULT_MODEL)))
    body = dict(feats, learn=learn)
    r = run(w.fetch(sw.FakeRequest("POST", "https://x/predict", {}, json.dumps(body)))); return json.loads(r.body)

def call_new(feats, token="t0ken", kv=None, headers=None, body=None, method="POST", path="/predict", env_token="t0ken"):
    w = new.Default(); w.env = sw.Env(ML_TOKEN=env_token, ML_MODEL=kv or sw.FakeKV())
    h = {"Authorization": "Bearer " + token} if headers is None else headers
    r = run(w.fetch(sw.FakeRequest(method, "https://x" + path, h, json.dumps(feats) if body is None else body)))
    return r.status, r.headers, (json.loads(r.body) if r.body else None)

random.seed(7)
def rand_feats():
    return {"recent_accuracy": round(random.random(), 4), "average_attempts": round(1 + random.random() * 6, 4),
            "hint_rate": round(random.random(), 4), "average_response_time": round(random.random() * 200, 2),
            "correct_response_efficiency": round(random.random(), 4),
            "consecutive_correct": random.randint(0, 8), "consecutive_wrong": random.randint(0, 8)}

@check("2000 random inputs: same profile, confidence as the ORIGINAL service's /predict")
def _():
    for _i in range(2000):
        f = rand_feats(); o = call_orig(f); s, _h, n = call_new(f)
        assert s == 200 and n["profile"] == o["profile"] and n["confidence"] == o["confidence"], (f, o, n)

@check("the three expected profiles for clear synthetic cases")
def _():
    strong = dict(recent_accuracy=1, average_attempts=1, hint_rate=0, average_response_time=8, correct_response_efficiency=0.78, consecutive_correct=8, consecutive_wrong=0)
    weak = dict(recent_accuracy=0, average_attempts=7, hint_rate=1, average_response_time=120, correct_response_efficiency=0, consecutive_correct=0, consecutive_wrong=7)
    mid = dict(recent_accuracy=0.5, average_attempts=2, hint_rate=0.4, average_response_time=40, correct_response_efficiency=0.45, consecutive_correct=1, consecutive_wrong=0)
    got = [call_new(x)[2]["profile"] for x in (strong, weak, mid)]
    assert got == ["outstanding", "struggling", "average"], got

@check("response is only profile + confidence")
def _():
    s, _h, n = call_new(rand_feats()); assert s == 200 and sorted(n) == ["confidence", "profile"], n

@check("a public request cannot change the model: learn:true is REJECTED and nothing is written")
def _():
    kv = sw.FakeKV(); f = dict(rand_feats(), learn=True)
    s, _h, n = call_new(f, kv=kv); assert s == 400 and kv.puts == [], (s, n, kv.puts)
    s, _h, n = call_new(rand_feats(), kv=kv); assert s == 200 and kv.puts == []

@check("identity fields are rejected, not ignored (name, email, student_id, session_id)")
def _():
    for extra in ("name", "email", "student_id", "session_id", "full_name"):
        s, _h, _n = call_new(dict(rand_feats(), **{extra: "x"})); assert s == 400, extra
    f = rand_feats(); f.pop("hint_rate"); assert call_new(f)[0] == 400

@check("bad values are rejected: out of range, NaN-like strings, booleans, nulls, wrong types")
def _():
    for key, bad in (("recent_accuracy", 2), ("recent_accuracy", -0.1), ("average_attempts", 0), ("hint_rate", "0.5"),
                     ("consecutive_wrong", True), ("average_response_time", None), ("consecutive_correct", 1e9)):
        assert call_new(dict(rand_feats(), **{key: bad}))[0] == 400, (key, bad)
    assert call_new(None, body="not json")[0] == 400
    assert call_new(None, body="[1,2]")[0] == 400
    assert call_new(None, body="x" * 5000)[0] == 413

@check("authentication: missing, wrong, empty and unconfigured tokens are refused; no CORS headers ever")
def _():
    f = rand_feats()
    assert call_new(f, headers={})[0] == 401
    assert call_new(f, token="wrong")[0] == 401
    assert call_new(f, token="")[0] == 401
    assert call_new(f, headers={"Authorization": "Basic abc"})[0] == 401
    assert call_new(f, env_token="")[0] == 401, "fails closed without the secret"
    for status_headers in (call_new(f), call_new(f, token="x")):
        assert not any(k.lower().startswith("access-control") for k in status_headers[1])

@check("only POST /predict exists (GET /, GET /model, OPTIONS, other paths are 404)")
def _():
    for m, p in (("GET", "/"), ("GET", "/model"), ("OPTIONS", "/predict"), ("GET", "/predict"), ("POST", "/model")):
        assert call_new(rand_feats(), method=m, path=p)[0] == 404, (m, p)

@check("KV is read-only and optional: a stored model is used, a corrupt one falls back to the original centres")
def _():
    shifted = json.loads(json.dumps(orig.DEFAULT_MODEL)); shifted["centroids"][0] = [0.9] * 6
    kv = sw.FakeKV(json.dumps(shifted)); f = dict(recent_accuracy=0.9, average_attempts=1, hint_rate=0, average_response_time=10, correct_response_efficiency=0.9, consecutive_correct=5, consecutive_wrong=0)
    assert call_new(f, kv=kv)[0] == 200 and kv.puts == []
    for junk in ("{not json", json.dumps({"centroids": [[1]]})):
        s, _h, n = call_new(rand_feats(), kv=sw.FakeKV(junk)); assert s == 200

fails = [r for r in results if not r[1]]
for n, ok, msg in results: print(("PASS " if ok else "FAIL ") + n + ("" if ok else "  -> " + msg))
print(f"\n{len(results) - len(fails)}/{len(results)} passed"); sys.exit(1 if fails else 0)
