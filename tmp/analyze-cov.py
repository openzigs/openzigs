import json

with open("coverage/coverage-final.json") as f:
    data = json.load(f)

BASE = "/Users/matthewcronin/Development/openzigs/"
results = []
for filepath, info in data.items():
    rel = filepath.replace(BASE, "")
    stmts = info.get("s", {})
    total = len(stmts)
    covered = sum(1 for v in stmts.values() if v > 0)
    uncovered = total - covered
    pct = (covered / total * 100) if total > 0 else 100
    if rel.startswith("src/") and ".test." not in rel:
        results.append((uncovered, total, pct, rel))

results.sort(key=lambda x: -x[0])
total_stmts = sum(r[1] for r in results)
total_covered = sum(r[1] - r[0] for r in results)
print(f"Backend src (non-test): {len(results)} files")
print(f"Stmts: {total_stmts}, covered: {total_covered}, pct: {total_covered/total_stmts*100:.1f}%")

# Overall including UI
all_results = []
for filepath, info in data.items():
    rel = filepath.replace(BASE, "")
    stmts = info.get("s", {})
    total = len(stmts)
    covered = sum(1 for v in stmts.values() if v > 0)
    if ".test." not in rel:
        all_results.append((total, covered))
at = sum(r[0] for r in all_results)
ac = sum(r[1] for r in all_results)
print(f"All non-test: {len(all_results)} files, stmts: {at}, covered: {ac}, pct: {ac/at*100:.1f}%")

need_covered = int(at * 0.8)
gap = need_covered - ac
print(f"Need {need_covered} covered for 80% overall, gap: {gap} statements")
need_covered_src = int(total_stmts * 0.8)
gap_src = need_covered_src - total_covered
print(f"Need {need_covered_src} covered for 80% src-only, gap: {gap_src} statements")

print()
print(f"{'Uncov':>6} {'Total':>6} {'Pct':>6}  File")
for uncov, total, pct, fp in results[:35]:
    print(f"{uncov:>6} {total:>6} {pct:>5.1f}%  {fp}")
