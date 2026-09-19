/**
 * The tools JARVIS only has when it is running as the Windows app.
 *
 * In a browser tab `window.jarvisDesktop` is absent and none of this is offered
 * to the model, so the same code runs either way — the desktop build simply has
 * a longer tool list. Everything here is a thin call across the preload bridge;
 * the permission check happens on the other side, in the main process, and a
 * refusal comes back as an ordinary tool result so JARVIS can say so out loud
 * rather than failing silently.
 */

/** Is there a machine on the other side of this page? */
export function desktopAvailable(scope = globalThis) {
  return Boolean(scope.jarvisDesktop && scope.jarvisDesktop.version >= 1);
}

export function desktopTools() {
  return [
    {
      name: 'open_installed_app',
      description:
        'Open a program installed on this PC by name, as if the user clicked it in the Start ' +
        'menu — Spotify, Discord, Word, whatever they have. Use this instead of open_app when ' +
        'running on the desktop. The user is asked to approve each program the first time.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The program name, e.g. "Spotify".' } },
        required: ['name'],
      },
    },
    {
      name: 'list_installed_apps',
      description:
        'List the programs installed on this PC. Use this when unsure whether something is ' +
        'installed, or what it is called, before trying to open it.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'open_file',
      description:
        'Open a file or folder with whichever program normally handles it. Give a full path. ' +
        'The user approves each one.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Full path to the file or folder.' } },
        required: ['path'],
      },
    },
    {
      name: 'copy_to_clipboard',
      description:
        'Put text on the clipboard so the user can paste it. This is how you hand them something ' +
        'written — a message, a snippet, an address — for an app you cannot type into.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'read_clipboard',
      description: 'Read what the user has copied, when they refer to it.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'notify',
      description: 'Post a Windows notification. Use for things worth surfacing when JARVIS is hidden.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['body'],
      },
    },
  ];
}

/** Turn a bridge result into the sentence JARVIS reports back. */
export function say(result, onOk) {
  if (!result) return 'The desktop bridge did not answer.';
  if (!result.ok) return result.error || 'That was not allowed.';
  return onOk(result);
}

export function desktopHandlers(scope = globalThis) {
  const bridge = () => scope.jarvisDesktop;
  return {
    async open_installed_app({ name }) {
      return say(await bridge().openApp(name), (r) => `Opened ${r.opened}.`);
    },
    async list_installed_apps() {
      const names = await bridge().listApps();
      if (!names?.length) return 'No installed programs were found.';
      return `${names.length} installed: ${names.slice(0, 60).join(', ')}`;
    },
    async open_file({ path: target }) {
      return say(await bridge().openFile(target), (r) => `Opened ${r.opened}.`);
    },
    async copy_to_clipboard({ text }) {
      return say(await bridge().writeClipboard(text), () => 'Copied. Paste it wherever you need it.');
    },
    async read_clipboard() {
      return say(await bridge().readClipboard(), (r) =>
        r.text ? `Clipboard: ${r.text}` : 'The clipboard is empty.');
    },
    async notify({ title, body }) {
      return say(await bridge().notify(title || 'JARVIS', body), () => 'Notified.');
    },
  };
}
