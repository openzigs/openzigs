#!/usr/bin/env bash
curl -fsS http://127.0.0.1:5007/capabilities > /tmp/caps.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/caps.json'))
print("audio_modes:", d.get("audio_modes"))
m = [x for x in d.get("models", []) if x.get("key") == "ltxv-2-22b-distilled"]
print("ltx2 entry:", m)
PY
echo "--- /models ---"
curl -fsS http://127.0.0.1:5007/models > /tmp/models.json || true
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/models.json'))
    print(json.dumps(d, indent=2)[:2000])
except Exception as e:
    print("models endpoint err:", e)
PY
