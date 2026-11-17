# VideoConf server image: Python service + web client + on-device effects assets.
# Build from the repository root:  docker build -t videoconf .

# Stage 1: fetch the browser-side effects library (no Node at runtime).
FROM node:22.11.0-slim AS assets
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Stage 2: runtime.
FROM python:3.13.1-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install -r server/requirements.txt
COPY server/videoconf server/videoconf
COPY public public
COPY models models
COPY --from=assets /src/node_modules/@mediapipe/tasks-vision node_modules/@mediapipe/tasks-vision
RUN useradd --system --uid 10001 --no-create-home videoconf
USER videoconf
WORKDIR /app/server
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8443/healthz', timeout=3)"
CMD ["python", "-m", "videoconf"]
