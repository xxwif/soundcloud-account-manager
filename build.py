#!/usr/bin/env python3
"""Package the extension for Chrome and Firefox.

Usage:  python build.py
Output: dist/soundcloud-account-manager-<version>-chrome.zip   (Chrome Web Store)
        dist/soundcloud-account-manager-<version>-firefox.zip  (addons.mozilla.org)

Both packages share src/ and icons/. The Chrome package uses manifest.json;
the Firefox package uses manifest.firefox.json, renamed to manifest.json.
dist/ and *.zip are in .gitignore, so build output is never committed.
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
TARGETS = {"chrome": "manifest.json", "firefox": "manifest.firefox.json"}


def package_files():
    for folder in ("src", "icons"):
        for dirpath, _, names in os.walk(os.path.join(ROOT, folder)):
            for name in sorted(names):
                full = os.path.join(dirpath, name)
                yield full, os.path.relpath(full, ROOT).replace(os.sep, "/")


def main():
    os.makedirs(DIST, exist_ok=True)
    for target, manifest_name in TARGETS.items():
        with open(os.path.join(ROOT, manifest_name), encoding="utf-8") as fh:
            manifest = json.load(fh)
        out = os.path.join(
            DIST, f"soundcloud-account-manager-{manifest['version']}-{target}.zip"
        )
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(os.path.join(ROOT, manifest_name), "manifest.json")
            for full, rel in package_files():
                z.write(full, rel)
        print(out)


if __name__ == "__main__":
    main()
