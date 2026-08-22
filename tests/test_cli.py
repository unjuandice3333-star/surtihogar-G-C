import os
import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import tempfile
import json
import pathspec

# Import local modules
from code_merger.cli import (
    parse_args,
    read_gitignore_rules,
    should_ignore,
    is_text_file,
    load_config,
    validate_user_config,
    generate_patch,
    apply_patch_file
)
from code_merger.models import (
    RepoContext,
    FileContent,
    Modification,
    Hunk,
    PathSpecWithPattern
)

class TestCLI(unittest.TestCase):
    def test_parse_args(self):
        # Test default arguments
        args = parse_args(["repo_path"])
        self.assertEqual(args.repo_path, "repo_path")
        self.assertFalse(args.all)
        self.assertFalse(args.git_only)
        self.assertFalse(args.no_gitignore)
        self.assertIsNone(args.include)
        self.assertIsNone(args.exclude)
        self.assertIsNone(args.patch)
        self.assertIsNone(args.config)
        self.assertFalse(args.quiet)

        # Test flags and options
        args = parse_args([
            "repo_path",
            "--all",
            "--git-only",
            "--no-gitignore",
            "--include", "src/**/*.py",
            "--exclude", "tests/**/*.py",
            "--patch", "patch.diff",
            "--config", "custom_config.json",
            "--quiet"
        ])
        self.assertEqual(args.repo_path, "repo_path")
        self.assertTrue(args.all)
        self.assertTrue(args.git_only)
        self.assertTrue(args.no_gitignore)
        self.assertEqual(args.include, "src/**/*.py")
        self.assertEqual(args.exclude, "tests/**/*.py")
        self.assertEqual(args.patch, "patch.diff")
        self.assertEqual(args.config, "custom_config.json")
        self.assertTrue(args.quiet)

    def test_read_gitignore_rules(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gitignore_path = Path(tmpdir) / ".gitignore"
            with open(gitignore_path, "w", encoding="utf-8") as f:
                f.write("*.pyc\n/node_modules/\n# a comment\n\n  \n")
            
            rules = read_gitignore_rules(Path(tmpdir))
            self.assertEqual(len(rules), 2)
            self.assertIn("*.pyc", rules)
            self.assertIn("/node_modules/", rules)

            # Test no .gitignore present
            no_rules = read_gitignore_rules(Path(tmpdir) / "empty_dir")
            self.assertEqual(len(no_rules), 0)

    def test_should_ignore(self):
        # Test standard gitignore rules
        gitignore_lines = ["*.pyc", "/node_modules/", ".git/"]
        spec = pathspec.PathSpec.from_lines("gitwildmatch", gitignore_lines)

        self.assertTrue(should_ignore("test.pyc", spec))
        self.assertTrue(should_ignore("node_modules/index.js", spec))
        self.assertTrue(should_ignore(".git/config", spec))
        self.assertFalse(should_ignore("src/main.py", spec))

        # Test custom matchers (includes/excludes)
        include_patterns = [PathSpecWithPattern(pathspec.PathSpec.from_lines("gitwildmatch", ["*.py"]), "*.py")]
        exclude_patterns = [PathSpecWithPattern(pathspec.PathSpec.from_lines("gitwildmatch", ["test_*.py"]), "test_*.py")]

        # Match in inclusion, not in exclusion -> keep (should_ignore = False)
        self.assertFalse(should_ignore("src/main.py", spec, include_patterns, exclude_patterns))
        # Match in inclusion, but also in exclusion -> ignore (should_ignore = True)
        self.assertTrue(should_ignore("src/test_main.py", spec, include_patterns, exclude_patterns))
        # Not in inclusion -> ignore (should_ignore = True)
        self.assertTrue(should_ignore("src/main.js", spec, include_patterns, exclude_patterns))

    def test_is_text_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            txt_file = Path(tmpdir) / "test.txt"
            with open(txt_file, "w", encoding="utf-8") as f:
                f.write("Hello world! This is text.")
            
            bin_file = Path(tmpdir) / "test.bin"
            with open(bin_file, "wb") as f:
                f.write(b"\x00\x01\x02\x03\x04\xff")
                
            self.assertTrue(is_text_file(txt_file))
            self.assertFalse(is_text_file(bin_file))

    def test_load_config(self):
        # Test loading non-existent file
        config = load_config(Path("does_not_exist.json"))
        self.assertEqual(config, {})

        # Test loading valid json
        with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".json") as f:
            json.dump({"exclude": ["*.log"], "include": ["*.py"]}, f)
            config_path = Path(f.name)
        
        try:
            config = load_config(config_path)
            self.assertEqual(config, {"exclude": ["*.log"], "include": ["*.py"]})
        finally:
            config_path.unlink()

        # Test loading invalid json (should fallback to empty dict)
        with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".json") as f:
            f.write("{invalid_json")
            config_path = Path(f.name)
        
        try:
            config = load_config(config_path)
            self.assertEqual(config, {})
        finally:
            config_path.unlink()

    def test_validate_user_config(self):
        # Valid config
        valid = {"include": ["*.py"], "exclude": ["tests/*"]}
        self.assertTrue(validate_user_config(valid))

        # Invalid config type
        self.assertFalse(validate_user_config([]))

        # Invalid key type
        self.assertFalse(validate_user_config({"include": "not a list"}))
        self.assertFalse(validate_user_config({"exclude": 123}))

        # Invalid items in list
        self.assertFalse(validate_user_config({"include": [123]}))

        # Unknown keys (should be allowed but we can warning/ignore, let's see how our code behaves)
        # Our implementation of validate_user_config checks that if "include" in config, it must be list of strings.
        # Same for "exclude". Any other key is ignored or allowed.
        self.assertTrue(validate_user_config({"unknown_key": "val"}))

    def test_generate_patch_basic(self):
        # Test patch generation for modified file
        context = RepoContext()
        original_file = FileContent(path="main.py", content="line1\nline2\nline3\n")
        new_file = FileContent(path="main.py", content="line1\nline2 modified\nline3\n")
        mod = Modification(files=[original_file, new_file], type="modify")
        
        patch_str = generate_patch(context, [mod])
        self.assertIn("--- main.py", patch_str)
        self.assertIn("+++ main.py", patch_str)
        self.assertIn("-line2", patch_str)
        self.assertIn("+line2 modified", patch_str)

    def test_generate_patch_add_delete(self):
        context = RepoContext()
        # Add file
        new_file = FileContent(path="new.py", content="new line 1\nnew line 2\n")
        mod_add = Modification(files=[None, new_file], type="add")
        
        # Delete file
        old_file = FileContent(path="old.py", content="old line 1\n")
        mod_del = Modification(files=[old_file, None], type="delete")

        patch_str = generate_patch(context, [mod_add, mod_del])
        self.assertIn("--- /dev/null", patch_str)
        self.assertIn("+++ new.py", patch_str)
        self.assertIn("+new line 1", patch_str)
        self.assertIn("--- old.py", patch_str)
        self.assertIn("+++ /dev/null", patch_str)
        self.assertIn("-old line 1", patch_str)

    def test_generate_patch_rename(self):
        context = RepoContext()
        old_file = FileContent(path="old_name.py", content="line1\nline2\n")
        new_file = FileContent(path="new_name.py", content="line1\nline2\n")
        mod = Modification(files=[old_file, new_file], type="rename")

        patch_str = generate_patch(context, [mod])
        self.assertIn("rename from old_name.py", patch_str)
        self.assertIn("rename to new_name.py", patch_str)

    @patch('code_merger.cli.apply_patch')
    def test_apply_patch_file(self, mock_apply_patch):
        # Test applying a patch from file
        with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".patch") as f:
            f.write("some patch content")
            patch_path = Path(f.name)

        try:
            apply_patch_file(patch_path, Path("/dummy/repo"))
            mock_apply_patch.assert_called_once_with("some patch content", Path("/dummy/repo"))
        finally:
            patch_path.unlink()

if __name__ == "__main__":
    unittest.main()
