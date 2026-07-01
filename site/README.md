# Polyptic landing site

The public landing page for Polyptic — the "Polyptic Landing v2" design, made
fully self-contained.

It is a single static `index.html` rendered by a small template runtime
(`vendor/support.js`), with **React and ReactDOM vendored locally** under
`vendor/`. Nothing is fetched from a CDN at runtime — in keeping with
Polyptic's no-external-services ethos. (The only external request is the Geist
webfont from Google Fonts; swap it for self-hosted fonts if you want zero
third-party calls.)

## Layout

```
site/
  index.html                       the page (dc template + inline logic)
  vendor/
    support.js                     static template runtime (parses + mounts the page)
    react.production.min.js        React 18.3.1 UMD
    react-dom.production.min.js    ReactDOM 18.3.1 UMD
  nginx.conf                       static server config (listens on :8081)
  Dockerfile                       nginx:alpine image serving the above
```

## Run locally

Any static file server works, e.g.:

```sh
cd site
python3 -m http.server 8081
# open http://localhost:8081
```

## Run with Docker

```sh
cd site
docker build -t polyptic-site .
docker run --rm -p 8081:8081 polyptic-site
# open http://localhost:8081
```

## Placeholders to replace

These stand-ins are intentional until the real assets exist:

- **GitHub URL** — every link points at `https://github.com/polyptic/polyptic`.
  Replace once the repo is public.
- **Social proof** — star/fork counts (`2.4k`, `2,431`, `188`) and the version
  badge (`v2.3`) are illustrative.
- **`docker compose up`** quickstart — assumes a compose file ships at the repo
  root.

Search `index.html` for `polyptic/polyptic` to find the link occurrences.
