"""PIA ML service (Cloudflare Python Worker), hardened copy of pia-ml-api.

THE MODEL AND THE INFERENCE ARE THE ORIGINAL ONES, copied verbatim: everything
between the "BEGIN VERBATIM" and "END VERBATIM" markers is byte-for-byte the
original src/entry.py (tests/test_ml_service.py checks that against
ORIGINAL_entry.py). Only the way the service is exposed changed:

  * server-to-server only: Authorization: Bearer <ML_TOKEN> is required, and no
    CORS headers are sent, so a browser on any website can neither call it nor
    read it. The only intended caller is the Supabase Edge Function
    `learning-profile`.
  * no online learning: the original update_centroid()/save_model() and the
    client's "learn" flag are gone. Nothing a request says can change the model,
    and the service never writes to KV.
  * strict input: exactly the seven numeric features, range checked. Any other
    field (a name, an email, "learn", ...) is rejected, not ignored.
  * minimal output: only {"profile", "confidence"}. No centroids, no distances,
    no GET /model.
  * nothing is logged.

Fails closed: without the ML_TOKEN secret configured, every request is refused.
"""
import hmac
import json
import math
from urllib.parse import urlparse

from workers import WorkerEntrypoint, Response

# ===== BEGIN VERBATIM (original pia-ml-api src/entry.py) =====
# New model key so this version starts from clean centroids instead of reusing
# centroids that may have moved during earlier manual testing.
MODEL_KEY = "pia_online_kmeans_v2_human_reactions"

# These are normalized "performance strength" dimensions.
FEATURES = [
    "accuracy_strength",
    "attempt_strength",
    "independence_strength",
    "correct_efficiency_strength",
    "correct_streak_strength",
    "wrong_streak_control",
]

# Accuracy and wrong streak are deliberately more influential than speed.
# Speed is only a bonus for correct responses.
FEATURE_WEIGHTS = [
    3.00,  # accuracy
    1.50,  # attempts needed
    1.00,  # independence from hints, only rewarded with accuracy
    0.75,  # speed/efficiency on correct answers only
    1.50,  # correct streak
    2.25,  # control of wrong streak
]

# Cold-start centers for the three clusters.
# These are starting prototypes; they are NOT student labels.
# If online learning is enabled later, the centroids can update incrementally.
DEFAULT_MODEL = {
    "centroids": [
        # Struggling-like performance pattern
        [0.20, 0.35, 0.10, 0.20, 0.10, 0.25],

        # Average-like performance pattern
        [0.60, 0.65, 0.40, 0.55, 0.45, 0.70],

        # Outstanding-like performance pattern
        [0.90, 0.90, 0.85, 0.85, 0.90, 0.95],
    ],

    # Start with a little inertia so accidental test traffic does not move a
    # centroid too aggressively if learning is enabled later.
    "counts": [12, 12, 12],
    "updates": 0,
    "version": 2,
}


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def as_float(data, key, default=0.0):
    try:
        return float(data.get(key, default))
    except (TypeError, ValueError):
        return default


def feature_vector(data):
    accuracy = clamp(
        as_float(data, "recent_accuracy", 0.5)
    )

    # 1 attempt is strongest. 5+ attempts reaches the bottom of this feature.
    average_attempts = max(
        1.0,
        as_float(data, "average_attempts", 1.0)
    )
    attempt_strength = 1.0 - clamp(
        (average_attempts - 1.0) / 4.0
    )

    hint_rate = clamp(
        as_float(data, "hint_rate", 0.0)
    )

    # IMPORTANT:
    # "No hint" should not look impressive when the learner is mostly wrong.
    # Independence therefore only becomes strong when it is paired with
    # demonstrated correctness.
    independence_strength = accuracy * (1.0 - hint_rate)

    # Frontend v2 sends an efficiency score calculated ONLY from correct
    # responses. If an older frontend calls this worker, derive a fallback
    # from response time but only when some answers are correct.
    if "correct_response_efficiency" in data:
        correct_efficiency = clamp(
            as_float(data, "correct_response_efficiency", 0.0)
        )
    else:
        average_response_time = max(
            0.0,
            as_float(data, "average_response_time", 120.0)
        )
        correct_efficiency = (
            1.0 / (1.0 + average_response_time / 30.0)
            if accuracy > 0
            else 0.0
        )

    correct_streak_strength = clamp(
        as_float(data, "consecutive_correct", 0.0) / 5.0
    )

    wrong_streak_control = 1.0 - clamp(
        as_float(data, "consecutive_wrong", 0.0) / 5.0
    )

    return [
        accuracy,
        attempt_strength,
        independence_strength,
        correct_efficiency,
        correct_streak_strength,
        wrong_streak_control,
    ]


def weighted_distance(a, b):
    total = 0.0

    for value, center, weight in zip(
        a,
        b,
        FEATURE_WEIGHTS
    ):
        total += weight * ((value - center) ** 2)

    return math.sqrt(total)


def nearest_cluster(vector, centroids):
    distances = [
        weighted_distance(vector, centroid)
        for centroid in centroids
    ]

    cluster = min(
        range(len(distances)),
        key=lambda i: distances[i]
    )

    ordered = sorted(distances)

    if len(ordered) > 1 and ordered[1] > 0:
        confidence = clamp(
            (ordered[1] - ordered[0]) / ordered[1]
        )
    else:
        confidence = 1.0

    return cluster, distances, confidence


def weighted_performance_score(vector):
    numerator = sum(
        value * weight
        for value, weight in zip(vector, FEATURE_WEIGHTS)
    )

    denominator = sum(FEATURE_WEIGHTS)

    return numerator / denominator


def profile_map(centroids):
    # K-Means cluster numbers themselves have no semantic meaning.
    # Order the learned centers from weakest performance pattern to strongest.
    ranked = sorted(
        range(len(centroids)),
        key=lambda i: weighted_performance_score(
            centroids[i]
        )
    )

    return {
        ranked[0]: "struggling",
        ranked[1]: "average",
        ranked[2]: "outstanding",
    }

# ===== END VERBATIM =====


# The only fields a request may carry, with the range each must lie in.
ALLOWED = {
    "recent_accuracy": (0.0, 1.0),
    "average_attempts": (1.0, 50.0),
    "hint_rate": (0.0, 1.0),
    "average_response_time": (0.0, 3600.0),
    "correct_response_efficiency": (0.0, 1.0),
    "consecutive_correct": (0.0, 100.0),
    "consecutive_wrong": (0.0, 100.0),
}
MAX_BODY_BYTES = 1024


def clean_features(data):
    """The seven numbers, or None if the body is anything else."""
    if not isinstance(data, dict) or set(data.keys()) != set(ALLOWED.keys()):
        return None
    out = {}
    for key, (low, high) in ALLOWED.items():
        value = data[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not math.isfinite(value) or value < low or value > high:
            return None
        out[key] = float(value)
    return out


def valid_model(model):
    try:
        centroids = model["centroids"]
        return (
            len(centroids) == 3
            and all(len(c) == len(FEATURES) for c in centroids)
            and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                    and math.isfinite(v) for c in centroids for v in c)
        )
    except Exception:
        return False


class Default(WorkerEntrypoint):

    def reply(self, payload, status=200):
        # Deliberately NO Access-Control-* headers: browsers cannot use this.
        return Response(
            json.dumps(payload),
            status=status,
            headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
        )

    def authorised(self, request):
        expected = getattr(self.env, "ML_TOKEN", None)
        if not expected:
            return False
        header = request.headers.get("Authorization") or ""
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(
            header[len("Bearer "):].encode("utf-8"), str(expected).encode("utf-8"))

    async def load_model(self):
        """The model, READ ONLY. If a KV namespace named ML_MODEL is bound it may
        hold the centres (seed it once from the old service's GET /model, out of
        band); otherwise the original cold-start centres are used. Never written."""
        try:
            kv = getattr(self.env, "ML_MODEL", None)
            raw = await kv.get(MODEL_KEY) if kv else None
            if raw is not None:
                model = json.loads(str(raw))
                if valid_model(model):
                    return model
        except Exception:
            pass
        return json.loads(json.dumps(DEFAULT_MODEL))

    async def fetch(self, request):
        path = urlparse(request.url).path.rstrip("/") or "/"

        if request.method != "POST" or path != "/predict":
            return self.reply({"error": "Not found."}, status=404)

        if not self.authorised(request):
            return self.reply({"error": "Unauthorised."}, status=401)

        try:
            text = await request.text()
            if len(text.encode("utf-8")) > MAX_BODY_BYTES:
                return self.reply({"error": "Request too large."}, status=413)
            features = clean_features(json.loads(text))
        except Exception:
            features = None
        if features is None:
            return self.reply({"error": "Send exactly the seven numeric features."}, status=400)

        vector = feature_vector(features)
        model = await self.load_model()
        cluster, _distances, confidence = nearest_cluster(vector, model["centroids"])
        profile = profile_map(model["centroids"])[cluster]

        return self.reply({"profile": profile, "confidence": round(confidence, 4)})
