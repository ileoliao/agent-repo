# Harbor Extensions platform image: gateway + portal + SDK.
#
#   docker build -t harbor-extensions .
#
# Code assets live in /app (HARBOR_APP_DIR). Governed content is baked into /content for local runs;
# on GKE a read-only Cloud Storage FUSE volume mounts there. See deploy/README.md.

# ---- portal build ----
FROM node:22-slim AS portal
WORKDIR /src/portal
COPY portal/package.json portal/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portal/ ./
RUN npm run build

# ---- runtime ----
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HARBOR_APP_DIR=/app \
    HARBOR_ROOT=/content \
    HARBOR_CONFIG=/etc/harbor-extensions/platform.yaml \
    HARBOR_AUDIT_SINK=stdout \
    HARBOR_DEV_LOGIN=false \
    HARBOR_COOKIE_SECURE=true

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/harbor_platform ./harbor_platform
COPY sdk /app/sdk
COPY --from=portal /src/portal/dist /app/portal/dist

# Fallback content; secrets.dev.yaml is deliberately not copied
COPY connectors /content/connectors
COPY extensions /content/extensions
COPY config/grants.yaml config/nav.yaml /content/config/

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin harbor
USER 10001
EXPOSE 8000

# Trust forwarded headers only from loopback by default; configure FORWARDED_ALLOW_IPS for the actual ingress proxies.
CMD ["python", "-m", "uvicorn", "harbor_platform.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--no-server-header"]
