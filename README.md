# HUD

A heads-up display for Claude Code: what you need to know at a glance, in one quiet line above the prompt. It starts with your plan's limits and your context window, so you never open a menu to check how much is left.

```
[ 31 ] 17:10   [ 78 ] Tue 07:00   ( 54 ) Context ⇊        ○ Auto compact   ▼
```

- **5 hour and weekly limits** as battery gauges, colored by how close you are, each followed by its reset time (24h).
- **Context window** as a capsule gauge, with **⇊** to compact the chat in one click.
- **Auto compact**, per chat: switch it on and set a %, and it compacts between turns once the context reaches it.
- **▼ opens the details**, one line each:

```
5 Hour   ██░░░│░░░░░░   ~6%/h       3h 24m left
Weekly   █████░░│░░░░   ~11%/day    3d 7h left
Context  ███▒░░░░│░░░   Messages 96k  Tools 51k  Other 11k   809k free   auto 40%
```

  How fast each limit is going (averaged since its window began), the time left, where it's heading at reset (the `│` mark), what fills the context, and a warning at the bottom when a limit will run out before it resets.

In a narrow chat the line keeps the gauges and the controls and drops the words. `/quota` turns the band off and on.

## Makes no network requests

Every figure comes from what Claude Code already holds on your machine: the 5 hour and weekly usage that each reply from Claude carries, and Claude Code's own local estimate of the context. The band sends nothing anywhere and reads no login token.

What that means in practice:

- A brand-new chat shows the last figures any of your chats saw until Claude replies once.
- Usage from elsewhere (claude.ai, another machine) shows after your next reply here.
- When the figures are more than 10 minutes old, the details say so.

The only request it can cause is the one you ask for: **⇊** and Auto compact run `/compact`, a normal Claude request that uses your plan like any reply.

## Install

Inside `claude` in a terminal:

```text
/plugin install hud --marketplace truongnv98/hud
```

Answer `y` to add the marketplace, then pick a scope.

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `truongnv98/hud`, then **Add plugin**.

Needs Claude Code with mods (2.1.287 or later), signed in with a Pro or Max plan: the limits come with replies on those plans.

## Credits

Built on [anantraghunath/claude-code-usage-quota-mod](https://github.com/anantraghunath/claude-code-usage-quota-mod) (MIT) by Anant Raghunath, which made the band, the forecast and Auto compact. This version removes its network requests (the usage service call and the exact context count) and redraws the band. Don't install both: they draw the same band.

## License

MIT, see [LICENSE](LICENSE). Original copyright (c) 2026 Anant Raghunath.
