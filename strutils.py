def truncate(text, length):
    """Shorten text to at most `length` characters, appending '...' if shortened."""
    if len(text) <= length:
        return text
    return text[: length - 3] + "..."
