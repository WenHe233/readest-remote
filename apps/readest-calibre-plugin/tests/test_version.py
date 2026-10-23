import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from sync_version import app_version, plugin_version, sync  # noqa: E402


class PluginVersionTest(unittest.TestCase):
    def test_committed_version_matches_the_app(self):
        # The zip ships PLUGIN_VERSION as a literal, so a stale value means
        # every local build installs into calibre under the wrong version.
        # release.yml stamps releases from this same package.json.
        self.assertEqual(plugin_version(), app_version())

    def test_remote_revision_is_the_fourth_calibre_version_part(self):
        version = app_version(self.write_package('{"version":"0.12.12-r1"}'))
        self.assertEqual(version, (0, 12, 12, 1))
        self.assertTrue(all(isinstance(part, int) for part in version))

    def test_upstream_version_remains_a_three_part_tuple(self):
        path = self.write_package('{"version":"0.12.2"}')
        self.assertEqual(app_version(path), (0, 12, 2))

    def test_experimental_revision_is_a_numeric_calibre_version(self):
        first = app_version(self.write_package('{"version":"0.12.12-x1"}'))
        second = app_version(self.write_package('{"version":"0.12.12-x2"}'))
        self.assertEqual(first, (0, 12, 12, 1))
        self.assertGreater(second, first)

    def test_invalid_experimental_versions_are_rejected(self):
        for version in ['0.12.12-x0', '0.12.12-x01', '0.12.12-x1.1']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                app_version(self.write_package('{"version":"%s"}' % version))

    def write_package(self, body):
        fd, path = tempfile.mkstemp(suffix='.json')
        os.close(fd)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(body)
        self.addCleanup(os.unlink, path)
        return path


class SyncTest(unittest.TestCase):
    def write(self, body):
        fd, path = tempfile.mkstemp(suffix='.py')
        os.close(fd)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(body)
        self.addCleanup(os.unlink, path)
        return path

    def test_rewrites_a_stale_version(self):
        path = self.write("NAME = 'x'\nPLUGIN_VERSION = (0, 1, 0)\nOTHER = 1\n")
        self.assertTrue(sync(path, (0, 11, 20)))
        self.assertEqual(plugin_version(path), (0, 11, 20))

    def test_is_idempotent(self):
        path = self.write('PLUGIN_VERSION = (0, 11, 20)\n')
        self.assertFalse(sync(path, (0, 11, 20)))

    def test_leaves_the_rest_of_the_file_alone(self):
        path = self.write(
            "HEAD = 1\nPLUGIN_VERSION = (0, 1, 0)\nTAIL = 'PLUGIN_VERSION = (9, 9, 9)'\n"
        )
        sync(path, (1, 2, 3))
        with open(path, encoding='utf-8') as f:
            body = f.read()
        self.assertIn('HEAD = 1', body)
        self.assertIn("TAIL = 'PLUGIN_VERSION = (9, 9, 9)'", body)
        self.assertIn('PLUGIN_VERSION = (1, 2, 3)', body)


if __name__ == '__main__':
    unittest.main()
