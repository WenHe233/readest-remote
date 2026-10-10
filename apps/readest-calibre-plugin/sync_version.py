__license__ = 'AGPL v3'
__copyright__ = '2026, Bilingify LLC'

"""Keep PLUGIN_VERSION in step with apps/readest-app/package.json.

The plugin is installed into calibre as a standalone zip, so its version has
to be a literal in `__init__.py` rather than something read at runtime. That
literal drifts the moment the app is bumped, and a drifted value is what
calibre then shows in Preferences > Plugins. `make zip` runs this first, and
release.yml stamps releases from the same package.json.

Build-time only: not part of FILES, so it never ships inside the zip.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_JSON = os.path.join(HERE, os.pardir, 'readest-app', 'package.json')
INIT_PY = os.path.join(HERE, '__init__.py')
PATTERN = re.compile(r'^PLUGIN_VERSION = \((\d+), (\d+), (\d+)(?:, (\d+))?\)', re.MULTILINE)


def app_version(path=PACKAGE_JSON):
    """Calibre tuple from the app version, including the Remote revision."""
    with open(path, encoding='utf-8') as handle:
        raw = json.load(handle)['version']
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-r(\d+))?', raw)
    if not match:
        raise ValueError('Unsupported release version: %s' % raw)
    parts = [int(part) for part in match.groups() if part is not None]
    return tuple(parts)


def plugin_version(path=INIT_PY):
    """Three- or four-part version currently written into `path`, or None."""
    with open(path, encoding='utf-8') as handle:
        match = PATTERN.search(handle.read())
    return tuple(int(group) for group in match.groups() if group is not None) if match else None


def sync(path=INIT_PY, version=None):
    """Rewrite PLUGIN_VERSION when it has drifted. True if the file changed."""
    if version is None:
        version = app_version()
    with open(path, encoding='utf-8') as handle:
        source = handle.read()
    replacement = 'PLUGIN_VERSION = (%s)' % ', '.join(str(part) for part in version)
    updated = PATTERN.sub(replacement, source, count=1)
    if updated == source:
        return False
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(updated)
    return True


if __name__ == '__main__':
    target = app_version()
    changed = sync(version=target)
    print(
        'PLUGIN_VERSION %s: %s'
        % ('updated' if changed else 'already', '.'.join(str(p) for p in target))
    )
