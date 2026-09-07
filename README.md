# strutils

A tiny string utility library.

## Usage

```python
from strutils import truncate

truncate("hello world", 8)  # "hello..."
```

## Functions

- `truncate(text, length)` — shortens `text` to at most `length` characters, appending `...` when truncation occurs.
