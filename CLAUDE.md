# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`strutils` is a tiny, single-module Python string utility library. The entire implementation is [strutils.py](strutils.py); there is no package structure, build system, or dependency manifest.

## Commands

Run the test suite (pytest-style, function-based with plain `assert`):

```bash
pytest test_strutils.py
```

Run a single test:

```bash
pytest test_strutils.py::test_truncates_long_text
```

There is no build, lint, or packaging configuration in this repo (no `pyproject.toml`, `setup.py`, or requirements file).

## Architecture

The codebase is intentionally flat: one module ([strutils.py](strutils.py)) exporting individual pure functions, and one matching test file ([test_strutils.py](test_strutils.py)) with one test function per behavior. When adding a new utility function, follow this same pattern — add the function to `strutils.py` and add corresponding `test_*` functions to `test_strutils.py`, and update the function list in [README.md](README.md).
