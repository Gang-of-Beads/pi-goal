English | [中文](README.zh-CN.md)

# pi-goal

A lightweight [Pi](https://pi.dev) extension: clarify a goal with `/goal`, confirm its TODOs, and let the AI carry it out.

## Install

```sh
pi install npm:@light4/pi-goal@0.1.3
```

Or install the same release from GitHub: `pi install git:github.com/light4/pi-goal@v0.1.3`.

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
