# Tiger Foundation cloud workspace

Use **Codex cloud** with the existing repository:
https://github.com/fung93/tiger-foundation-dashboard

The public website stays on Vercel. GitHub Actions keeps its six-hour data schedule.
The cloud workspace is for requesting, reviewing and testing changes from another device.

## Create the workspace

1. In ChatGPT, open **Settings → Codex Cloud → Environments → Create environment**.
2. Choose **fung93/tiger-foundation-dashboard** and name the environment **Tiger Foundation**.
3. Keep access private to your account. This project needs no API keys or secrets.
4. Give the setup conversation the instructions below. Review its checks, then publish
   the environment. Publishing an environment is separate from publishing the website.
5. Use that environment for future cloud coding chats. The environment is ready only
   when ChatGPT confirms it has been published.

Official setup guidance: https://learn.chatgpt.com/docs/environments/cloud-environments

## Instructions for the setup conversation

> Prepare this existing dashboard for cloud coding. Read AGENTS.md completely and follow
> Alex's standing rules. Use the actual cloud checkout path, not the Windows path recorded
> in the handover. Use Node 20 or newer. There are no npm dependencies to install.
>
> Run `npm run check`. For a private browser preview, run `npm run dev`; if the environment
> needs a server bound beyond loopback, set HOST to 0.0.0.0 and forward port 4200 privately.
> The portable preview includes the existing Node API routes and a development-only
> service worker. Do not run serve.ps1 in Linux.
>
> Check Portfolio, LP Book and Lending. Enable the public RPC/API destinations needed for
> live data under the environment's network policy. Missing internet access must be
> reported as an incomplete live check, not worked around with made-up values.
>
> Do not run update-data.mjs, LP ledger rebuilds or archive backfills during setup. They
> change financial history or make large network scans. Do not add secrets, wallet
> connections, signatures or transactions. Keep both Portfolio HTML files byte-identical.
> Never commit, push, merge or deploy without Alex's explicit permission to push.

These instructions require the portable preview/check files from this cloud-preparation
change to be present in the selected repository branch or supplied to the setup session.

## Commands for a coding agent

```sh
npm run dev
npm run check
npm test
```

`npm run dev` defaults to http://127.0.0.1:4200. HOST and PORT can be set by the cloud
environment. API requests remain read-only and use the same handlers as Vercel.
Keep forwarded preview access private; this server is a development tool.
Restart it after editing an API module or its shared imports; Node caches those modules.
Static page and asset edits are read on each request.

The preview disables the production service-worker cache without changing sw.js.
Merkl may still reject a plain HTTP browser origin; use the cloud's private HTTPS
preview for full live browser checks, and report any remaining source restrictions.

Cloud changes remain drafts until Alex says **push**. A push to main triggers Vercel.
Keep the local clone as a backup; nothing needs to be deleted to work in the cloud.
