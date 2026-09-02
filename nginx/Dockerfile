# WarmHawk's bundled nginx — the ONLY container in this package that publishes a host port
# (80/443), per the V12 Containerization Model. Every other service sits on the internal-only
# warmhawk_internal Docker network.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY nginx.conf.template /etc/nginx/templates/warmhawk.conf.template

# envsubst (via nginx's own docker-entrypoint templating, built into the official image since
# 1.19+) renders /etc/nginx/templates/*.template -> /etc/nginx/conf.d/*.conf at container start,
# substituting ${WARMHAWK_DOMAIN} etc. from the environment — no custom entrypoint script needed.

# Bug fix (DooD end-to-end install run, 2026-08-25): the base nginx:1.27-alpine image ships its own
# placeholder /etc/nginx/conf.d/default.conf (`server_name localhost;`, serves a static welcome page
# from /usr/share/nginx/html). Since our template renders to a DIFFERENT filename
# (/etc/nginx/conf.d/warmhawk.conf, chosen above as `warmhawk.conf.template`), the stock file was
# never overwritten and both configs loaded side by side. Any request whose Host header doesn't
# exactly equal ${WARMHAWK_DOMAIN} — a bare-IP hit, a monitoring probe, or simply `curl
# http://localhost/health` — matches the stock block instead (nginx picks the first/most-specific
# server_name match per listen address) and 404s against the static html root instead of ever
# reaching the API. Confirmed live: `curl http://localhost/health` on a fully healthy, correctly
# installed stack returned nginx's stock 404 page, not `{"status":"ok"}`. Removing the stock file
# leaves our block as the only (and therefore default) server for both listen 80 and listen 443,
# so it now answers regardless of what Host header the caller sends.
RUN rm -f /etc/nginx/conf.d/default.conf
