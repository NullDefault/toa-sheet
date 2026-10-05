# Tomb of Annihilation: the sheet pane

Your character sheet beside the chat in Claude Code: HP, AC, spell save DCs, spell
slots, and a turn menu of your weapons and spells. Type `/sheet` to open it.

## You need

- **Claude Code:** the **Code** tab of the Claude desktop app, or `claude` in a
  terminal. It does not work in claude.ai chat, the desktop app's Chat tab or the phone.
- **The rules connector** your DM sent you, already set up.

## Install it (once)

1. Open the Claude desktop app, go to the **Code** tab, and start a session in any
   folder.
2. Copy this whole box, paste it as your message, and send it. Say yes when Claude asks
   to edit the file.

   ```text
   Please install the Tomb of Annihilation sheet pane for me. Merge these two entries
   into my user settings file, ~/.claude/settings.json, without changing anything else
   in it (create the file if it does not exist):

   "extraKnownMarketplaces": { "toa": { "source": { "source": "github", "repo": "NullDefault/toa-sheet" }, "autoUpdate": true } }
   "enabledPlugins": { "toa-sheet@toa": true }

   Then tell me to quit Claude completely and open it again.
   ```

3. Quit Claude completely (Cmd+Q on a Mac, not just closing the window) and open it
   again.

That's it. You never do this again.

## Use it

- **The first time,** ask Claude: `show my sheet`. The pane opens with your sheet.
- **After that,** type `/sheet` in any session, any day. It shows the last sheet Claude
  read on this computer.
- **Jump to a tab:** `/sheet saves`, `/sheet gear`, `/sheet notes`. The tabs are Actions,
  Saves, Features, Gear and Notes.
- When Claude changes your sheet (damage, a long rest, a spent slot), the pane changes
  with it.

## Updates

They arrive by themselves when you open Claude.

## If `/sheet` isn't there

- Quit Claude completely and open it once more. The first start downloads the pane.
- Still nothing? In a terminal, run these two lines, then restart Claude:

  ```bash
  claude plugin marketplace add NullDefault/toa-sheet
  ```

  ```bash
  claude plugin install toa-sheet@toa
  ```

- Still nothing? Send your DM a screenshot.

## What it can do on your computer

Plugins like this one run with your permissions, so here is what this one does. It
draws the pane, adds `/sheet`, and keeps your sheet in Claude Code's own plugin storage
so the pane works in the next session. It reads only the answers from the rules connector
you set up. It never touches your files, starts programs or goes on the internet. Every
line is in [`plugins/toa-sheet/hooks`](plugins/toa-sheet/hooks).

With auto-update on, whatever your DM publishes here reaches you the next time you open
Claude.

**To remove it,** ask Claude to delete those two entries from `~/.claude/settings.json`,
then restart.
