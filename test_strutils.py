from strutils import truncate


def test_no_truncation_needed():
    assert truncate("hello", 10) == "hello"


def test_truncates_long_text():
    assert truncate("hello world", 8) == "hello..."


def test_exact_length_is_not_truncated():
    assert truncate("hello", 5) == "hello"
