# Harbor Extensions platform image: gateway + portal + SDK.
#
#   docker build -t harbor-extensions .
#
# Code assets live in /app (HARBOR_APP_DIR). The governed content (connectors, extensions, grants) is baked into
# /content as a fallback, but on GKE a git-sync sidecar provides it and HARBOR_ROOT points there, so merging a PR
# takes effect without rebuilding or rolling out the image. See deploy/README.md.

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

# --proxy-headers: trust X-Forwarded-* from the ingress / load balancer in front of the pod
CMD ["python", "-m", "uvicorn", "harbor_platform.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
