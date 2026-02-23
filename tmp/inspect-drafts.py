import json, glob, os

shorts_dir = os.path.expanduser("~/.openzigs/director/drafts")
for f in sorted(glob.glob(os.path.join(shorts_dir, "*.json"))):
    with open(f) as fh:
        data = json.load(fh)
    m = data.get("manifest", {})
    comp = m.get("composition", {})
    if comp.get("height") == 1920:
        tid = os.path.basename(f).replace(".json", "")
        tl = m.get("timeline", [])
        print("Draft:", tid)
        print("  Title:", m.get("projectTitle"))
        print("  Composition:", comp)
        print("  Timeline entries:", len(tl))
        for i, e in enumerate(tl):
            etype = e.get("type")
            if etype == "overlay":
                comp_name = e.get("component")
                props = e.get("props", {})
                fs = props.get("fontSize")
                pos = props.get("position")
                sty = props.get("style")
                print(f"  [{i}] overlay: {comp_name}, fontSize={fs}, position={pos}, style={sty}")
                if comp_name == "SmartCaptions":
                    words = props.get("words", [])
                    print(f"       words count: {len(words)}")
                    if words:
                        print(f"       first: {words[0]}")
                        print(f"       last: {words[-1]}")
            else:
                title = e.get("title", "")
                script = (e.get("scriptText") or "")[:60]
                fm = e.get("fitMode", "N/A")
                sa = e.get("startAtFrame")
                dur = e.get("duration")
                print(f"  [{i}] {etype}: start={sa}, dur={dur}, fitMode={fm}")
                if title:
                    print(f"       title: {title}")
                if script:
                    print(f"       script: {script}")
