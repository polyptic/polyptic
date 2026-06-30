# Polyptic landing site — static, self-contained (no build step, no external CDN).
# The React + dc-runtime are vendored under ./vendor, so the image serves
# everything itself, matching Polyptic's no-external-services ethos.
FROM nginx:1.27-alpine

# Run as the unprivileged nginx user on a high port (no root needed).
RUN sed -i 's/^user .*/# user removed: running unprivileged/' /etc/nginx/nginx.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/index.html
COPY vendor/ /usr/share/nginx/html/vendor/

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8081/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
