# Deployment

Production runs on **Google Cloud Run** as a source deploy (Cloud Build + Google buildpacks, no Dockerfile).

| Setting | Value |
|---|---|
| URL | https://tesla-navi-466066606601.europe-central2.run.app (also `https://tesla-navi-vhumnab2sa-lm.a.run.app`) |
| GCP project | `botifyshop-453014` (project number `466066606601`, shared with other services) |
| Service / region | `tesla-navi` / `europe-central2` (Warsaw) |
| Image | `europe-central2-docker.pkg.dev/botifyshop-453014/cloud-run-source-deploy/tesla-navi` |
| Runtime | Google buildpacks, Node (base `google-24`), `npm start` → `node server.js`, `PORT=8080` injected by Cloud Run |
| Resources | 1 vCPU, 512 MiB, startup CPU boost |
| Scaling | 0–3 instances, concurrency 80, request timeout 300 s, ingress all, no session affinity |
| Identity | default compute service account |
| Secrets / env | none (Supabase anon key is public and lives in `js/config.js`) |

_Last inspected 2026-10-23: revision `tesla-navi-00078-hm2`, deployed 2026-10-22, serving the code from before PR #1 (asset version `?v=24`; it still serves `/server.js` and `/package.json`). Merging and deploying PR #1 fixes that._

HTTPS matters: phone geolocation and the screen wake lock only work on secure origins, which Cloud Run provides.

## What gets uploaded

`gcloud run deploy --source .` uploads the **working directory** (including uncommitted changes), filtered by `.gcloudignore`. It includes `.gitignore` and additionally excludes docs, scripts, agent config and repo metadata. Runtime needs only `server.js`, `package*.json`, `index.html`, `phone.html`, `css/`, `js/`, `styles/`, `sounds/`, `data/`.

## Deploy

Only deploy when the owner asks. From a clean checkout of `main`:

```bash
git checkout main && git pull
git status --short            # must be empty: uncommitted files would be deployed
npm ci
npm run check && npm run verify

gcloud run deploy tesla-navi \
  --source . \
  --project botifyshop-453014 \
  --region europe-central2
```

Flags not passed keep their current values (scaling, memory, timeout). Cloud Build takes a few minutes; the new revision gets 100 % of traffic when healthy.

## Verify the deploy

```bash
U=https://tesla-navi-466066606601.europe-central2.run.app
curl -s $U/ | grep -o '?v=[0-9]*' | sort -u                 # expected asset version
for p in / /phone /api/speed-cameras; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' $U$p)"; done     # 200
for p in /server.js /package.json /.git/config; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' $U$p)"; done   # 404
curl -s "$U/api/route?startLat=40.1915&startLng=44.5150&destLat=40.1776&destLng=44.5125" | head -c 200   # "source":"yandex"
```

Then open `$U/?code=TEST01` and `$U/phone?code=TEST01` on a phone and confirm pairing.

## Logs and status

```bash
gcloud run services describe tesla-navi --project botifyshop-453014 --region europe-central2
gcloud run revisions list --service tesla-navi --project botifyshop-453014 --region europe-central2 --limit 5
gcloud run services logs read tesla-navi --project botifyshop-453014 --region europe-central2 --limit 100
# errors from the car/phone browsers (js/client-log.js → /api/client-log)
gcloud logging read 'resource.labels.service_name="tesla-navi" AND jsonPayload.message=~"^\[client:"' --project botifyshop-453014 --limit 50
```

## Rollback

```bash
gcloud run revisions list --service tesla-navi --project botifyshop-453014 --region europe-central2 --limit 5
gcloud run services update-traffic tesla-navi --project botifyshop-453014 --region europe-central2 \
  --to-revisions <previous-revision>=100
```

## Known production issues and recommendations

1. **WebSocket rooms are per instance** and Cloud Run has no session affinity configured: with more than one instance the phone and car may not share a `/ws` room (Supabase still works). Cheapest fixes: `gcloud run services update tesla-navi --session-affinity …` or `--max-instances 1`. See [ARCHITECTURE.md §6](ARCHITECTURE.md#scaling-consequences-important).
2. **300 s request timeout closes WebSockets**; clients reconnect automatically. Raise `--timeout` (max 3600) if the local channel should stay up for whole trips.
3. **Shared GCP project.** `botifyshop-453014` also hosts other services; a dedicated project would isolate billing, IAM and quotas.
4. **Manual deploys from a laptop.** Recommended next step: deploy from `main` via a Cloud Build trigger or GitHub Actions (Workload Identity Federation), running `npm run check` before deploying.
5. **Upstream scraping** (Yandex, YouTube) can be rate-limited or blocked from Cloud Run IPs; watch logs for `Yandex route fetch warning` and `source":"osrm"` responses.
