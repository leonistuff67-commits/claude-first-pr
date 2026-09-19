# JARVIS for Windows

A real Windows application — an `.exe` you install and launch, with a tray icon
and a global hotkey — rather than a web page in a frame. Same JARVIS: same
voice, same orb, same memory brain, same nine AI providers, same offline mode.
It runs the code from `jarvis/public` directly, so nothing drifts between the
web version and this one.

What it adds is the part a browser tab cannot do: it can open the programs you
actually have installed, open your files, and use your clipboard.

## What it can do, and what it deliberately cannot

| It can | It cannot |
| --- | --- |
| Open an installed program by name | Run a command or a script |
| Open a file or folder with its usual program | Type or click into another window |
| Read and write the clipboard | Read your screen |
| Post a Windows notification | Reach anything not in this list |

The left column is what "open apps and type stuff on them" actually needs in
practice. JARVIS writes the message and puts it on your clipboard; you paste it.
That is one keystroke more than having it type for you, and it is the difference
between an assistant and something that can be talked into doing anything to
your machine by an email it read.

The right column is not missing because it was hard. There is no handler for it
in the main process, so there is no path to it: a model that decides it wants to
run a command has nothing to call.

## Nothing happens until you approve it

Every capability starts closed. The first time JARVIS reaches for one you get a
Windows dialog naming the specific thing — not "allow desktop access?" but
**"Open an installed application: Spotify"** — with **Allow**, **Not this time**,
and a *Remember this choice* box.

Approving Spotify approves Spotify. It does not approve Outlook, and it does not
approve "opening applications" in general. Answering without ticking the box
grants it once and stores nothing.

To take it back: **tray icon → Revoke all permissions**. Permissions live in
`%APPDATA%\JARVIS\permissions.json`, and the file is re-validated on load — an
edited file cannot grant a capability that does not exist.

## Installing

Download **`JARVIS Setup 1.0.0.exe`** from the
[Build Windows app](../../actions/workflows/windows.yml) run and install it. The
portable `.exe` in the same artifact runs without installing if you prefer.

Windows SmartScreen will warn you the first time, because this is not
code-signed — signing needs a certificate that costs money and is tied to a real
identity. **More info → Run anyway.**

## Using it

- **Ctrl + Shift + J** from anywhere brings JARVIS forward, or hides it again.
- Closing the window leaves it running in the tray, still listening.
- Try: *"open Spotify"*, *"what have I got installed?"*, *"draft a message to
  my landlord about the boiler and copy it"*, *"open my downloads folder"*.

Everything from the web version still works, including the API key settings, the
memory brain view and the connectors page.

## Running from source

```powershell
cd jarvis-desktop
npm install
npm start
```

`npm start` copies `jarvis/public` into `renderer/` first, so edits to the web
app show up here immediately.

## Tests

```powershell
npm test
```

Most of these are about the permission gate: that nothing is granted by default,
that approving one app never approves another, that a blanket allow cannot be
recorded for a per-app capability, and that a hand-edited permissions file
cannot invent a capability. One of them asserts the exact list of capabilities,
so adding a new one has to be a deliberate change rather than a slip.

The rest cover app resolution — an unknown name opens nothing, and an ambiguous
one (*"Edge"* when you have Edge Dev and Edge Beta) asks rather than guessing.

## How it is put together

```
src/main.js         the only code with access to the machine
src/preload.cjs     the entire surface the page can see
src/permissions.js  the gate — pure, so it can be tested properly
src/apps.js         name -> installed shortcut, never a path from the model
renderer/           a copy of jarvis/public, made at build time
```

The window runs with `contextIsolation: true` and `nodeIntegration: false`, and
cannot navigate away from the app it was loaded with. Links in the transcript
open in your real browser.
