# local-router

`local-router` exposes dev servers behind stable hostnames, including real domains overridden locally with both HTTP and HTTPS.

It is inspired by [portless](https://github.com/vercel-labs/portless), but changes the default behavior to support:

- `https://<name>.localhost`
- `https://app.example.com`
- `https://api.example.com`
- the same hosts over plain HTTP

## Install

```bash
npm i -g @elisoncampos/local-router
```

Or run it without installing globally:

```bash
npx @elisoncampos/local-router run next dev
```

## Usage

Inside a project directory:

```bash
local-router run next dev
```

This infers the project name and exposes:

```text
http://myapp.localhost
https://myapp.localhost
```

Add a real domain override:

```bash
local-router run next dev --domain app.example.com
```

This adds:

```text
http://app.example.com
https://app.example.com
```

You can repeat `--domain` as many times as needed.

## `.local-router`

Create a `.local-router` file in the project root using JSON5 syntax:

```js
{
  name: "algo",
  hosts: [
    "app.example.com",
    "api.example.com"
  ]
}
```

Then:

```bash
local-router run next dev
```

Exposes:

```text
http://algo.localhost
https://algo.localhost
http://app.example.com
https://app.example.com
http://api.example.com
https://api.example.com
```

## How it works

- A shared proxy daemon listens on ports `80` and `443` by default.
- Your app runs on an ephemeral port like `4624`.
- `local-router` registers every hostname for that app.
- The proxy forwards requests by `Host`.
- For custom domains, `local-router` manages a block in `/etc/hosts`.
- For HTTPS, `local-router` generates a local CA and per-host certificates.

## Important note about sudo

Ports `80` and `443` require elevated privileges on macOS/Linux.

The CLI will prompt to start the proxy with `sudo` when required.

If you only want to test the project on high ports:

```bash
LOCAL_ROUTER_HTTP_PORT=18080 LOCAL_ROUTER_HTTPS_PORT=18443 local-router run next dev
```

## Commands

```bash
local-router run <command...>
local-router proxy start
local-router proxy stop
local-router trust
local-router hosts sync
local-router hosts clean
```
