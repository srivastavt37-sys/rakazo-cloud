FROM ghcr.io/elie222/rakazo/app:edge
USER root
RUN npm install -g opencode-ai && mkdir -p /data && chown -R node:node /data /app
COPY --chown=node:node opencode-gateway.mjs /app/opencode-gateway.mjs
COPY --chown=node:node cloud-entrypoint.mjs /app/cloud-entrypoint.mjs
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    API_HOST=127.0.0.1 \
    API_PORT=3100 \
    RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:6446/v1 \
    RAKAZO_LOCAL_MODELS=crouton-alpha-free,opencode/crouton-alpha-free \
    PI_DEFAULT_PROVIDER=local \
    PI_DEFAULT_MODEL=crouton-alpha-free \
    SIGNUPS_ENABLED=true \
    CONTENT_ENCRYPTION=off
EXPOSE 10000
ENTRYPOINT []
CMD ["node", "/app/cloud-entrypoint.mjs"]
