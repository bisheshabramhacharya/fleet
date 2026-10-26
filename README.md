# Fleetmeter

One dashboard for every AI token and dollar across all your machines.

Fleetmeter runs a small collector on each of your computers (Windows, macOS, Linux). It reads the logs your AI tools already save, such as Claude Code, Codex, Droid, Pi, Command Code, OpenCode, DeepSeek Harness, Hermes and Cursor, and sends only the numbers to one hub on your private Tailscale network. The hub adds your provider billing, subscriptions and plan limits, and shows it all in one place.

**Status:** planning. The v1 spec is [issue #1](../../issues/1).

## Planned features

- One total across every device and tool, with Cost, Tokens and Limits views.
- Filters by device, tool, model and project.
- Droid, Command Code, DeepSeek Harness and Hermes support, plus everything T3 Code already reads.
- "What I paid" next to "API value", so you can see which subscriptions pay off.
- Provider billing and balances (DeepSeek, OpenAI, Anthropic, Factory, OpenRouter).
- Private by design: no chat text leaves a device, no telemetry, the hub is reachable only over Tailscale.

## Credits

Fleetmeter's usage engine and dashboard design will be adapted from [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., used under the MIT license. Ported code keeps T3 Code's copyright notice.

## License

[MIT](LICENSE)
