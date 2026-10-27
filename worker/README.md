# PlateO beta sign-up Worker

Receives the form on `beta.html`, checks it, stores it and emails it to Lee.

- `index.js`: the Worker. Handles `POST /signup` and the `OPTIONS` preflight.
- `validate.js`: the checks and the email builder (no Cloudflare imports, so Node can test it).
- `test.mjs`: tests. Run `node worker/test.mjs` from the site folder. Needs Node 22.15 or later, nothing to install.
- `wrangler.toml`: name, bindings and the (commented out) route.

Not deployed yet. Do the steps below once `plateo.fit` is bought and its DNS is on Cloudflare.

## What it does

1. Only accepts `POST /signup` with `Content-Type: application/json` from `https://plateo.fit`, `https://www.plateo.fit` or `https://leeproline.github.io` (CORS allow-list; anything else gets 403).
2. Rate limit: 5 submissions an hour per IP. The IP is never stored: it is hashed (SHA-256) with `IP_SALT` and today's date, and the counter expires after 2 hours.
3. Rejects bodies over 4 KB (413), bad JSON (400) and invalid fields (400, with a code per field). Name up to 80 characters, email up to 254 and a strict format, the two selects only take known values, note up to 500 characters, consent must be `true`. Control characters and line breaks are stripped from the name and rejected in the email, so neither can add an email header.
4. Honeypot (`website`) filled: answers `{ok:true}` but stores and sends nothing, so bots learn nothing.
5. Stores the sign-up in KV as `signup:<epoch ms>:<random>` with a 180 day expiry, then emails Lee. If the email fails, the sign-up is still in KV and the visitor still sees success.
6. Never logs names, emails, notes or IPs.

Responses: `200 {ok:true}`, `400/403/404/405/413/415/429/500/503 {ok:false, error}`.

## Bindings and settings

| Name | Kind | Value |
|---|---|---|
| `SIGNUPS_KV` | KV namespace | the namespace created in step 2 |
| `SEND_EMAIL` | send_email | `destination_address` = Lee's verified address |
| `OWNER_EMAIL` | var | same verified address |
| `FROM_EMAIL` | var | `beta@plateo.fit` |
| `IP_SALT` | secret | a long random string |

## Deploy steps

### 1. Email Routing (Cloudflare dashboard)

1. plateo.fit, then Email, then Email Routing, then Get started / Enable. Let Cloudflare add the MX and SPF (TXT) records it offers.
2. Destination addresses: add `lpraoline@gmail.com`. Open the verification email in Gmail and click the link. It must show as Verified.
3. Routing rules, Custom addresses:
   - `hello@plateo.fit`, action Send to an email, destination `lpraoline@gmail.com`.
   - `beta@plateo.fit`, same destination (so any reply or bounce to the sender lands somewhere).
4. Send a test email to `hello@plateo.fit` from another account and check it arrives.

### 2. KV namespace

Either the dashboard (Storage and Databases, then KV, then Create, name `SIGNUPS_KV`) or:

```sh
cd worker
npx wrangler login
npx wrangler kv namespace create SIGNUPS_KV
```

Copy the id into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`).

### 3. Fill in wrangler.toml

- Replace both `REPLACE_WITH_VERIFIED_DESTINATION_ADDRESS` with `lpraoline@gmail.com` (the address verified in step 1).
- Leave the `routes` block commented until step 6.

### 4. Secret

```sh
npx wrangler secret put IP_SALT
```

Paste a long random string (for example the output of `openssl rand -hex 32`).

### 5. Deploy

```sh
npx wrangler deploy
```

It prints a `https://plateo-beta-signup.<account>.workers.dev` URL.

Dashboard alternative: Workers and Pages, Create, Worker, name `plateo-beta-signup`, then Edit code: add `index.js` and `validate.js` with the contents of these files and deploy. Then Settings, Bindings: add the KV namespace `SIGNUPS_KV`, the Send Email binding `SEND_EMAIL` (destination `lpraoline@gmail.com`), the variables `OWNER_EMAIL` and `FROM_EMAIL`, and the secret `IP_SALT`.

### 6. Route on the domain

1. DNS: add `beta` as an `AAAA` record to `100::`, Proxied (orange cloud). It only exists so the route has a hostname.
2. Uncomment the `routes` block in `wrangler.toml` and run `npx wrangler deploy` again (or in the dashboard: Worker, Settings, Domains and Routes, add route `beta.plateo.fit/signup*` on zone `plateo.fit`).
3. Optional: set `workers_dev = false` and deploy, so only `beta.plateo.fit` answers.

`beta.js` on the site already posts to `https://beta.plateo.fit/signup` (the `SIGNUP_ENDPOINT` constant on its first line).

### 7. Test with curl

Use your own address or a made-up `example.com` one. Replace the URL with the workers.dev one before step 6.

```sh
URL=https://beta.plateo.fit/signup

# Preflight: expect 204 and Access-Control-Allow-Origin: https://plateo.fit
curl -i -X OPTIONS "$URL" -H 'Origin: https://plateo.fit' -H 'Access-Control-Request-Method: POST'

# Good sign-up: expect 200 {"ok":true} and an email in Gmail
curl -i "$URL" -H 'Origin: https://plateo.fit' -H 'Content-Type: application/json' \
  --data '{"name":"Test Person","email":"test@example.com","iphone":"iphone-16","training":"mixed","note":"Test","consent":true,"website":""}'

# Wrong origin: expect 403
curl -i "$URL" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' --data '{}'

# No consent: expect 400 with "consent":"required"
curl -i "$URL" -H 'Origin: https://plateo.fit' -H 'Content-Type: application/json' \
  --data '{"name":"Test Person","email":"test@example.com","consent":false}'

# Too big: expect 413
head -c 5000 /dev/zero | tr '\0' 'x' | curl -i "$URL" -H 'Origin: https://plateo.fit' -H 'Content-Type: application/json' --data-binary @-

# Rate limit: run the good sign-up 6 times in a row; the 6th returns 429
```

Then check the stored sign-ups:

```sh
npx wrangler kv key list --binding SIGNUPS_KV --remote --prefix signup:
```

Delete the test entries (and the test emails in Gmail):

```sh
npx wrangler kv key delete --binding SIGNUPS_KV --remote "signup:<key from the list>"
```

Finally, open `https://plateo.fit/beta.html` in Safari on an iPhone, sign up once, and check the success message and the email.

## Looking after sign-ups

- KV entries delete themselves after 180 days. Delete the matching Gmail emails within 180 days too (the privacy policy says so). A Gmail filter on the subject `PlateO beta sign-up:` with a label makes this easy.
- If someone asks to be removed: find their key with `kv key list --prefix signup:` and `kv key get`, delete it, and delete the email.
- Live logs without personal data: `npx wrangler tail`.
