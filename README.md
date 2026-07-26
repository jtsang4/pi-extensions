# Opinionated Pi Extensions

`@jtsang/pi-extensions` is my opinionated collection of extensions for
[Pi](https://github.com/earendil-works/pi). It reflects how I want Pi to work:
focused defaults, small extensions, and no attempt to be a neutral framework
for every workflow.

The extensions share one npm package and release lifecycle. Consumers can use
`pi config` to enable only the extensions they want.

## Extensions

No extensions are included yet. Each published extension will be documented
here with its behavior and configuration.

## Installation

Install the npm package:

```sh
pi install npm:@jtsang/pi-extensions
```

Or install directly from GitHub:

```sh
pi install git:github.com/jtsang4/pi-extensions
```

Pi packages run with full system access. Review extension source before
installing or enabling it.

## Development

Requirements:

- Node.js 22.19 or newer
- pnpm (the version is pinned in `package.json`)
- Pi

```sh
corepack enable
pnpm install
pi -e .
pnpm check
```

Pi loads TypeScript directly through jiti, so this package intentionally has no
build step. Run `pnpm exec tsc --noEmit` after adding TypeScript sources.

Small extensions belong in `extensions/<name>.ts`. Multi-file extensions use
`extensions/<name>/index.ts`. Keep shared code in `lib/` only after real reuse
appears.

Before publishing:

```sh
pnpm exec tsc --noEmit
pnpm check
pnpm publish
```

## License

[MIT](LICENSE)
