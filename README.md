English | [中文](README.zh-CN.md)

# pi-goal

A lightweight [Pi](https://pi.dev) extension: clarify a goal with `/goal`, confirm its TODOs, and let the AI carry it out.

## Install

```sh
pi install npm:@gang-of-beads/pi-goal@1.0.1
```

Or install the same release from GitHub: `pi install git:github.com/Gang-of-Beads/pi-goal@v1.0.1`.

Versions up to 0.2.2 were published as `@light4/pi-goal`; 1.0.0 replaces the earlier, unrelated `@gang-of-beads/pi-goal` 0.x (now archived at [Gang-of-Beads/pi-goal-archive](https://github.com/Gang-of-Beads/pi-goal-archive)).

## Quick start

```text
/goal add a health check endpoint and verify it
/goal
/goal status
```

## Documentation

- [Usage](docs/usage.md): clarification, the goal panel, status display, commands and execution boundaries
- [Snippets](docs/snippets.md): goal definitions reusable across projects
- [Sharing](docs/sharing.md): import / export `.goal.sexp` templates
- [Storage](docs/storage.md): states, goal files under the Pi agent directory
- [Development](docs/development.md): local loading, checks and releases

## License

[MIT](LICENSE)
