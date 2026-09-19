# JARVIS for the desktop

JARVIS's brain — its memory, its task list, its persona — packaged as an [MCP]
server so it can run inside a host that already has control of your computer,
instead of trying to grow control of its own.

Claude Desktop is the intended host. Point it at this server and JARVIS knows
you there: it remembers what you tell it, keeps your task list, and behaves like
JARVIS rather than a blank assistant. Whatever else you have given that host —
file access, app control, browser control — JARVIS can then use, under the
host's own permission prompts.

[MCP]: https://modelcontextprotocol.io

## What this does and does not do

It stores facts and tasks in one JSON file, and it tells the host who JARVIS is.
That is all it does. It has no shell, no file access beyond its own brain file,
and no way to move your mouse or type into other windows.

That is deliberate. Computer control belongs in tools built for it, where the
approval prompts, the sandboxing and the audit trail were designed in from the
start — not bolted onto a voice assistant that also reads your email. Running
JARVIS's brain *inside* such a host gets you the assistant you wanted without a
second, weaker copy of the dangerous part.

## Setup on Windows

You need [Node.js](https://nodejs.org) 18 or newer and Claude Desktop.

**1. Install it.** Clone this repository somewhere permanent, then:

```powershell
cd path\to\claude-first-pr\jarvis-mcp
npm install
```

**2. Tell Claude Desktop about it.** Open Claude Desktop, go to
**File → Settings → Developer → Edit Config**. That opens
`%APPDATA%\Claude\claude_desktop_config.json`. Add JARVIS to `mcpServers`:

```json
{
  "mcpServers": {
    "jarvis": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-first-pr\\jarvis-mcp\\server.js"]
    }
  }
}
```

Use the real path, and keep the doubled backslashes — JSON needs them.

**3. Restart Claude Desktop.** Fully quit it, including the tray icon; closing
the window is not enough. When it comes back you should see JARVIS's tools in
the tools menu.

**4. Make it JARVIS.** In the chat, attach the `jarvis` prompt (the
**+** button → the JARVIS server → `jarvis`). That hands over the persona along
with everything it currently remembers about you. To make it permanent, create a
Claude Desktop Project and paste `src/persona.js`'s text into the project
instructions.

On macOS the config lives at
`~/Library/Application Support/Claude/claude_desktop_config.json`; everything
else is the same.

## Bringing your memory over from the web app

The browser JARVIS at
<https://leonistuff67-commits.github.io/claude-first-pr/> keeps its brain in that
browser. To move it here, open its settings, click **Export brain**, then:

```powershell
npm run import -- C:\Users\you\Downloads\jarvis-brain.json
```

Facts and tasks are matched on their text, so running that again after teaching
the web version something new adds only what is new. The export contains facts
and tasks only — not your API keys, not your conversation history.

## Giving it control of your computer

That comes from the host, not from here. In Claude Desktop, add the servers you
actually want alongside JARVIS in the same `mcpServers` block — the official
[reference servers](https://github.com/modelcontextprotocol/servers) cover files,
git, databases and more, and Claude Desktop's own extensions cover the rest.
Each one you add is a separate, deliberate decision, and the host asks before it
acts.

Two things worth keeping in mind once JARVIS can touch your machine:

- **Give it the narrowest thing that works.** A filesystem server scoped to one
  project folder is a different proposition from one scoped to your whole drive.
- **What it reads is not what you asked.** Email, web pages and documents are
  data, not instructions. The persona says so explicitly, but the real
  protection is that you stay the one approving actions.

## The tools it adds

| Tool | What it does |
| --- | --- |
| `remember` | Store a durable fact about you. Called on JARVIS's own initiative. |
| `recall` | Search what it knows. Empty query returns recent facts. |
| `forget` | Drop a fact, by id or by its wording. |
| `add_task` | Add to the task list. |
| `complete_task` | Tick one off, by id or by what it says. |
| `list_tasks` | Open tasks, or all of them. |
| `brain_stats` | How much it remembers, and where the file is. |

It also exposes the brain as two readable resources (`jarvis://brain/facts` and
`jarvis://brain/tasks`) and the persona as the `jarvis` prompt.

## Where the brain lives

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\jarvis\brain.json` |
| macOS | `~/Library/Application Support/jarvis/brain.json` |
| Linux | `~/.local/share/jarvis/brain.json` |

Set `JARVIS_BRAIN` to put it somewhere else. It is a plain JSON file: back it
up, sync it, or read it yourself.

## Tests

```bash
npm test
```

Unit tests cover the brain and the file store; the last one spawns the real
server and talks MCP to it over stdio, the same way Claude Desktop does.
