#!/usr/bin/env python3
"""Set the app version in version.js and sw.js together.

Usage:  python3 bump_version.py 1.1.0
Run this for every release, otherwise installed phones won't see the update.
"""
import re, sys, pathlib
if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
    sys.exit("Usage: python3 bump_version.py X.Y.Z")
v = sys.argv[1]
root = pathlib.Path(__file__).parent
for name, pat, rep in [("version.js", r"APP_VERSION = '[^']*'", f"APP_VERSION = '{v}'"),
                       ("sw.js", r"const RELEASE = '[^']*'", f"const RELEASE = '{v}'")]:
    f = root / name
    text, n = re.subn(pat, rep, f.read_text())
    if n != 1: sys.exit(f"Couldn't find the version in {name}")
    f.write_text(text)
print(f"Version set to {v} in version.js and sw.js")
