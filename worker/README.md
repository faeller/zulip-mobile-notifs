# zulip-web-pusher

cloudflare worker for web push notifications. polls zulip every ~15s, sends push when you get DMs or @-mentions.

> **note:** credentials are encrypted but you're trusting whoever runs the worker. for true privacy, use android foreground service or self-host.

### default instance 
we host a default instance at `cf-zulip-web-pusher.faeller.me`

deploy your own:

## deploy

### one-click deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/faeller/zulip-mobile-notifs)

cloudflare will auto-provision the KV namespace and prompt you for secrets.

**before deploying**, generate VAPID keys:

- **online:** [magicbell.com](https://www.magicbell.com/web-push/vapid-keys) or [d3v.one](https://d3v.one/vapid-key-generator/)
- **cli:** `npx web-push generate-vapid-keys`

### manual deploy

```sh
# clone and navigate to worker directory
git clone https://github.com/faeller/zulip-mobile-notifs.git
cd zulip-mobile-notifs/worker

# install dependencies
pnpm install

# copy example config
cp wrangler.toml.example wrangler.toml

# login to cloudflare
pnpm exec wrangler login

# create KV namespace for storing subscriptions
pnpm exec wrangler kv:namespace create SUBSCRIPTIONS
# copy the returned ID into wrangler.toml

# generate VAPID keys for web push authentication
npx web-push generate-vapid-keys

# set secrets (you'll be prompted for values)
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
pnpm exec wrangler secret put VAPID_SUBJECT      # mailto:your@email.com
pnpm exec wrangler secret put ENCRYPTION_SECRET  # random 32+ char string

# deploy
pnpm run deploy
```

## how it works

```
cron (every 1 min)
       │
       ▼
┌──────────────────┐
│  poll all users  │────┐
└──────────────────┘    │  x4 rounds
       │                │
  wait 15 seconds       │
       │                │
       ▼                │
┌──────────────────┐    │
│  poll all users  │◄───┘
└──────────────────┘

result: ~15s polling interval
```

## security

- credentials encrypted with AES-256-GCM at rest
- per-user keys derived from master secret + subscription endpoint
- auto-cleanup after 5 consecutive failures

**trust model:** users trust whoever runs the worker. we could read credentials if we wanted to, by deploying a malicious version. for true privacy, self-host or use android foreground service.

## api

| endpoint | method | description |
|----------|--------|-------------|
| `/status` | GET | health check, returns version |
| `/vapid-public-key` | GET | get VAPID public key for push subscription |
| `/register` | POST | register push subscription with zulip credentials |
| `/update` | POST | update notification filters |
| `/unregister` | POST | remove subscription |
| `/test-push` | POST | send test notification |

## development

```sh
pnpm install
pnpm run dev    # local development server
pnpm run tail   # view production logs
```

## cost

free tier supports ~50-100 users (haven't tested it yet though, so good luck!)

## license

GPL-3.0
