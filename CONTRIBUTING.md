# Contributing

## Setup

You need [Bun](https://bun.sh) and Node.js 22.19.0 or later.

```sh
bun install
```

## Check and test

```sh
bun run check
bun run test
```

`check` runs the TypeScript compiler without output.
`test` runs the tests in `test/` with the Node.js test runner.

## Try a local copy in pi

From the root of this repository, run pi with the local source:

```sh
pi -e ./src/index.ts
```

To load the local copy in every session, install it as a local package:

```sh
pi install ./
```
