# WarmHawk's bundled nginx — the ONLY container in this package that publishes a host port
# (80/443), per the V12 Containerization Model. Every other service sits on the internal-only
# warmhawk_internal Docker network.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

COPY nginx.conf.template /etc/nginx/templates/warmhawk.conf.template

# envsubst (via nginx's own docker-entrypoint templating, built into the official image since
# 1.19+) renders /etc/nginx/templates/*.template -> /etc/nginx/conf.d/*.conf at container start,
# substituting ${WARMHAWK_DOMAIN} etc. from the environment — no custom entrypoint script needed.
